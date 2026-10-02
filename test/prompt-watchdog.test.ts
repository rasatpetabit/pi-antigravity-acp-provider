import { type Context, type Model, normalizeContext } from "@earendil-works/pi-ai";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AntigravityAcpConnection, type AntigravityConnectionOptions } from "../src/acp/connection.js";
import { AntigravityAcpError } from "../src/acp/errors.js";
import { AntigravityRuntime } from "../src/runtime.js";

// A session/prompt spans the whole Antigravity agent turn, so it is bounded by progress, not by
// wall-clock time. Long durations are modelled by jumping the provider's timer clock (faked
// setTimeout/clearTimeout that also advance with real time) at the moment the fake agent is
// legitimately busy; real test time stays short. A small real idle limit proves the watchdog
// still fires for a genuinely stalled prompt.

// Captured before any test fakes the clock: test-side waits must not be fired by a clock jump.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const IDLE_MS = 300;
const MINUTE = 60_000;
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

function useProviderClock(): void {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true, advanceTimeDelta: 5 });
}

function connect(options: Partial<AntigravityConnectionOptions> = {}): AntigravityAcpConnection {
	return new AntigravityAcpConnection({
		cwd: path.dirname(fakeAgent),
		command: process.execPath,
		args: [fakeAgent],
		...options,
	});
}

async function openSession(connection: AntigravityAcpConnection): Promise<string> {
	await connection.initialize();
	return (await connection.newSession(process.cwd())).sessionId;
}

function promptText(connection: AntigravityAcpConnection, sessionId: string, text: string, signal?: AbortSignal) {
	return connection.prompt({ sessionId, prompt: [{ type: "text", text }] }, signal);
}

/** Settles with the prompt's outcome, or "still pending" if it has not settled within `ms` real time. */
async function outcomeWithin(pending: Promise<unknown>, ms: number): Promise<unknown> {
	const started = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const sentinel = new Promise<string>((resolve) => {
		timer = realSetTimeout(() => resolve("still pending"), ms);
	});
	try {
		const outcome = await Promise.race([pending.then((value) => ({ value }), (error: unknown) => ({ error })), sentinel]);
		return typeof outcome === "string" ? outcome : { ...outcome, elapsed: Date.now() - started };
	} finally {
		realClearTimeout(timer);
	}
}

const sleep = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms));

afterEach(() => {
	vi.useRealTimers();
});

