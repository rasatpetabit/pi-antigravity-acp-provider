import {
	ClientSideConnection,
	PROTOCOL_VERSION,
	RequestError,
	type AuthenticateRequest,
	type InitializeResponse,
	type LoadSessionResponse,
	type McpServer,
	type NewSessionResponse,
	type ResumeSessionResponse,
	type PromptRequest,
	type PromptResponse,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";

import { PACKAGE_VERSION } from "../constants.js";
import { boundedNdjsonStream } from "./bounded-stream.js";
import { abortError, AntigravityAcpError, redact } from "./errors.js";
import { AntigravityProcess, type AntigravityProcessOptions } from "./process.js";

const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
/**
 * A session/prompt spans the whole Antigravity agent turn, including native tools and bridged Pi
 * tool calls that run for many minutes. It is therefore bounded by progress, not wall-clock time:
 * it fails only after this long with no inbound activity while nothing is outstanding.
 */
const DEFAULT_PROMPT_IDLE_TIMEOUT_MS = 10 * 60_000;

export interface AntigravityConnectionHandlers {
	onUpdate?: (notification: SessionNotification) => void | Promise<void>;
	onPermission?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
}

export interface AntigravityConnectionOptions extends AntigravityProcessOptions {
	handlers?: AntigravityConnectionHandlers;
	initializeTimeoutMs?: number;
	operationTimeoutMs?: number;
	/** No-progress limit for one session/prompt; see DEFAULT_PROMPT_IDLE_TIMEOUT_MS. */
	promptIdleTimeoutMs?: number;
	maxFrameBytes?: number;
}

/**
 * Liveness state of one in-flight session/prompt. Any inbound activity for its session restarts
 * the idle timer; the timer cannot fire while work is outstanding outside the model stream: a
 * pending permission request, a tool call Antigravity reported that has not reached a terminal
 * status, or an explicit hold (a bridged Pi tool call parked while Pi executes it). The state
 * lives only as long as the prompt, so nothing carries over on a warm binding.
 */
class PromptWatchdog {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private holds = 0;
	private permissions = 0;
	private readonly openToolCalls = new Set<string>();
	private disposed = false;

	constructor(
		private readonly idleMs: number,
		private readonly onStall: () => void,
	) {}

	get suspended(): boolean {
		return this.holds > 0 || this.permissions > 0 || this.openToolCalls.size > 0;
	}

	/** Restart the no-progress window, or stop it while work is outstanding. */
	arm(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.disposed || this.suspended) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.disposed || this.suspended) return;
			this.onStall();
		}, this.idleMs);
		this.timer.unref?.();
	}

	noteUpdate(notification: SessionNotification): void {
		const update = notification.update;
		if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
			const terminal = update.status === "completed" || update.status === "failed";
			if (terminal) this.openToolCalls.delete(update.toolCallId);
			else if (update.sessionUpdate === "tool_call") this.openToolCalls.add(update.toolCallId);
		}
		this.arm();
	}

	beginPermission(): () => void {
		this.permissions += 1;
		this.arm();
		return this.releaser(() => {
			this.permissions = Math.max(0, this.permissions - 1);
		});
	}

	hold(): () => void {
		this.holds += 1;
		this.arm();
		return this.releaser(() => {
			this.holds = Math.max(0, this.holds - 1);
		});
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.holds = 0;
		this.permissions = 0;
		this.openToolCalls.clear();
	}

	/** An idempotent release: a second call, or a call after the prompt settled, does nothing. */
	private releaser(decrement: () => void): () => void {
		let released = false;
		return () => {
			if (released || this.disposed) return;
			released = true;
			decrement();
			this.arm();
		};
	}
}

export class AntigravityAcpConnection {
	readonly process: AntigravityProcess;
	readonly initialized: Promise<InitializeResponse>;
	private readonly connection: ClientSideConnection;
	private readonly operationTimeoutMs: number;
	private readonly promptIdleTimeoutMs: number;
	/** The watchdog of the in-flight session/prompt, by ACP session id. */
	private readonly promptWatchdogs = new Map<string, PromptWatchdog>();
	private readonly protocolFailure: Promise<never>;
	private readonly processFailure: Promise<never>;
	private handlers: AntigravityConnectionHandlers;
	private closePromise?: Promise<void>;

