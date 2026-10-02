import type {
	ContentBlock,
	InitializeResponse,
	ModelInfo,
	NewSessionResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import {
	getCurrentTools,
	toToolDeclaration,
	type JsonObject,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type Tool,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";

import {
	clearAntigravityCredentials,
	inspectAntigravityAuth,
	type AntigravityAuthHealth,
} from "./acp/antigravity.js";
import { AntigravityAcpConnection, type AntigravityConnectionOptions } from "./acp/connection.js";
import { abortError, AntigravityAcpError, errorMessage } from "./acp/errors.js";
import { AcpSessionStore, SESSION_RECORD_SCHEMA_VERSION } from "./acp/session-store.js";
import {
	MANAGED_AUTH_MARKER,
	PERMISSION_RESULT_KIND,
	PERMISSION_TOOL_NAME,
	REQUIRED_BRIDGE_TOOLS,
} from "./constants.js";
export { MANAGED_AUTH_MARKER, PERMISSION_RESULT_KIND, PERMISSION_TOOL_NAME } from "./constants.js";
import { mapSessionUpdate } from "./acp/events.js";
import { ensureAntigravityAcpReady } from "./acp/setup.js";
import { HeadlessOAuthRelay, shouldUseHeadlessOAuth } from "./acp/headless-oauth.js";
import {
	PiMcpBridge,
	piToolFingerprint,
	planToolProjection,
	type PiToolInvocation,
	type ToolOmission,
} from "./mcp/bridge.js";
import { DEFAULT_CONFIG, type PermissionMode } from "./config.js";
import { resolveAcpModelId } from "./models.js";
import { type PromptParts, buildPromptParts, renderInstructionUpdates } from "./stream/context.js";
import { PiEventWriter } from "./stream/pi-events.js";
import { usageFromPrompt } from "./stream/usage.js";
import { RuntimeMetrics } from "./status.js";

const PERMISSION_TIMEOUT_MS = 120_000;
const TOOL_BATCH_MS = 100;

type AntigravityModel = Model<"antigravity-acp">;

interface PendingPermission {
	id: string;
	request: RequestPermissionRequest;
	resolve: (response: RequestPermissionResponse) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface PendingPiTool {
	invocation: PiToolInvocation;
	/** Answers the parked MCP call and releases its hold on the prompt watchdog. */
	resolve: (result: CallToolResult) => void;
}

interface Binding {
	key: string;
	cwd: string;
	connection: AntigravityAcpConnection;
	initialize: InitializeResponse;
	session: NewSessionResponse;
	/** The permission mode this ACP session was confirmed to be in. */
	mode: PermissionMode;
	modelId: string;
	messageCount: number;
	historyFingerprint: string;
	expectedAssistantFingerprint: string | undefined;
	pendingContextCount: number;
	pendingContextFingerprint: string;
	queue: Promise<void>;
	writer: PiEventWriter | undefined;
	permission: PendingPermission | undefined;
	pendingTools: Map<string, PendingPiTool>;
	toolBatchTimer: ReturnType<typeof setTimeout> | undefined;
	bridge: PiMcpBridge | undefined;
	toolFingerprint: string;
	omittedTools: ToolOmission[];
	/** Instruction updates Pi added while a running ACP prompt was resumed; sent on the next prompt. */
	deferredInstructions: string[];
	turnCompletion: Promise<void> | undefined;
	abortRequested: boolean;
	piSessionId: string | undefined;
	restored: boolean;
}

export interface PermissionView {
	id: string;
	title: string;
	options: Array<{ id: string; label: string; kind: string }>;
}

export interface ManualGoogleLoginInteraction {
	showAuthorizationUrl: (url: string, instructions: string) => void;
	promptForCallback: (signal: AbortSignal) => Promise<string>;
}

export interface PermissionToolResult {
	kind: typeof PERMISSION_RESULT_KIND;
	requestId: string;
	optionId?: string;
	cancelled: boolean;
}

export interface RuntimeSnapshot {
	bindings: number;
	permissionMode: PermissionMode;
	metrics: ReturnType<RuntimeMetrics["snapshot"]>;
	processes: Array<{
		key: string;
		pid?: number;
		generation: number;
		sessionId: string;
		permissionMode: PermissionMode;
		modelId: string;
		alive: boolean;
		waitingForPermission: boolean;
		waitingForTools: number;
		agentVersion: string | undefined;
		mcpHttp: boolean;
		restored: boolean;
		omittedTools: ToolOmission[];
		ignoredStdoutNoiseLines: number;
		stderrTail?: string;
	}>;
}

export type AntigravityConnectionFactory = (options: AntigravityConnectionOptions) => AntigravityAcpConnection;

export class AntigravityRuntime {
	private readonly bindings = new Map<string, Promise<Binding>>();
	private readonly resolvedBindings = new Set<Binding>();
	private disposed = false;

	private readonly connectionFactory: AntigravityConnectionFactory;
	private readonly ensureAgent: boolean;
	private readonly sessionStore: AcpSessionStore | undefined;
	private readonly metrics = new RuntimeMetrics();
	private permissionMode: PermissionMode;

	constructor(
		connectionFactory?: AntigravityConnectionFactory,
		permissionMode: PermissionMode = DEFAULT_CONFIG.permissions,
		sessionStore?: AcpSessionStore,
	) {
		this.connectionFactory = connectionFactory ?? ((options) => new AntigravityAcpConnection(options));
		this.ensureAgent = connectionFactory === undefined;
		this.permissionMode = permissionMode;
		this.sessionStore = sessionStore ?? (this.ensureAgent ? new AcpSessionStore() : undefined);
	}

	stream(model: AntigravityModel, context: TranscriptContext, options: SimpleStreamOptions = {}): PiEventWriter {
		const writer = new PiEventWriter(model);
		void this.runQueued(model, context, options, writer).catch((error: unknown) => {
			writer.fail(error, options.signal?.aborted === true || isAbort(error));
		});
		return writer;
	}

	async discoverModels(apiKey: string | undefined, signal?: AbortSignal): Promise<ModelInfo[]> {
		this.assertActive();
		if (signal?.aborted) throw abortError();
		if (this.ensureAgent) await ensureAntigravityAcpReady();
		if (signal?.aborted) throw abortError();
		const connection = this.connectionFactory({ cwd: process.cwd() });
		try {
			const initialize = await connection.initialize(signal);
			await authenticateForCredential(connection, initialize, apiKey, signal);
			const session = await connection.newSession(process.cwd(), signal);
			return session.models?.availableModels ?? [];
		} finally {
			await connection.close();
		}
	}

	async loginGoogle(
		signal?: AbortSignal,
		onProgress?: (message: string) => void,
		manualInteraction?: ManualGoogleLoginInteraction,
	): Promise<void> {
		this.assertActive();
		if (this.ensureAgent) await ensureAntigravityAcpReady(onProgress);
		const useManualOAuth = manualInteraction !== undefined && shouldUseHeadlessOAuth();
		const relay = useManualOAuth ? new HeadlessOAuthRelay() : undefined;
		const connection = this.connectionFactory({
			cwd: process.cwd(),
			...(relay ? { env: relay.env } : {}),
		});
		try {
			const initialize = await connection.initialize();
			const method = initialize.authMethods?.find((candidate) =>
				/log\s*in\s+with\s+google|google\s+account|oauth-personal/iu.test(
					`${candidate.id} ${candidate.name}`,
				),
			);
			if (!method) throw new AntigravityAcpError("auth", "Antigravity ACP did not advertise Google login");
			const authentication = connection.authenticate(
				{ methodId: method.id },
				signal,
				relay ? 10 * 60_000 : undefined,
			);
			void authentication.catch(() => undefined);
			if (relay && manualInteraction) {
				const captured = await raceAuthentication(relay.waitForAuthorization(signal), authentication);
				if (captured.authenticated) {
					onProgress?.("Antigravity reused the saved Google login.");
				} else {
					const instructions =
						"Open this URL in a browser on your local machine. After Google redirects to localhost, the page may fail to load; copy the complete localhost URL from the browser address bar and paste it below.";
					manualInteraction.showAuthorizationUrl(captured.value.url, instructions);
					const promptController = new AbortController();
					let entered: Awaited<ReturnType<typeof raceAuthentication<string>>>;
					try {
						entered = await raceAuthentication(
							manualInteraction.promptForCallback(promptController.signal),
							authentication,
						);
					} catch (error) {
						promptController.abort();
						throw error;
					}
					if (entered.authenticated) {
						promptController.abort();
					} else {
						await relay.forwardCallback(entered.value, captured.value, signal);
					}
				}
			}
			await authentication;
			await connection.newSession(process.cwd(), signal);
		} finally {
			relay?.dispose();
			await connection.close();
		}
	}

	async verifyApiKey(
		apiKey: string,
		signal?: AbortSignal,
		onProgress?: (message: string) => void,
	): Promise<void> {
		this.assertActive();
		if (this.ensureAgent) await ensureAntigravityAcpReady(onProgress);
		const connection = this.connectionFactory({ cwd: process.cwd() });
		try {
			const initialize = await connection.initialize();
			await authenticateForCredential(connection, initialize, apiKey, signal);
			await connection.newSession(process.cwd(), signal);
		} finally {
			await connection.close();
		}
	}

	async authHealth(apiKey?: string): Promise<AntigravityAuthHealth & { networkValid?: boolean; error?: string }> {
		const local = inspectAntigravityAuth();
		try {
			await this.discoverModels(apiKey ?? (hasUsableLocalAuth(local) ? MANAGED_AUTH_MARKER : undefined));
			return { ...local, networkValid: true };
		} catch (error) {
			return { ...local, networkValid: false, error: errorMessage(error) };
		}
	}

	async logout(): Promise<void> {
		await this.closeBindings();
		this.sessionStore?.clear();
		clearAntigravityCredentials();
	}

	/**
	 * Fail closed: every live session either confirms the new mode via session/set_mode or is
	 * closed, so its next turn re-negotiates through the create/restore path. When this resolves,
	 * no live binding is in any other mode, and the caller may persist the mode.
	 */
	async setPermissionMode(mode: PermissionMode): Promise<void> {
		// New and in-flight bindings negotiate the new mode; runQueued drops any binding whose
		// confirmed mode differs before prompting.
		this.permissionMode = mode;
		await Promise.all(
			[...this.resolvedBindings].map(async (binding) => {
				if (binding.mode === mode) return;
				if (supportsMode(binding.session, mode)) {
					try {
						await binding.connection.setMode(binding.session.sessionId, mode);
						binding.mode = mode;
						return;
					} catch {
						// Fall through: a session that could not confirm the mode is closed.
					}
				}
				await this.dropBinding(binding.key, binding);
			}),
		);
	}

	getPermission(requestId: string): PermissionView | undefined {
		for (const binding of this.resolvedBindings) {
			if (binding.permission?.id === requestId) return permissionView(binding.permission);
		}
		return undefined;
	}

	async snapshot(includeStderr = false): Promise<RuntimeSnapshot> {
		const entries = [...this.bindings.entries()];
		const processes = await Promise.all(
			entries.map(async ([key, pending]) => {
				const binding = await pending;
				const pid = binding.connection.process.pid;
				return {
					key,
					...(pid === undefined ? {} : { pid }),
					generation: binding.connection.process.generation,
					sessionId: binding.session.sessionId,
					permissionMode: binding.mode,
					modelId: binding.modelId,
					alive: binding.connection.process.alive,
					waitingForPermission: binding.permission !== undefined,
					waitingForTools: binding.pendingTools.size,
					agentVersion: binding.initialize.agentInfo?.version,
					mcpHttp: binding.initialize.agentCapabilities?.mcpCapabilities?.http === true,
					restored: binding.restored,
					omittedTools: binding.omittedTools,
					ignoredStdoutNoiseLines: binding.connection.process.ignoredStdoutNoiseLines,
					...(includeStderr ? { stderrTail: binding.connection.process.stderrTail } : {}),
				};
			}),
		);
		return {
			bindings: this.bindings.size,
			permissionMode: this.permissionMode,
			metrics: this.metrics.snapshot(),
			processes,
		};
	}

	async close(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.closeBindings();
	}

	private async closeBindings(): Promise<void> {
		const pending = [...this.bindings.values()];
		this.bindings.clear();
		for (const binding of this.resolvedBindings) {
			cancelPermission(binding);
			cancelPiTools(binding, "Provider shut down before Pi returned the tool result");
		}
		this.resolvedBindings.clear();
		await Promise.allSettled(
			pending.map(async (binding) => {
				const value = await binding;
				await Promise.allSettled([
					value.connection.close(),
					value.bridge?.close() ?? Promise.resolve(),
				]);
			}),
		);
	}

	private async runQueued(
		model: AntigravityModel,
		context: TranscriptContext,
		options: SimpleStreamOptions,
		writer: PiEventWriter,
	): Promise<void> {
		this.assertActive();
		if (this.ensureAgent) await ensureAntigravityAcpReady();
		const persistent = Boolean(options.sessionId);
		const key = options.sessionId
			? `sid:${options.sessionId}`
			: (this.findContinuationKey(context) ?? `ephemeral:${crypto.randomUUID()}`);
		// Pi 0.99 carries the tool set as system-message deltas, not Context.tools.
		const tools = getCurrentTools(context.messages);
		const acpModelId = resolveAcpModelId(model, options.reasoning);
		let binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);

		// A permission tool result resumes the still-running ACP prompt rather than
		// starting a second Antigravity turn.
		if (binding.permission) {
			const pending = binding.permission;
			const result = findPermissionResult(context, pending.id);
			if (!result) {
				cancelPermission(binding);
				await this.dropBinding(key, binding);
				binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
			} else {
				binding.writer = writer;
				deferInstructionUpdates(binding, context);
				binding.pendingContextCount = context.messages.length;
				binding.pendingContextFingerprint = messagesFingerprint(context.messages);
				binding.permission = undefined;
				clearTimeout(pending.timer);
				if (
					!result.cancelled &&
					result.optionId &&
					pending.request.options.some((option) => option.optionId === result.optionId)
				) {
					pending.resolve({ outcome: { outcome: "selected", optionId: result.optionId } });
				} else {
					pending.resolve({ outcome: { outcome: "cancelled" } });
				}
				await this.awaitContinuation(binding, options.signal);
				return;
			}
		}

		if (binding.pendingTools.size > 0) {
			const results = [...binding.pendingTools.values()].map((pending) => ({
				pending,
				message: findToolResult(context, pending.invocation.id, pending.invocation.name),
			}));
			if (results.some((result) => result.message === undefined)) {
				cancelPiTools(binding, "Pi continued without returning every requested tool result");
				await this.dropBinding(key, binding);
				binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
			} else {
				binding.writer = writer;
				deferInstructionUpdates(binding, context);
				binding.pendingContextCount = context.messages.length;
				binding.pendingContextFingerprint = messagesFingerprint(context.messages);
				for (const { pending, message } of results) {
					binding.pendingTools.delete(pending.invocation.id);
					pending.resolve(toMcpToolResult(message as ToolResultMessage));
				}
				await this.awaitContinuation(binding, options.signal);
				return;
			}
		}

		// Validate the full projection plan on every turn, before any reuse decision: a required
		// tool that became active but cannot be projected refuses before the next ACP prompt.
		assertRequiredToolsProjected(toolOmissions(binding.initialize, tools));
		if (binding.toolFingerprint !== piToolFingerprint(tools) || binding.mode !== this.permissionMode) {
			await this.dropBinding(key, binding);
			binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
		}

		const previous = binding.queue;
		let release!: () => void;
		binding.queue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;

		let completeTurn: (() => void) | undefined;
		// Bound once the prompt binding is final; removed in finally.
		let onTurnAbort: (() => void) | undefined;
		try {
			if (
				context.messages.length < binding.messageCount ||
				messagesFingerprint(context.messages.slice(0, binding.messageCount)) !==
					binding.historyFingerprint
			) {
				if (binding.piSessionId) this.sessionStore?.remove(binding.piSessionId);
				await this.dropBinding(key, binding);
				binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
			}
			binding.writer = writer;
			if (binding.modelId !== acpModelId) {
				await binding.connection.setModel(binding.session.sessionId, acpModelId, options.signal);
				binding.modelId = acpModelId;
			}

			const fresh = binding.messageCount === 0;
			let unseenStart = binding.messageCount;
			const expected = context.messages[unseenStart];
			if (
				!fresh &&
				expected?.role === "assistant" &&
				binding.expectedAssistantFingerprint === messageFingerprint(expected)
			) {
				unseenStart += 1;
			}
			// A fresh reconstruction already carries the full current system prompt.
			const deferred = binding.deferredInstructions.splice(0);
			const parts = adaptPromptToCapabilities(
				buildPromptParts(context, fresh, unseenStart, fresh ? [] : deferred),
				binding.initialize,
			);
			binding.pendingContextCount = context.messages.length;
			binding.pendingContextFingerprint = messagesFingerprint(context.messages);
			binding.turnCompletion = new Promise<void>((resolve) => {
				completeTurn = resolve;
			});
			if (options.signal) {
				const promptBinding = binding;
				onTurnAbort = () => abortTurn(promptBinding);
				if (options.signal.aborted) onTurnAbort();
				else options.signal.addEventListener("abort", onTurnAbort, { once: true });
			}
			const response = await binding.connection.prompt(
				{ sessionId: binding.session.sessionId, prompt: parts.prompt },
				options.signal,
			);
			// A completed prompt wins over a later abort, as before.
			if (onTurnAbort) options.signal?.removeEventListener("abort", onTurnAbort);
			const activeWriter = binding.writer ?? writer;
			if (binding.abortRequested) throw abortError();
			const usage = usageFromPrompt(response);
			activeWriter.message.usage = usage;
			this.metrics.record(response, usage);
			activeWriter.message.rawStopReason = response.stopReason;
			binding.messageCount = binding.pendingContextCount || parts.messageCount;
			binding.historyFingerprint = binding.pendingContextFingerprint;
			binding.expectedAssistantFingerprint = messageFingerprint(activeWriter.message);
			this.persistBinding(binding);
			switch (response.stopReason) {
				case "cancelled":
					throw abortError();
				case "max_tokens":
				case "max_turn_requests":
					activeWriter.done("length");
					break;
				default:
					activeWriter.done("stop");
			}
		} catch (error) {
			binding.writer?.fail(error, isAbort(error));
			// An acknowledged abort keeps a healthy process, so nothing else answers what is parked.
			if (isAbort(error) || binding.abortRequested) abortTurn(binding);
			if (!binding.connection.process.alive) await this.dropBinding(key, binding);
			throw error;
		} finally {
			if (onTurnAbort) options.signal?.removeEventListener("abort", onTurnAbort);
			completeTurn?.();
			binding.turnCompletion = undefined;
			binding.abortRequested = false;
			binding.writer = undefined;
			release();
			if (!persistent) await this.dropBinding(key, binding);
		}
	}

	private async awaitContinuation(binding: Binding, signal?: AbortSignal): Promise<void> {
		// The caller's signal may cancel only the turn in flight at entry. With no turn in flight
		// there is nothing to cancel, and marking the warm binding aborted would poison its next turn.
		const completion = binding.turnCompletion;
		if (!completion) return;
		if (!signal) {
			await completion;
			return;
		}
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const abort = () => {
			// A stale abort must not cancel a newer turn that replaced the captured one.
			if (binding.turnCompletion !== completion || binding.abortRequested) return;
			abortTurn(binding);
			void binding.connection.cancel(binding.session.sessionId).catch(() => undefined);
			killTimer = setTimeout(() => void binding.connection.close(), 1_500);
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		try {
			await completion;
		} finally {
			signal.removeEventListener("abort", abort);
			if (killTimer) clearTimeout(killTimer);
		}
	}

	private findContinuationKey(context: TranscriptContext): string | undefined {
		for (const binding of this.resolvedBindings) {
			if (binding.permission && findPermissionResult(context, binding.permission.id)) return binding.key;
			if (
				binding.pendingTools.size > 0 &&
				[...binding.pendingTools.values()].every((pending) =>
					findToolResult(context, pending.invocation.id, pending.invocation.name),
				)
			) {
				return binding.key;
			}
		}
		return undefined;
	}

	private async getBinding(
		key: string,
		model: AntigravityModel,
		acpModelId: string,
		apiKey: string | undefined,
		writer: PiEventWriter,
		tools: readonly Tool[],
		signal?: AbortSignal,
	): Promise<Binding> {
		const existing = this.bindings.get(key);
		if (existing) return existing;
		const created = this.createBinding(key, model, acpModelId, apiKey, writer, tools, signal).catch((error) => {
			this.bindings.delete(key);
			throw error;
		});
		this.bindings.set(key, created);
		return created;
	}

	private async createBinding(
		key: string,
		model: AntigravityModel,
		acpModelId: string,
		apiKey: string | undefined,
		writer: PiEventWriter,
		tools: readonly Tool[],
		signal?: AbortSignal,
	): Promise<Binding> {
		const cwd = process.cwd();
		let binding: Binding | undefined;
		let bridge: PiMcpBridge | undefined;
		const connection = this.connectionFactory({
			cwd,
			handlers: {
				onUpdate: (notification) => this.consumeUpdate(binding, notification),
				onPermission: (request) => this.requestPermission(binding, request),
			},
		});
		try {
			const initialize = await connection.initialize();
			await authenticateForCredential(connection, initialize, apiKey, signal);
			const mcpHttp = initialize.agentCapabilities?.mcpCapabilities?.http === true;
			const omittedTools = toolOmissions(initialize, tools);
			assertRequiredToolsProjected(omittedTools);
			let mcpServer;
			if (tools.length > 0 && mcpHttp) {
				bridge = new PiMcpBridge({
					tools,
					onCall: (invocation) => this.requestPiTool(binding, invocation),
				});
				mcpServer = await bridge.start();
			}
			const mcpServers = mcpServer ? [mcpServer] : [];
			const piSessionId = key.startsWith("sid:") ? key.slice(4) : undefined;
			const saved = piSessionId ? this.sessionStore?.get(piSessionId) : undefined;
			let session: NewSessionResponse | undefined;
			let restored = false;
			if (saved?.cwd === cwd) {
				if (initialize.agentCapabilities?.sessionCapabilities?.resume) {
					try {
						const resumed = await connection.resumeSession(saved.acpSessionId, cwd, mcpServers, signal);
						session = { sessionId: saved.acpSessionId, ...resumed };
						restored = true;
					} catch {
						// Some Antigravity builds advertise the draft method before implementing it.
					}
				}
				if (!session && initialize.agentCapabilities?.loadSession === true) {
					try {
						const loaded = await connection.loadSession(saved.acpSessionId, cwd, mcpServers, signal);
						session = { sessionId: saved.acpSessionId, ...loaded };
						restored = true;
					} catch {
						this.sessionStore?.remove(saved.piSessionId);
					}
				}
			}
			session ??= await connection.newSession(cwd, signal, mcpServers);
			// Fail closed on new and restored sessions alike: never prompt in an unconfirmed mode.
			const mode = this.permissionMode;
			if (!supportsMode(session, mode)) {
				if (restored && piSessionId) this.sessionStore?.remove(piSessionId);
				throw new AntigravityAcpError(
					"protocol",
					`Antigravity ${restored ? "restored" : "new"} session did not advertise permission mode '${mode}'; refusing the session`,
				);
			}
			if (session.modes?.currentModeId !== mode) {
				await connection.setMode(session.sessionId, mode, signal);
			}
			const currentModel = session.models?.currentModelId;
			if (currentModel !== acpModelId) await connection.setModel(session.sessionId, acpModelId, signal);
			const createdBinding: Binding = {
				key,
				cwd,
				connection,
				initialize,
				session,
				mode,
				modelId: acpModelId,
				messageCount: restored && saved ? saved.messageCount : 0,
				historyFingerprint: restored && saved ? saved.historyFingerprint : messagesFingerprint([]),
				expectedAssistantFingerprint: restored ? saved?.expectedAssistantFingerprint : undefined,
				pendingContextCount: 0,
				pendingContextFingerprint: messagesFingerprint([]),
				queue: Promise.resolve(),
				writer,
				permission: undefined,
				pendingTools: new Map(),
				toolBatchTimer: undefined,
				bridge,
				toolFingerprint: piToolFingerprint(tools),
				omittedTools,
				deferredInstructions: [],
				turnCompletion: undefined,
				abortRequested: false,
				piSessionId,
				restored,
			};
			binding = createdBinding;
			this.persistBinding(createdBinding);
			this.resolvedBindings.add(createdBinding);
			void connection.process.exited.then(() => {
				this.resolvedBindings.delete(createdBinding);
				// Parked calls have no wall-clock limit, so a dead process must answer them itself.
				cancelPiTools(createdBinding, "Antigravity ACP process exited before Pi returned the tool result");
				void bridge?.close().catch(() => undefined);
				const current = this.bindings.get(key);
				if (current) {
					void current
						.then((value) => value === createdBinding && this.bindings.delete(key))
						.catch(() => undefined);
				}
			}).catch(() => undefined);
			return createdBinding;
		} catch (error) {
			await Promise.allSettled([connection.close(), bridge?.close() ?? Promise.resolve()]);
			throw error;
		}
	}

	private persistBinding(binding: Binding): void {
		if (!binding.piSessionId) return;
		this.sessionStore?.save({
			schemaVersion: SESSION_RECORD_SCHEMA_VERSION,
			piSessionId: binding.piSessionId,
			acpSessionId: binding.session.sessionId,
			acpModelId: binding.modelId,
			cwd: binding.cwd,
			messageCount: binding.messageCount,
			historyFingerprint: binding.historyFingerprint,
			...(binding.expectedAssistantFingerprint
				? { expectedAssistantFingerprint: binding.expectedAssistantFingerprint }
				: {}),
			lastActive: Date.now(),
		});
	}

	private requestPiTool(
		binding: Binding | undefined,
		invocation: PiToolInvocation,
	): Promise<CallToolResult> {
		if (!binding?.writer || binding.writer.finished || binding.permission || binding.abortRequested) {
			// After an abort sweep nothing may park again: it would outlive the aborted turn.
			return Promise.resolve({
				content: [{ type: "text", text: "Pi cannot accept this tool call in the current turn" }],
				isError: true,
			});
		}
		const args = toJsonObject(invocation.arguments);
		if (!args) {
			return Promise.resolve({
				content: [{ type: "text", text: "Tool arguments must be a plain JSON object" }],
				isError: true,
			});
		}
		// No wall-clock limit: Pi tools (subagents, workflows, long shell commands) run as long as
		// they need. The call stays parked until Pi returns its result, Pi continues without it,
		// the turn is aborted, or the binding closes (cancelPiTools). While parked it holds the ACP
		// prompt's progress watchdog, since Antigravity is legitimately silent meanwhile.
		return new Promise<CallToolResult>((resolve) => {
			let release: (() => void) | undefined;
			try {
				release = binding.connection.holdPromptWatchdog(binding.session.sessionId);
				const hold = release;
				binding.pendingTools.set(invocation.id, {
					invocation,
					resolve: (result) => {
						hold();
						resolve(result);
					},
				});
				binding.writer?.toolCall(invocation.id, invocation.name, args);
				if (binding.toolBatchTimer) clearTimeout(binding.toolBatchTimer);
				binding.toolBatchTimer = setTimeout(() => {
					binding.toolBatchTimer = undefined;
					binding.writer?.done("toolUse");
				}, TOOL_BATCH_MS);
				binding.toolBatchTimer.unref();
			} catch (error) {
				// Never leave a half-parked call: no entry, no hold, and an answer rather than a rejection.
				binding.pendingTools.delete(invocation.id);
				release?.();
				resolve({
					content: [
						{
							type: "text",
							text: `Pi could not accept this tool call: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				});
			}
		});
	}

	private requestPermission(
		binding: Binding | undefined,
		request: RequestPermissionRequest,
	): Promise<RequestPermissionResponse> {
		// After an abort sweep a new permission request is refused as cancelled, like a late bridged call.
		if (
			!binding?.writer ||
			binding.permission ||
			binding.abortRequested ||
			request.sessionId !== binding.session.sessionId
		) {
			return Promise.resolve({ outcome: { outcome: "cancelled" } });
		}
		const id = crypto.randomUUID();
		return new Promise<RequestPermissionResponse>((resolve) => {
			const timer = setTimeout(() => {
				if (binding.permission?.id !== id) return;
				binding.permission = undefined;
				resolve({ outcome: { outcome: "cancelled" } });
			}, PERMISSION_TIMEOUT_MS);
			timer.unref();
			binding.permission = { id, request, resolve, timer };
			binding.writer?.toolCall(id, PERMISSION_TOOL_NAME, { requestId: id });
			binding.writer?.done("toolUse");
		});
	}

	private consumeUpdate(binding: Binding | undefined, notification: SessionNotification): void {
		if (!binding || notification.sessionId !== binding.session.sessionId || !binding.writer) return;
		for (const activity of mapSessionUpdate(notification)) {
			if (activity.type === "text") binding.writer.text(activity.delta);
			else if (activity.type === "thought") binding.writer.thinking(activity.delta);
			else if (activity.type === "plan") binding.writer.thinking(activity.text);
		}
	}

	private async dropBinding(key: string, binding: Binding): Promise<void> {
		const current = this.bindings.get(key);
		if (current && (await current) === binding) this.bindings.delete(key);
		this.resolvedBindings.delete(binding);
		cancelPermission(binding);
		cancelPiTools(binding, "Antigravity session closed before Pi returned the tool result");
		await Promise.allSettled([binding.connection.close(), binding.bridge?.close() ?? Promise.resolve()]);
	}

	private assertActive(): void {
		if (this.disposed) throw new AntigravityAcpError("process_exit", "Antigravity ACP runtime is closed");
	}
}

async function authenticateForCredential(
	connection: AntigravityAcpConnection,
	initialize: InitializeResponse,
	apiKey: string | undefined,
	signal?: AbortSignal,
): Promise<void> {
	if (!apiKey || apiKey === MANAGED_AUTH_MARKER) return;
	const method = initialize.authMethods?.find((candidate) => {
		const meta = candidate._meta as Record<string, unknown> | null | undefined;
		return "api-key" in (meta ?? {}) || /api key/iu.test(candidate.name);
	});
	if (!method) throw new AntigravityAcpError("auth", "Antigravity ACP did not advertise API-key authentication");
	await connection.authenticate({ methodId: method.id, _meta: { "api-key": apiKey } }, signal);
}

function adaptPromptToCapabilities(parts: PromptParts, initialize: InitializeResponse): PromptParts {
	const capabilities = initialize.agentCapabilities?.promptCapabilities;
	const output: ContentBlock[] = [];
	for (const block of parts.prompt) {
		if (block.type === "image" && capabilities?.image !== true) {
			throw new AntigravityAcpError("invalid_input", "This Antigravity ACP runtime did not advertise image input");
		}
		if (block.type === "resource" && capabilities?.embeddedContext !== true) {
			const resource = block.resource;
			if ("text" in resource) output.push({ type: "text", text: resource.text });
			continue;
		}
		output.push(block);
	}
	return { ...parts, prompt: output };
}

function hasUsableLocalAuth(health: AntigravityAuthHealth): boolean {
	return health.status === "api-key-env" || health.status === "oauth-refreshable";
}

function supportsMode(session: NewSessionResponse, mode: PermissionMode): boolean {
	return session.modes?.availableModes.some((candidate) => candidate.id === mode) === true;
}

function permissionView(permission: PendingPermission): PermissionView {
	const call = permission.request.toolCall;
	const details = {
		kind: call.kind,
		locations: call.locations,
		content: call.content,
		rawInput: call.rawInput,
	};
	const visibleDetails = JSON.stringify(details, null, 2).slice(0, 8_000);
	return {
		id: permission.id,
		title: `${call.title ?? "Antigravity requests permission"}\n\n${visibleDetails}`,
		options: permission.request.options.map((option) => ({
			id: option.optionId,
			label: option.name,
			kind: option.kind,
		})),
	};
}

function findPermissionResult(context: TranscriptContext, requestId: string): PermissionToolResult | undefined {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (
			message?.role !== "toolResult" ||
			message.toolName !== PERMISSION_TOOL_NAME ||
			message.toolCallId !== requestId
		) {
			continue;
		}
		const details = message.details as Partial<PermissionToolResult> | undefined;
		if (
			details?.kind === PERMISSION_RESULT_KIND &&
			details.requestId === requestId &&
			typeof details.cancelled === "boolean"
		) {
			return details as PermissionToolResult;
		}
		// A missing/disabled tool or malformed output is an immediate denial,
		// never an implicit approval and never a hung ACP request.
		return {
			kind: PERMISSION_RESULT_KIND,
			requestId,
			cancelled: true,
		};
	}
	return undefined;
}

function messagesFingerprint(messages: readonly Message[]): string {
	const fingerprints = messages.map(messageFingerprint);
	return createHash("sha256").update(fingerprints.join("\n")).digest("hex");
}

function messageFingerprint(message: Message): string {
	let value: unknown;
	if (message.role === "system") {
		value = {
			role: message.role,
			content: message.content,
			sections: message.sections,
			toolsAdded: message.toolsAdded?.map(toToolDeclaration),
			toolsRemoved: message.toolsRemoved?.map((tool) => tool.name),
		};
	} else if (message.role === "user") {
		value = { role: message.role, content: message.content };
	} else if (message.role === "assistant") {
		value = {
			role: message.role,
			provider: message.provider,
			model: message.model,
			content: message.content,
		};
	} else if (message.role === "toolResult") {
		value = {
			role: message.role,
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			content: message.content,
			isError: message.isError,
		};
	} else {
		const unknownRole: never = message;
		throw new AntigravityAcpError("invalid_input", `Unsupported Pi message role: ${JSON.stringify(unknownRole)}`);
	}
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function deferInstructionUpdates(binding: Binding, context: TranscriptContext): void {
	const start = Math.min(binding.pendingContextCount, context.messages.length);
	binding.deferredInstructions.push(...renderInstructionUpdates(context.messages.slice(start)));
}

/** Every active Pi tool Antigravity will not receive for this agent, with the reason. */
function toolOmissions(initialize: InitializeResponse, tools: readonly Tool[]): ToolOmission[] {
	if (initialize.agentCapabilities?.mcpCapabilities?.http === true) return planToolProjection(tools).omissions;
	return tools
		.filter((tool) => tool.name !== PERMISSION_TOOL_NAME)
		.map((tool) => ({ name: tool.name, reason: "Antigravity did not advertise MCP over HTTP" }));
}

function assertRequiredToolsProjected(omissions: readonly ToolOmission[]): void {
	const missing = omissions.filter((omission) => REQUIRED_BRIDGE_TOOLS.includes(omission.name));
	if (missing.length === 0) return;
	throw new AntigravityAcpError(
		"invalid_input",
		`Required Pi tools cannot be bridged to Antigravity; refusing the session: ${missing
			.map((omission) => `${omission.name} (${omission.reason})`)
			.join("; ")}`,
	);
}

/** Narrow untrusted tool arguments to a JSON object: no functions, undefined, non-finite numbers or cycles. */
export function toJsonObject(value: unknown): JsonObject | undefined {
	if (!isPlainObject(value)) return undefined;
	const seen = new Set<object>();
	const isJson = (candidate: unknown): boolean => {
		if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return true;
		if (typeof candidate === "number") return Number.isFinite(candidate);
		if (Array.isArray(candidate) || isPlainObject(candidate)) {
			if (seen.has(candidate)) return false;
			seen.add(candidate);
			const ok = (Array.isArray(candidate) ? candidate : Object.values(candidate)).every(isJson);
			seen.delete(candidate);
			return ok;
		}
		return false;
	};
	return isJson(value) ? (value as JsonObject) : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function findToolResult(
	context: TranscriptContext,
	toolCallId: string,
	toolName: string,
): ToolResultMessage | undefined {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (
			message?.role === "toolResult" &&
			message.toolCallId === toolCallId &&
			message.toolName === toolName
		) {
			return message;
		}
	}
	return undefined;
}

function toMcpToolResult(message: ToolResultMessage): CallToolResult {
	return {
		content: message.content.map((block) =>
			block.type === "text"
				? { type: "text" as const, text: block.text }
				: { type: "image" as const, data: block.data, mimeType: block.mimeType },
		),
		isError: message.isError,
	};
}

function cancelPermission(binding: Binding): void {
	if (!binding.permission) return;
	clearTimeout(binding.permission.timer);
	binding.permission.resolve({ outcome: { outcome: "cancelled" } });
	binding.permission = undefined;
}

/**
 * Abort of a turn: mark it so no bridged call can park again, then answer every parked bridged
 * call and the pending permission. An acknowledged session/cancel keeps a healthy process and its
 * warm binding, so nothing else would answer them until a later turn, close or process exit.
 */
function abortTurn(binding: Binding): void {
	binding.abortRequested = true;
	cancelPermission(binding);
	cancelPiTools(binding, "Pi turn was aborted before Pi returned the tool result");
}

function cancelPiTools(binding: Binding, reason: string): void {
	if (binding.toolBatchTimer) clearTimeout(binding.toolBatchTimer);
	binding.toolBatchTimer = undefined;
	for (const pending of binding.pendingTools.values()) {
		pending.resolve({ content: [{ type: "text", text: reason }], isError: true });
	}
	binding.pendingTools.clear();
}

async function raceAuthentication<T>(
	step: Promise<T>,
	authentication: Promise<void>,
): Promise<{ authenticated: true } | { authenticated: false; value: T }> {
	return Promise.race([
		step.then((value) => ({ authenticated: false as const, value })),
		authentication.then(() => ({ authenticated: true as const })),
	]);
}

function isAbort(error: unknown): boolean {
	return error instanceof AntigravityAcpError
		? error.code === "aborted"
		: error instanceof DOMException && error.name === "AbortError";
}