describe("session/prompt progress watchdog (connection)", () => {
	it("completes a prompt that keeps streaming for far longer than the old 10-minute deadline", async () => {
		useProviderClock();
		const chunks: string[] = [];
		// Default idle limit (10 min): every chunk arrives four minutes after the previous one.
		const connection = connect({
			handlers: {
				onUpdate: (notification) => {
					if (notification.update.sessionUpdate !== "agent_message_chunk") return;
					const content = notification.update.content;
					if (content.type === "text") chunks.push(content.text);
					vi.advanceTimersByTime(4 * MINUTE);
				},
			},
		});
		try {
			const sessionId = await openSession(connection);
			const response = await promptText(connection, sessionId, "stream slow");
			expect(response.stopReason).toBe("end_turn");
			expect(chunks).toHaveLength(12);
			expect(connection.process.alive).toBe(true);
		} finally {
			vi.useRealTimers();
			await connection.close();
		}
	});

	it("does not time out while a native tool call is open and silent", async () => {
		useProviderClock();
		const updates: string[] = [];
		const connection = connect({
			promptIdleTimeoutMs: IDLE_MS,
			handlers: {
				onUpdate: (notification) => {
					updates.push(notification.update.sessionUpdate);
					// A long silent shell command: 30 minutes pass before Antigravity reports again.
					if (notification.update.sessionUpdate === "tool_call") vi.advanceTimersByTime(30 * MINUTE);
				},
			},
		});
		try {
			const sessionId = await openSession(connection);
			// The fake agent also keeps the call open for 800 ms of real time (> IDLE_MS).
			const response = await promptText(connection, sessionId, "native slow");
			expect(response.stopReason).toBe("end_turn");
			expect(updates).toEqual(["tool_call", "tool_call_update", "agent_message_chunk"]);
		} finally {
			vi.useRealTimers();
			await connection.close();
		}
	});

	it("does not time out while a native tool call first seen through tool_call_update is open", async () => {
		useProviderClock();
		const statuses: string[] = [];
		const connection = connect({
			promptIdleTimeoutMs: IDLE_MS,
			handlers: {
				onUpdate: (notification) => {
					const update = notification.update;
					if (update.sessionUpdate !== "tool_call_update") return;
					statuses.push(update.status ?? "none");
					// No tool_call ever arrives; the open call is silent for 30 minutes.
					if (update.status === "in_progress") vi.advanceTimersByTime(30 * MINUTE);
				},
			},
		});
		try {
			const sessionId = await openSession(connection);
			// The fake agent also keeps the call open for 800 ms of real time (> IDLE_MS).
			const response = await promptText(connection, sessionId, "update first");
			expect(response.stopReason).toBe("end_turn");
			expect(statuses).toEqual(["in_progress", "completed"]);
			expect(connection.process.alive).toBe(true);
		} finally {
			vi.useRealTimers();
			await connection.close();
		}
	});

	it("does not time out while a permission request is pending", async () => {
		useProviderClock();
		const connection = connect({
			promptIdleTimeoutMs: IDLE_MS,
			handlers: {
				onPermission: async () => {
					vi.advanceTimersByTime(30 * MINUTE);
					await sleep(IDLE_MS * 2);
					return { outcome: { outcome: "selected", optionId: "allow-once" } };
				},
			},
		});
		try {
			const sessionId = await openSession(connection);
			const response = await promptText(connection, sessionId, "permission");
			expect(response.stopReason).toBe("end_turn");
		} finally {
			vi.useRealTimers();
			await connection.close();
		}
	});

	it("times out a genuinely silent prompt after the idle limit and closes the connection", async () => {
		const connection = connect({ promptIdleTimeoutMs: IDLE_MS });
		try {
			const sessionId = await openSession(connection);
			const outcome = await outcomeWithin(promptText(connection, sessionId, "hang"), 3_000);
			expect(outcome).toMatchObject({ error: expect.any(AntigravityAcpError) });
			const { error, elapsed } = outcome as { error: AntigravityAcpError; elapsed: number };
			expect(error.code).toBe("timeout");
			expect(error.message).toBe(`Antigravity ACP session/prompt timed out: no progress for ${IDLE_MS}ms`);
			expect(elapsed).toBeGreaterThanOrEqual(IDLE_MS - 20);
			expect(elapsed).toBeLessThan(IDLE_MS + 1_500);
			await connection.process.exited;
			expect(connection.process.alive).toBe(false);
		} finally {
			await connection.close();
		}
	});

	it("still cancels on abort during a long prompt with an open native tool call", async () => {
		useProviderClock();
		const connection = connect({
			promptIdleTimeoutMs: IDLE_MS,
			handlers: {
				onUpdate: (notification) => {
					if (notification.update.sessionUpdate === "tool_call") vi.advanceTimersByTime(30 * MINUTE);
				},
			},
		});
		try {
			const sessionId = await openSession(connection);
			const controller = new AbortController();
			const pending = promptText(connection, sessionId, "tool hang", controller.signal);
			await sleep(IDLE_MS * 2);
			controller.abort();
			const outcome = await outcomeWithin(pending, 3_000);
			expect(outcome).toMatchObject({ error: { code: "aborted" } });
			// The agent answered session/cancel within the grace period, so the warm process survives.
			expect(connection.process.alive).toBe(true);
		} finally {
			vi.useRealTimers();
			await connection.close();
		}
	});

	it("carries no open tool call from a finished prompt into the next one", async () => {
		const connection = connect({ promptIdleTimeoutMs: IDLE_MS });
		try {
			const sessionId = await openSession(connection);
			// The first turn ends while its reported tool call never reached a terminal status.
			await expect(promptText(connection, sessionId, "tool leak")).resolves.toMatchObject({ stopReason: "end_turn" });
			// A stale hold left by a parked call that outlived its prompt must not suspend the next one.
			const staleRelease = connection.holdPromptWatchdog(sessionId);
			const outcome = await outcomeWithin(promptText(connection, sessionId, "hang"), 3_000);
			staleRelease();
			expect(outcome).toMatchObject({ error: { code: "timeout" } });
		} finally {
			await connection.close();
		}
	});
});

