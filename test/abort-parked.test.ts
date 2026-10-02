import { type Context, type Model, normalizeContext } from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { AntigravityRuntime } from "../src/runtime.js";

// Abort (Esc) of a turn must answer whatever that turn left parked on the binding: every bridged
// Pi tool call (isError) and a pending permission (cancelled). An acknowledged session/cancel keeps
// the healthy process and its warm binding, so nothing else would answer them. After the sweep a
// late bridged call or permission request must not park again.

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const model: Model<"antigravity-acp"> = {
	id: "gemini-test",
	name: "Gemini Test",
	api: "antigravity-acp",
	provider: "antigravity-acp",
	baseUrl: "",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 8_192,
};
const tools = [{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }) }];

interface LogEntry {
	pid: number;
	method?: string;
	event?: string;
	arguments?: string;
	isError?: boolean;
	text?: string;
	threw?: string;
	decision?: string;
}

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function loggedRuntime() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-abort-parked-"));
	directories.push(directory);
	const log = path.join(directory, "agent.log");
	const runtime = new AntigravityRuntime(
		(options) =>
			new AntigravityAcpConnection({
				...options,
				command: process.execPath,
				args: [fakeAgent],
				env: { ...process.env, FAKE_AGENT_LOG: log },
			}),
	);
	const entries = (): LogEntry[] =>
		fs.existsSync(log)
			? fs
					.readFileSync(log, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as LogEntry)
			: [];
	return { runtime, entries };
}

/** Polls until `check` returns a value, or returns undefined after `ms` of real time. */
async function eventually<T>(check: () => T | undefined | Promise<T | undefined>, ms = 1_200): Promise<T | undefined> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await check();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) return undefined;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function drain(writer: ReturnType<AntigravityRuntime["stream"]>) {
	const events = [];
	for await (const event of writer.stream) events.push(event);
	return events;
}

async function process0(runtime: AntigravityRuntime) {
	const snapshot = await runtime.snapshot();
	const entry = snapshot.processes[0];
	if (!entry) throw new Error("missing binding");
	return entry;
}

/** A plain follow-up turn on the same Pi session must run on the same, still-warm process. */
async function expectWarmReuse(
	runtime: AntigravityRuntime,
	sessionId: string,
	pid: number | undefined,
	withTools = true,
) {
	// Same tool set as the aborted turn: a changed tool set rebinds by design.
	const follow = runtime.stream(
		model,
		normalizeContext({ ...(withTools ? { tools } : {}), messages: [{ role: "user", content: "say hi", timestamp: 9 }] }),
		{ sessionId, apiKey: "test-key" },
	);
	const events = await drain(follow);
	expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
	expect(follow.message.content).toContainEqual({ type: "text", text: "Hello" });
	const after = await process0(runtime);
	expect(after.pid).toBe(pid);
	expect(after.alive).toBe(true);
}