	constructor(options: AntigravityConnectionOptions) {
		this.handlers = options.handlers ?? {};
		this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
		this.promptIdleTimeoutMs = options.promptIdleTimeoutMs ?? DEFAULT_PROMPT_IDLE_TIMEOUT_MS;
		this.process = new AntigravityProcess(options);
		let rejectProtocolFailure!: (error: Error) => void;
		this.protocolFailure = new Promise<never>((_resolve, reject) => {
			rejectProtocolFailure = reject;
		});
		// Keep the rejection observed even if output fails while no request is
		// active. Individual operations still race against the original promise.
		void this.protocolFailure.catch(() => undefined);
		this.processFailure = this.process.exited.then(({ code, signal, stderrTail }) => {
			const status = signal ? `signal ${signal}` : `code ${String(code)}`;
			const detail = stderrTail.trim() ? `: ${stderrTail.trim()}` : "";
			throw new AntigravityAcpError(
				"process_exit",
				`Antigravity ACP process exited with ${status}${detail}`,
			);
		});
		// Process exit is expected during close; observe it here while active
		// operations race against the original rejecting promise below.
		void this.processFailure.catch(() => undefined);
		const stream = boundedNdjsonStream(this.process.output, this.process.input, {
			...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
			onCompatibilityNoise: () => this.process.recordCompatibilityNoise(),
			onProtocolError: (error) => {
				rejectProtocolFailure(error);
				void this.process.close();
			},
			closeOnProtocolError: true,
		});
		this.connection = new ClientSideConnection(
			() => ({
				requestPermission: async (request) => {
					const release = this.promptWatchdogs.get(request.sessionId)?.beginPermission();
					try {
						return (await this.handlers.onPermission?.(request)) ?? { outcome: { outcome: "cancelled" } };
					} finally {
						release?.();
					}
				},
				sessionUpdate: async (notification) => {
					this.promptWatchdogs.get(notification.sessionId)?.noteUpdate(notification);
					await this.handlers.onUpdate?.(notification);
				},
			}),
			stream,
		);
		this.initialized = this.withDeadline(
			this.connection.initialize({
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: {
					fs: { readTextFile: false, writeTextFile: false },
					terminal: false,
				},
				clientInfo: {
					name: "pi-antigravity-acp-provider",
					title: "Pi Antigravity ACP Provider",
					version: PACKAGE_VERSION,
				},
			}),
			options.initializeTimeoutMs ?? 30_000,
			"initialize",
		);
		// Initialization can outlive a cancelled catalog refresh.
		void this.initialized.catch(() => undefined);
	}

	setHandlers(handlers: AntigravityConnectionHandlers): void {
		this.handlers = handlers;
	}

	async initialize(signal?: AbortSignal): Promise<InitializeResponse> {
		const response = await this.withAbort(this.initialized, signal);
		if (response.protocolVersion !== PROTOCOL_VERSION) {
			await this.close();
			throw new AntigravityAcpError(
				"protocol",
				`Unsupported ACP protocol version ${String(response.protocolVersion)}`,
			);
		}
		return response;
	}

	async authenticate(
		request: AuthenticateRequest,
		signal?: AbortSignal,
		timeoutMs = 180_000,
	): Promise<void> {
		await this.initialize();
		await this.withAbort(
			this.withDeadline(this.connection.authenticate(request), timeoutMs, "authenticate"),
			signal,
		);
	}

	async newSession(
		cwd: string,
		signal?: AbortSignal,
		mcpServers: McpServer[] = [],
	): Promise<NewSessionResponse> {
		await this.initialize();
		return this.withAbort(
			this.withDeadline(
				this.connection.newSession({ cwd, mcpServers }),
				this.operationTimeoutMs,
				"session/new",
			),
			signal,
		);
	}

	async loadSession(
		sessionId: string,
		cwd: string,
		mcpServers: McpServer[] = [],
		signal?: AbortSignal,
	): Promise<LoadSessionResponse> {
		await this.initialize();
		return this.withAbort(
			this.withDeadline(
				this.connection.loadSession({ sessionId, cwd, mcpServers }),
				this.operationTimeoutMs,
				"session/load",
			),
			signal,
		);
	}

	async resumeSession(
		sessionId: string,
		cwd: string,
		mcpServers: McpServer[] = [],
		signal?: AbortSignal,
	): Promise<ResumeSessionResponse> {
		await this.initialize();
		return this.withAbort(
			this.withDeadline(
				this.connection.unstable_resumeSession({ sessionId, cwd, mcpServers }),
				this.operationTimeoutMs,
				"session/resume",
			),
			signal,
		);
	}

	async setModel(sessionId: string, modelId: string, signal?: AbortSignal): Promise<void> {
		await this.withAbort(
			this.withDeadline(
				this.connection.unstable_setSessionModel({ sessionId, modelId }),
				this.operationTimeoutMs,
				"session/set_model",
			),
			signal,
		);
	}

	async setMode(sessionId: string, modeId: string, signal?: AbortSignal): Promise<void> {
		await this.withAbort(
			this.withDeadline(
				this.connection.setSessionMode({ sessionId, modeId }),
				this.operationTimeoutMs,
				"session/set_mode",
			),
			signal,
		);
	}

	/**
	 * Suspend the in-flight prompt's no-progress watchdog for this session until the returned
	 * release is called (idempotent). Used while a bridged Pi tool call is parked waiting for Pi.
	 * Without an in-flight prompt this is a no-op; a release after the prompt settled does nothing.
	 */
	holdPromptWatchdog(sessionId: string): () => void {
		return this.promptWatchdogs.get(sessionId)?.hold() ?? (() => undefined);
	}