describe("bridged Pi tool calls under the progress watchdog (runtime)", () => {
	function runtimeWithIdle(idleMs: number | undefined = IDLE_MS): AntigravityRuntime {
		return new AntigravityRuntime(
			(options) =>
				new AntigravityAcpConnection({
					...options,
					command: process.execPath,
					args: [fakeAgent],
					...(idleMs === undefined ? {} : { promptIdleTimeoutMs: idleMs }),
				}),
		);
	}

	async function parkBridgedCall(runtime: AntigravityRuntime, sessionId: string, text = "use bridge") {
		const firstContext: Context = { tools, messages: [{ role: "user", content: text, timestamp: 1 }] };
		const first = runtime.stream(model, normalizeContext(firstContext), { sessionId, apiKey: "test-key" });
		const events = [];
		for await (const event of first.stream) events.push(event);
		const done = events.at(-1);
		if (done?.type !== "done") throw new Error("missing bridged tool turn");
		const call = done.message.content.find((block) => block.type === "toolCall");
		if (!call || call.type !== "toolCall") throw new Error("missing bridged tool call");
		const messages = [
			...firstContext.messages,
			done.message,
			{
				role: "toolResult" as const,
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text" as const, text: "echo result" }],
				isError: false,
				timestamp: 2,
			},
		];
		return { messages };
	}

	async function deliver(runtime: AntigravityRuntime, sessionId: string, messages: Context["messages"]) {
		const second = runtime.stream(model, normalizeContext({ tools, messages }), { sessionId, apiKey: "test-key" });
		const events = [];
		for await (const event of second.stream) events.push(event);
		return { writer: second, last: events.at(-1) };
	}

	// Every case also waits twice IDLE_MS of real time while parked. Without the runtime's explicit
	// hold the watchdog would fire then, because plain "use bridge" reports no tool_call.
	it.each([
		["the default 10-minute idle limit", undefined, 10 * MINUTE + 1_000],
		["the former 120 s tool timeout", IDLE_MS, 3 * MINUTE],
		["the former 10-minute prompt deadline", IDLE_MS, 30 * MINUTE],
	])("delivers a bridged call parked longer than %s", async (_label, idleMs, jump) => {
		useProviderClock();
		const runtime = runtimeWithIdle(idleMs);
		try {
			const { messages } = await parkBridgedCall(runtime, `parked-${jump}`);
			// Pi executes the tool: Antigravity sends nothing while the call is parked.
			vi.advanceTimersByTime(jump);
			await sleep(IDLE_MS * 2);
			const { writer, last } = await deliver(runtime, `parked-${jump}`, messages);
			expect(last?.type).toBe("done");
			// The fake agent echoes exactly the MCP result it received for its parked call.
			expect(writer.message.content).toEqual([{ type: "text", text: "echo result" }]);
		} finally {
			vi.useRealTimers();
			await runtime.close();
		}
	});

	it("reuses a warm binding without leftover holds or open tool calls", async () => {
		const runtime = runtimeWithIdle();
		try {
			const { messages } = await parkBridgedCall(runtime, "warm", "use bridge leaky");
			const { writer, last } = await deliver(runtime, "warm", messages);
			expect(last?.type).toBe("done");
			const follow = runtime.stream(
				model,
				normalizeContext({
					tools,
					messages: [...messages, writer.message, { role: "user", content: "hang", timestamp: 3 }],
				}),
				{ sessionId: "warm", apiKey: "test-key" },
			);
			const collected: Array<{ type: string }> = [];
			const drained = (async () => {
				for await (const event of follow.stream) collected.push(event);
			})();
			expect(await outcomeWithin(drained, 3_000)).not.toBe("still pending");
			expect(collected.at(-1)).toMatchObject({ type: "error", reason: "error" });
			expect(follow.message.errorMessage).toContain(`session/prompt timed out: no progress for ${IDLE_MS}ms`);
		} finally {
			await runtime.close();
		}
	});
});