describe("abort answers what the aborted turn left parked", () => {
	it("answers a parked bridged call with an error on abort and keeps the warm binding", async () => {
		const { runtime, entries } = loggedRuntime();
		try {
			const controller = new AbortController();
			const first = runtime.stream(
				model,
				normalizeContext({ tools, messages: [{ role: "user", content: "use bridge", timestamp: 1 }] }),
				{ sessionId: "abort-parked", apiKey: "test-key", signal: controller.signal },
			);
			const events = await drain(first);
			expect(events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
			const parked = await process0(runtime);
			expect(parked.waitingForTools).toBe(1);

			// Esc while Pi has not returned the tool result; the fake agent acknowledges session/cancel.
			controller.abort();

			const call = await eventually(() => entries().find((entry) => entry.event === "mcp-call"));
			expect(call).toMatchObject({ arguments: "from gemini", isError: true });
			expect(call?.text).toContain("aborted");
			expect(await eventually(async () => ((await process0(runtime)).waitingForTools === 0 ? true : undefined))).toBe(
				true,
			);
			const after = await process0(runtime);
			expect(after.alive).toBe(true);
			expect(after.pid).toBe(parked.pid);
			await expectWarmReuse(runtime, "abort-parked", parked.pid);
		} finally {
			await runtime.close();
		}
	});

	it("answers a call parked during a continuation when the continuation is aborted", async () => {
		const { runtime, entries } = loggedRuntime();
		try {
			const firstContext: Context = { tools, messages: [{ role: "user", content: "use bridge twice", timestamp: 1 }] };
			const first = runtime.stream(model, normalizeContext(firstContext), {
				sessionId: "abort-continuation",
				apiKey: "test-key",
			});
			const firstEvents = await drain(first);
			const done = firstEvents.at(-1);
			if (done?.type !== "done") throw new Error("missing bridged tool turn");
			const call = done.message.content.find((block) => block.type === "toolCall");
			if (!call || call.type !== "toolCall") throw new Error("missing bridged tool call");

			const controller = new AbortController();
			const second = runtime.stream(
				model,
				normalizeContext({
					tools,
					messages: [
						...firstContext.messages,
						done.message,
						{
							role: "toolResult",
							toolCallId: call.id,
							toolName: call.name,
							content: [{ type: "text", text: "first result" }],
							isError: false,
							timestamp: 2,
						},
					],
				}),
				{ sessionId: "abort-continuation", apiKey: "test-key", signal: controller.signal },
			);
			// Antigravity makes a second bridged call; the continuation ends in a Pi tool turn.
			const secondEvents = await drain(second);
			expect(secondEvents.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
			const parked = await process0(runtime);
			expect(parked.waitingForTools).toBe(1);

			controller.abort();

			const secondCall = await eventually(() =>
				entries().find((entry) => entry.event === "mcp-call" && entry.arguments === "second call"),
			);
			expect(secondCall).toMatchObject({ isError: true });
			expect(secondCall?.text).toContain("aborted");
			expect(await eventually(async () => ((await process0(runtime)).waitingForTools === 0 ? true : undefined))).toBe(
				true,
			);
			expect((await process0(runtime)).alive).toBe(true);
			await expectWarmReuse(runtime, "abort-continuation", parked.pid);
		} finally {
			await runtime.close();
		}
	});

	it("refuses a bridged call that arrives after the abort sweep instead of parking it", async () => {
		const { runtime, entries } = loggedRuntime();
		try {
			const controller = new AbortController();
			const writer = runtime.stream(
				model,
				normalizeContext({ tools, messages: [{ role: "user", content: "late call", timestamp: 1 }] }),
				{ sessionId: "abort-late-call", apiKey: "test-key", signal: controller.signal },
			);
			const before = await eventually(async () => {
				const snapshot = await runtime.snapshot();
				return entries().some((entry) => entry.method === "session/prompt") ? snapshot.processes[0] : undefined;
			});
			expect(before).toBeDefined();
			// On session/cancel the fake agent makes one more bridged call before it acknowledges.
			controller.abort();
			const events = await drain(writer);
			expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
			const late = entries().find((entry) => entry.event === "mcp-call" && entry.arguments === "after cancel");
			expect(late).toMatchObject({ isError: true, text: "Pi cannot accept this tool call in the current turn" });
			// The refusal let Antigravity acknowledge the cancel, so the process was not killed.
			const after = await process0(runtime);
			expect(after.waitingForTools).toBe(0);
			expect(after.alive).toBe(true);
			expect(after.pid).toBe(before?.pid);
			expect(events.some((event) => event.type === "toolcall_start")).toBe(false);
		} finally {
			await runtime.close();
		}
	});

	it("answers a pending permission as cancelled on abort and keeps the warm binding", async () => {
		const { runtime, entries } = loggedRuntime();
		try {
			const controller = new AbortController();
			const first = runtime.stream(
				model,
				normalizeContext({ messages: [{ role: "user", content: "request permission cancellable", timestamp: 1 }] }),
				{ sessionId: "abort-permission", apiKey: "test-key", signal: controller.signal },
			);
			const events = await drain(first);
			expect(events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
			const parked = await process0(runtime);
			expect(parked.waitingForPermission).toBe(true);

			// As ACP requires, the fake agent ends a cancelled turn only once the permission is answered.
			controller.abort();

			const answer = await eventually(() => entries().find((entry) => entry.event === "permission-answer"));
			expect(answer).toMatchObject({ decision: "cancelled" });
			const after = await process0(runtime);
			expect(after.waitingForPermission).toBe(false);
			expect(after.alive).toBe(true);
			await expectWarmReuse(runtime, "abort-permission", parked.pid, false);
		} finally {
			await runtime.close();
		}
	});

	it("refuses a permission request that arrives after the abort sweep", async () => {
		const { runtime, entries } = loggedRuntime();
		try {
			const controller = new AbortController();
			const writer = runtime.stream(
				model,
				normalizeContext({ messages: [{ role: "user", content: "late permission", timestamp: 1 }] }),
				{ sessionId: "abort-late-permission", apiKey: "test-key", signal: controller.signal },
			);
			const before = await eventually(async () => {
				const snapshot = await runtime.snapshot();
				return entries().some((entry) => entry.method === "session/prompt") ? snapshot.processes[0] : undefined;
			});
			expect(before).toBeDefined();
			controller.abort();
			const events = await drain(writer);
			expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
			expect(entries().find((entry) => entry.event === "permission-answer")).toMatchObject({ decision: "cancelled" });
			const after = await process0(runtime);
			expect(after.waitingForPermission).toBe(false);
			expect(after.alive).toBe(true);
			expect(after.pid).toBe(before?.pid);
		} finally {
			await runtime.close();
		}
	});
});

// A continuation's signal may cancel only the turn that was in flight when the continuation began.
// With no turn in flight, or once a newer turn replaced the captured one, its abort must leave the
// warm binding untouched: no abort mark, no session/cancel, no close timer.
describe("a continuation abort never poisons a later turn", () => {
	it("leaves the next prompt healthy when the continuation is aborted with no turn in flight", async () => {
		const { runtime, entries } = loggedRuntime();
		try {
			const firstContext: Context = { tools, messages: [{ role: "user", content: "orphan call", timestamp: 1 }] };
			const first = runtime.stream(model, normalizeContext(firstContext), {
				sessionId: "abort-idle-continuation",
				apiKey: "test-key",
			});
			const firstEvents = await drain(first);
			const done = firstEvents.at(-1);
			if (done?.type !== "done" || done.reason !== "toolUse") throw new Error("missing bridged tool turn");
			const call = done.message.content.find((block) => block.type === "toolCall");
			if (!call || call.type !== "toolCall") throw new Error("missing bridged tool call");
			// The fake agent ends the prompt while the bridged call is still parked in Pi.
			const idle = await eventually(() =>
				entries().filter((entry) => entry.method === "session/prompt").length === 1 ? true : undefined,
			);
			expect(idle).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 400));
			const parked = await process0(runtime);
			expect(parked.waitingForTools).toBe(1);

			// Pi returns the result with an already-aborted signal: no turn is in flight to cancel.
			const controller = new AbortController();
			controller.abort();
			const history: Context["messages"] = [
				...firstContext.messages,
				done.message,
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: "orphan result" }],
					isError: false,
					timestamp: 2,
				},
			];
			runtime.stream(model, normalizeContext({ tools, messages: history }), {
				sessionId: "abort-idle-continuation",
				apiKey: "test-key",
				signal: controller.signal,
			});
			const delivered = await eventually(() =>
				entries().find((entry) => entry.event === "mcp-call" && entry.arguments === "orphan"),
			);
			expect(delivered).toMatchObject({ isError: false, text: "orphan result" });
			expect((await process0(runtime)).waitingForTools).toBe(0);

			// The next healthy prompt on the same warm binding parks a bridged call and completes.
			const nextContext: Context = {
				tools,
				messages: [...history, { role: "user", content: "use bridge", timestamp: 3 }],
			};
			const next = runtime.stream(model, normalizeContext(nextContext), {
				sessionId: "abort-idle-continuation",
				apiKey: "test-key",
			});
			const nextEvents = await drain(next);
			expect(nextEvents.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
			const nextDone = nextEvents.at(-1);
			if (nextDone?.type !== "done") throw new Error("missing bridged tool turn");
			const nextCall = nextDone.message.content.find((block) => block.type === "toolCall");
			if (!nextCall || nextCall.type !== "toolCall") throw new Error("missing bridged tool call");
			expect((await process0(runtime)).waitingForTools).toBe(1);

			const resumed = runtime.stream(
				model,
				normalizeContext({
					tools,
					messages: [
						...nextContext.messages,
						nextDone.message,
						{
							role: "toolResult",
							toolCallId: nextCall.id,
							toolName: nextCall.name,
							content: [{ type: "text", text: "healthy result" }],
							isError: false,
							timestamp: 4,
						},
					],
				}),
				{ sessionId: "abort-idle-continuation", apiKey: "test-key" },
			);
			const resumedEvents = await drain(resumed);
			expect(resumedEvents.at(-1)).toMatchObject({ type: "done", reason: "stop" });
			expect(resumed.message.content).toContainEqual({ type: "text", text: "healthy result" });
			expect(entries().find((entry) => entry.event === "mcp-call" && entry.arguments === "from gemini")).toMatchObject({
				isError: false,
				text: "healthy result",
			});
			const after = await process0(runtime);
			expect(after.alive).toBe(true);
			expect(after.pid).toBe(parked.pid);
		} finally {
			await runtime.close();
		}
	});

	function unitContinuation() {
		const runtime = new AntigravityRuntime(() => {
			throw new Error("no connection in this unit test");
		});
		const awaitContinuation = (
			runtime as unknown as { awaitContinuation: (binding: unknown, signal?: AbortSignal) => Promise<void> }
		).awaitContinuation.bind(runtime);
		let complete!: () => void;
		const binding = {
			session: { sessionId: "unit" },
			connection: { cancel: vi.fn(async () => undefined), close: vi.fn(async () => undefined) },
			turnCompletion: new Promise<void>((resolve) => {
				complete = resolve;
			}) as Promise<void> | undefined,
			abortRequested: false,
			permission: undefined,
			pendingTools: new Map(),
			toolBatchTimer: undefined,
		};
		return { runtime, awaitContinuation, binding, complete: () => complete() };
	}

	it("leaves the binding untouched when an aborted continuation finds no turn in flight", async () => {
		const { runtime, awaitContinuation, binding } = unitContinuation();
		try {
			binding.turnCompletion = undefined;
			await awaitContinuation(binding, AbortSignal.abort());
			expect(binding.abortRequested).toBe(false);
			expect(binding.connection.cancel).not.toHaveBeenCalled();
		} finally {
			await runtime.close();
		}
	});

	it("ignores a stale continuation abort once a newer turn replaced the captured one", async () => {
		const { runtime, awaitContinuation, binding, complete } = unitContinuation();
		try {
			const controller = new AbortController();
			const waiting = awaitContinuation(binding, controller.signal);
			// A newer turn is in flight on the binding when the continuation's abort fires.
			binding.turnCompletion = new Promise<void>(() => undefined);
			controller.abort();
			expect(binding.abortRequested).toBe(false);
			expect(binding.connection.cancel).not.toHaveBeenCalled();
			complete();
			await waiting;
			expect(binding.connection.close).not.toHaveBeenCalled();
		} finally {
			await runtime.close();
		}
	});

	it("still cancels the captured turn while it is in flight", async () => {
		const { runtime, awaitContinuation, binding, complete } = unitContinuation();
		try {
			const controller = new AbortController();
			const waiting = awaitContinuation(binding, controller.signal);
			controller.abort();
			expect(binding.abortRequested).toBe(true);
			expect(binding.connection.cancel).toHaveBeenCalledWith("unit");
			complete();
			await waiting;
			// Settling within the grace clears the close timer.
			expect(binding.connection.close).not.toHaveBeenCalled();
		} finally {
			await runtime.close();
		}
	});
});

describe("requestPiTool never leaves a half-parked call", () => {
	it("releases the hold, drops the entry and answers isError when parking throws", async () => {
		const runtime = new AntigravityRuntime(() => {
			throw new Error("no connection in this unit test");
		});
		const release = vi.fn();
		const binding = {
			session: { sessionId: "unit" },
			connection: { holdPromptWatchdog: vi.fn(() => release) },
			writer: {
				finished: false,
				toolCall: () => {
					throw new Error("writer exploded");
				},
			},
			permission: undefined,
			abortRequested: false,
			pendingTools: new Map(),
			toolBatchTimer: undefined,
		};
		const requestPiTool = (
			runtime as unknown as {
				requestPiTool: (binding: unknown, invocation: unknown) => Promise<{ isError?: boolean; content: unknown }>;
			}
		).requestPiTool.bind(runtime);
		const result = await requestPiTool(binding, { id: "call-1", name: "echo", arguments: { text: "x" } });
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("writer exploded");
		expect(release).toHaveBeenCalledTimes(1);
		expect(binding.pendingTools.size).toBe(0);
		await runtime.close();
	});
});