	async prompt(request: PromptRequest, signal?: AbortSignal): Promise<PromptResponse> {
		if (signal?.aborted) throw abortError();
		const pending = this.withProgressWatchdog(request);
		if (!signal) return pending;

		return new Promise<PromptResponse>((resolve, reject) => {
			let settled = false;
			let aborting = false;
			let cancelTimer: ReturnType<typeof setTimeout> | undefined;
			const finish = (callback: () => void) => {
				if (settled) return;
				settled = true;
				if (cancelTimer) clearTimeout(cancelTimer);
				signal.removeEventListener("abort", onAbort);
				callback();
			};
			const onAbort = () => {
				if (aborting) return;
				aborting = true;
				void this.cancel(request.sessionId).catch(() => undefined);
				cancelTimer = setTimeout(() => {
					void this.close().finally(() => finish(() => reject(abortError())));
				}, 1_500);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			pending.then(
				(value) => {
					if (aborting) finish(() => reject(abortError()));
					else finish(() => resolve(value));
				},
				(error: unknown) => finish(() => reject(aborting ? abortError() : error)),
			);
		});
	}

	async cancel(sessionId: string): Promise<void> {
		await this.connection.cancel({ sessionId });
	}

	async close(): Promise<void> {
		this.closePromise ??= this.process.close();
		await this.closePromise;
	}

	private async withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
		// The operation has already started. Observe it before any cancellation
		// branch closes the transport, even when we will not await its result.
		void promise.catch(() => undefined);
		if (!signal) return promise;
		if (signal.aborted) {
			await this.close();
			throw abortError();
		}
		return new Promise<T>((resolve, reject) => {
			const abort = () => {
				void this.close();
				reject(abortError());
			};
			signal.addEventListener("abort", abort, { once: true });
			promise.then(
				(value) => {
					signal.removeEventListener("abort", abort);
					resolve(value);
				},
				(error: unknown) => {
					signal.removeEventListener("abort", abort);
					reject(classifyError(error));
				},
			);
		});
	}

	/** Run one session/prompt under a no-progress watchdog instead of a wall-clock deadline. */
	private async withProgressWatchdog(request: PromptRequest): Promise<PromptResponse> {
		const idleMs = this.promptIdleTimeoutMs;
		let rejectStall!: (error: Error) => void;
		const stalled = new Promise<never>((_resolve, reject) => {
			rejectStall = reject;
		});
		const watchdog = new PromptWatchdog(idleMs, () => {
			void this.close();
			rejectStall(
				new AntigravityAcpError(
					"timeout",
					`Antigravity ACP session/prompt timed out: no progress for ${idleMs}ms`,
				),
			);
		});
		// Register before sending so the earliest update for this prompt is observed.
		this.promptWatchdogs.set(request.sessionId, watchdog);
		watchdog.arm();
		try {
			return await Promise.race([
				this.connection.prompt(request).catch((error: unknown) => {
					throw classifyError(error);
				}),
				this.protocolFailure,
				this.processFailure,
				stalled,
			]);
		} finally {
			watchdog.dispose();
			if (this.promptWatchdogs.get(request.sessionId) === watchdog) {
				this.promptWatchdogs.delete(request.sessionId);
			}
		}
	}

	private async withDeadline<T>(promise: Promise<T>, timeoutMs: number, phase: string): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise.catch((error: unknown) => {
					throw classifyError(error);
				}),
				this.protocolFailure,
				this.processFailure,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						void this.close();
						reject(new AntigravityAcpError("timeout", `Antigravity ACP ${phase} timed out after ${timeoutMs}ms`));
					}, timeoutMs);
					timer.unref?.();
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}

function classifyError(error: unknown): Error {
	if (error instanceof AntigravityAcpError) return error;
	const structured =
		error instanceof RequestError
			? error
			: error &&
				  typeof error === "object" &&
				  typeof (error as { code?: unknown }).code === "number" &&
				  typeof (error as { message?: unknown }).message === "string"
				? (error as { code: number; message: string; data?: unknown })
				: undefined;
	if (structured) {
		const detail = structuredErrorDetail(structured.data);
		const message = detail ? `${structured.message}: ${detail}` : structured.message;
		if (structured.code === -32000) {
			return new AntigravityAcpError("auth", `Antigravity authentication required: ${message}`, {
				cause: error,
			});
		}
		return new AntigravityAcpError("protocol", `Antigravity ACP error ${structured.code}: ${message}`, {
			cause: error,
		});
	}
	return error instanceof Error ? error : new Error(String(error));
}

function structuredErrorDetail(data: unknown): string | undefined {
	if (!data || typeof data !== "object") return undefined;
	const detail = (data as { details?: unknown }).details;
	return typeof detail === "string" && detail.trim() ? redact(detail.trim()) : undefined;
}
