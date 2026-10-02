import {
	type AgentEvent,
	type AgentLoopConfig,
	type AgentMessage,
	type AgentTool,
	runAgentLoop,
} from "@earendil-works/pi-agent-core";
import {
	createInitialSystemMessage,
	getCurrentTools,
	type Message,
	type Model,
	normalizeContext,
	type TranscriptContext,
	type Tool,
	toToolDeclaration,
} from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { AcpSessionStore, SESSION_RECORD_SCHEMA_VERSION } from "../src/acp/session-store.js";
import { loadConfig, migrateLegacyConfig } from "../src/config.js";
import { PERMISSION_TOOL_NAME } from "../src/constants.js";
import { planToolProjection } from "../src/mcp/bridge.js";
import { AntigravityRuntime, toJsonObject } from "../src/runtime.js";
import { buildPromptParts } from "../src/stream/context.js";
import { usageFromPrompt } from "../src/stream/usage.js";

const PI_HOST = process.env.PI_HOST_ROOT ?? "/srv/pi/releases/6d50b272";
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
const BASE_PROMPT = "BASE-PROMPT-7f3a: follow the house rules.";

const directories: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-host099-"));
	directories.push(directory);
	return directory;
}

interface LogEntry {
	pid: number;
	method: string;
	modeId?: string;
	mode?: string;
	mcpTools?: string[];
	prompt?: Array<{ type: string; text?: string; resource?: { text?: string } }>;
}

function fakeRuntime(scenario?: string, store?: AcpSessionStore) {
	const log = path.join(temporaryDirectory(), "agent.log");
	const runtime = new AntigravityRuntime(
		(options) =>
			new AntigravityAcpConnection({
				...options,
				command: process.execPath,
				args: scenario ? [fakeAgent, scenario] : [fakeAgent],
				env: { ...process.env, FAKE_AGENT_LOG: log },
			}),
		"default",
		store,
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

function promptText(entry: LogEntry): string {
	return (entry.prompt ?? []).map((block) => block.resource?.text ?? block.text ?? "").join("\n");
}

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

function agentTool(name: string, description = `${name} tool`): AgentTool {
	return {
		name,
		label: name,
		description,
		parameters: Type.Object({ text: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
	};
}

type TurnState = { messages: AgentMessage[]; requests: TranscriptContext[] };
type TurnHooks = Pick<AgentLoopConfig, "beforeToolCall" | "afterToolCall"> & {
	onEvent?: (event: AgentEvent) => void;
};

/**
 * Drive one Pi turn through the host agent loop, which runs the real declareToolChanges and,
 * for a bridged call, the real tool validation, hooks and execution. Returns the messages added.
 */
async function piTurnMessages(
	runtime: AntigravityRuntime,
	state: TurnState,
	tools: AgentTool[],
	prompts: Message[],
	hooks: TurnHooks = {},
): Promise<AgentMessage[]> {
	const { onEvent, ...toolHooks } = hooks;
	const added = await runAgentLoop(
		prompts,
		{ messages: state.messages, tools },
		{ model, convertToLlm: (messages) => messages as Message[], ...toolHooks },
		async (event) => onEvent?.(event),
		undefined,
		(streamModel, context, options) => {
			state.requests.push(context);
			return runtime.stream(streamModel as Model<"antigravity-acp">, context, {
				...options,
				sessionId: "host-099",
				apiKey: "test-key",
			}).stream;
		},
	);
	state.messages.push(...added);
	return added;
}

async function piTurn(
	runtime: AntigravityRuntime,
	state: TurnState,
	tools: AgentTool[],
	prompts: Message[],
	hooks: TurnHooks = {},
): Promise<AgentMessage[]> {
	const added = await piTurnMessages(runtime, state, tools, prompts, hooks);
	const last = added.at(-1);
	if (last?.role !== "assistant" || last.stopReason !== "stop") {
		throw new Error(`turn did not complete: ${JSON.stringify(last && "errorMessage" in last ? last.errorMessage : last)}`);
	}
	return added;
}

function lastError(added: AgentMessage[]): string | undefined {
	const last = added.at(-1);
	return last?.role === "assistant" && last.stopReason === "error" ? last.errorMessage : undefined;
}

function initialState(tools: AgentTool[]): { messages: AgentMessage[]; requests: TranscriptContext[] } {
	const initial = createInitialSystemMessage(BASE_PROMPT, tools.map(toToolDeclaration));
	return { messages: initial ? [initial] : [], requests: [] };
}

const user = (content: string): Message => ({ role: "user", content, timestamp: Date.now() });

describe("Pi host resolution", () => {
	it("resolves @earendil-works/pi-ai to the installed Pi 0.99.2 host modules", async () => {
		const hostPackage = path.join(PI_HOST, "node_modules", "@earendil-works", "pi-ai", "package.json");
		const hostVersion = (JSON.parse(fs.readFileSync(hostPackage, "utf8")) as { version: string }).version;
		const hostCompat = (await import(
			path.join(PI_HOST, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js")
		)) as { normalizeContext: unknown };
		console.log(`resolved @earendil-works/pi-ai: ${hostPackage} version ${hostVersion}`);
		expect(hostVersion).toBe("0.99.2");
		// Identity proves the bare specifier loads the host module instance.
		expect(normalizeContext).toBe(hostCompat.normalizeContext);
	});
});

describe("system prompt and tools on the Pi 0.99 transcript", () => {
	it("renders the system prompt once, as the trusted block ahead of untrusted history", () => {
		const transcript = normalizeContext({
			systemPrompt: BASE_PROMPT,
			messages: [user("old question"), user("new question")],
		});
		const fresh = buildPromptParts(transcript, true);
		const text = fresh.prompt.map((block) => (block.type === "resource" && "text" in block.resource ? block.resource.text : "")).join("\n");
		expect(occurrences(text, BASE_PROMPT)).toBe(1);
		expect(text.indexOf(`# Pi session instructions\n\n${BASE_PROMPT}`)).toBe(0);
		const history = text.slice(text.indexOf("# Prior conversation"));
		expect(history).not.toContain(BASE_PROMPT);
		expect(history).toContain("old question");
	});

	it("sends the system prompt once and a mid-session change exactly once without respawning", async () => {
		const { runtime, entries } = fakeRuntime();
		const tools = [agentTool("echo")];
		const state = initialState(tools);
		try {
			await piTurn(runtime, state, tools, [user("turn one")]);
			await piTurn(runtime, state, tools, [
				{ role: "system", content: "EXTRA-RULE-91c2: answer tersely.", timestamp: Date.now() },
				user("turn two"),
			]);
			await piTurn(runtime, state, tools, [user("turn three")]);
		} finally {
			await runtime.close();
		}
		const log = entries();
		const prompts = log.filter((entry) => entry.method === "session/prompt").map(promptText);
		expect(prompts).toHaveLength(3);
		expect(log.filter((entry) => entry.method === "session/new")).toHaveLength(1);
		expect(prompts.map((text) => occurrences(text, BASE_PROMPT))).toEqual([1, 0, 0]);
		expect(prompts[0]).toContain("# Pi session instructions");
		expect(prompts.map((text) => occurrences(text, "EXTRA-RULE-91c2"))).toEqual([0, 1, 0]);
		expect(prompts[1]).toContain("# Pi session instruction update\n\nEXTRA-RULE-91c2");
		expect(prompts[1]).not.toMatch(/untrusted[\s\S]*EXTRA-RULE-91c2/u);
		// The captured requests are the host's own normalized transcripts.
		expect(state.requests.every((request) => request.messages[0]?.role === "system")).toBe(true);
	});

	it("keeps bridge tools equal to getCurrentTools and respawns once per real tool change", async () => {
		const { runtime, entries } = fakeRuntime();
		const echo = agentTool("echo");
		const extra = agentTool("extra");
		const redefined = agentTool("echo", "echo tool, redefined");
		const loadouts: AgentTool[][] = [
			[echo], // initial
			[echo, extra], // add
			[echo, extra], // no-op
			[echo], // remove
			[redefined], // redefine
		];
		const state = initialState(loadouts[0]!);
		const sessionsAfterTurn: number[] = [];
		const expectedTools: string[][] = [];
		try {
			for (const [index, tools] of loadouts.entries()) {
				await piTurn(runtime, state, tools, [user(`turn ${index + 1}`)]);
				const request = state.requests.at(-1)!;
				expectedTools.push(getCurrentTools(request.messages).map((tool) => `pi_${tool.name}`).sort());
				sessionsAfterTurn.push(entries().filter((entry) => entry.method === "session/new").length);
			}
		} finally {
			await runtime.close();
		}
		// Real declareToolChanges output: add, remove and redefine each insert one system delta.
		const deltas = state.messages.filter(
			(message) => message.role === "system" && (message.toolsAdded || message.toolsRemoved),
		);
		expect(deltas).toHaveLength(4);
		expect(sessionsAfterTurn).toEqual([1, 2, 2, 3, 4]);
		const sessions = entries().filter((entry) => entry.method === "session/new");
		expect(sessions.map((entry) => entry.mcpTools)).toEqual([
			expectedTools[0],
			expectedTools[1],
			expectedTools[3],
			expectedTools[4],
		]);
		expect(expectedTools).toEqual([
			["pi_echo"],
			["pi_echo", "pi_extra"],
			["pi_echo", "pi_extra"],
			["pi_echo"],
			["pi_echo"],
		]);
	});

	it("does not respawn for a system message that re-declares an unchanged tool", async () => {
		const { runtime, entries } = fakeRuntime();
		const echo: Tool = { name: "echo", description: "echo tool", parameters: Type.Object({ text: Type.String() }) };
		try {
			const first = normalizeContext({ systemPrompt: BASE_PROMPT, tools: [echo], messages: [user("one")] });
			const writer = runtime.stream(model, first, { sessionId: "noop", apiKey: "test-key" });
			for await (const _event of writer.stream) void _event;
			const second = normalizeContext({
				messages: [
					...first.messages,
					writer.message,
					{ role: "system", content: "", toolsAdded: [toToolDeclaration(echo)], timestamp: 5 },
					user("two"),
				],
			});
			const next = runtime.stream(model, second, { sessionId: "noop", apiKey: "test-key" });
			for await (const _event of next.stream) void _event;
			expect(next.message.stopReason).toBe("stop");
		} finally {
			await runtime.close();
		}
		expect(entries().filter((entry) => entry.method === "session/new")).toHaveLength(1);
		expect(entries().filter((entry) => entry.method === "session/prompt")).toHaveLength(2);
	});
});

describe("bridged tool calls through the Pi host loop", () => {
	it("executes a bridged call through runAgentLoop's real hooks and returns the result to ACP", async () => {
		const { runtime, entries } = fakeRuntime();
		const executed: unknown[] = [];
		const before: Array<{ id: string; name: string; args: unknown }> = [];
		const after: string[] = [];
		const events: string[] = [];
		const echo: AgentTool = {
			...agentTool("echo"),
			execute: async (_id, params) => {
				executed.push(params);
				return { content: [{ type: "text", text: `host-executed:${(params as { text: string }).text}` }], details: undefined };
			},
		};
		const state = initialState([echo]);
		let added: AgentMessage[];
		try {
			added = await piTurn(runtime, state, [echo], [user("use bridge")], {
				beforeToolCall: async ({ toolCall, args }) => {
					before.push({ id: toolCall.id, name: toolCall.name, args });
					return undefined;
				},
				afterToolCall: async ({ toolCall }) => {
					after.push(toolCall.id);
					return undefined;
				},
				onEvent: (event) => {
					if (event.type.startsWith("tool_execution")) events.push(event.type);
				},
			});
		} finally {
			await runtime.close();
		}
		// The host loop validated, hooked and executed the call exactly once.
		expect(before).toHaveLength(1);
		expect(before[0]).toMatchObject({ name: "echo", args: { text: "from gemini" } });
		expect(after).toEqual([before[0]!.id]);
		expect(executed).toEqual([{ text: "from gemini" }]);
		expect(events).toEqual(["tool_execution_start", "tool_execution_end"]);
		// Pi transcript: the prompt, a genuine tool call, Pi's own tool result, then the completed answer.
		expect(added.map((message) => (message.role === "assistant" ? `assistant:${message.stopReason}` : message.role))).toEqual([
			"user",
			"assistant:toolUse",
			"toolResult",
			"assistant:stop",
		]);
		const final = added.at(-1);
		if (final?.role !== "assistant") throw new Error("missing final answer");
		// The fake ACP agent echoes the MCP result it received back as its final text.
		expect(final.content).toEqual([{ type: "text", text: "host-executed:from gemini" }]);
		// One ACP session and one ACP prompt: the tool result resumed the running prompt.
		expect(entries().filter((entry) => entry.method === "session/new")).toHaveLength(1);
		expect(entries().filter((entry) => entry.method === "session/prompt")).toHaveLength(1);
		// Two provider requests: the call, then the continuation carrying Pi's tool result.
		expect(state.requests).toHaveLength(2);
	});

	it("does not execute a bridged call that the before-tool hook blocks, and ACP receives the block", async () => {
		const { runtime } = fakeRuntime();
		const executed: unknown[] = [];
		const echo: AgentTool = {
			...agentTool("echo"),
			execute: async (_id, params) => {
				executed.push(params);
				return { content: [{ type: "text", text: "should not run" }], details: undefined };
			},
		};
		const state = initialState([echo]);
		let added: AgentMessage[];
		try {
			added = await piTurn(runtime, state, [echo], [user("use bridge")], {
				beforeToolCall: async () => ({ block: true, reason: "BLOCKED-BY-HOOK" }),
			});
		} finally {
			await runtime.close();
		}
		expect(executed).toEqual([]);
		const final = added.at(-1);
		if (final?.role !== "assistant") throw new Error("missing final answer");
		expect(JSON.stringify(final.content)).toContain("BLOCKED-BY-HOOK");
	});
});

describe("usage", () => {
	it("always reports knownCost", async () => {
		expect(usageFromPrompt({ stopReason: "end_turn" }).cost.knownCost).toBe(0);
		const { runtime } = fakeRuntime();
		try {
			const writer = runtime.stream(model, normalizeContext({ messages: [user("hi")] }), { apiKey: "test-key" });
			for await (const _event of writer.stream) void _event;
			expect(writer.message.usage.cost).toMatchObject({ knownCost: 0, total: 0 });
		} finally {
			await runtime.close();
		}
	});
});

describe("permission mode negotiation", () => {
	async function streamOnce(runtime: AntigravityRuntime, sessionId: string, text = "hello") {
		const writer = runtime.stream(model, normalizeContext({ messages: [user(text)] }), {
			sessionId,
			apiKey: "test-key",
		});
		const events = [];
		for await (const event of writer.stream) events.push(event);
		return { writer, events };
	}

	it("applies 'default' with session/set_mode before the first prompt", async () => {
		const { runtime, entries } = fakeRuntime("starts-yolo");
		try {
			const { writer } = await streamOnce(runtime, "mode-applied");
			expect(writer.message.stopReason).toBe("stop");
		} finally {
			await runtime.close();
		}
		const methods = entries().map((entry) => (entry.modeId ? `${entry.method}:${entry.modeId}` : entry.method));
		expect(methods.indexOf("session/set_mode:default")).toBeGreaterThan(-1);
		expect(methods.indexOf("session/set_mode:default")).toBeLessThan(methods.indexOf("session/prompt"));
	});

	it("refuses a new session that does not advertise 'default' before any prompt", async () => {
		const { runtime, entries } = fakeRuntime("no-default-mode");
		try {
			const { events } = await streamOnce(runtime, "mode-new");
			expect(events.at(-1)).toMatchObject({
				type: "error",
				error: { errorMessage: expect.stringContaining("new session did not advertise permission mode 'default'") },
			});
		} finally {
			await runtime.close();
		}
		expect(entries().some((entry) => entry.method === "session/new")).toBe(true);
		expect(entries().some((entry) => entry.method === "session/prompt")).toBe(false);
	});

	it("refuses a restored session that does not advertise 'default' before any prompt", async () => {
		const store = new AcpSessionStore(path.join(temporaryDirectory(), "sessions.json"));
		const first = fakeRuntime(undefined, store);
		try {
			const { writer } = await streamOnce(first.runtime, "mode-restore");
			expect(writer.message.stopReason).toBe("stop");
		} finally {
			await first.runtime.close();
		}
		expect(store.get("mode-restore")?.schemaVersion).toBe(SESSION_RECORD_SCHEMA_VERSION);

		const second = fakeRuntime("no-default-mode-on-restore", store);
		try {
			const { events } = await streamOnce(second.runtime, "mode-restore", "again");
			expect(events.at(-1)).toMatchObject({
				type: "error",
				error: {
					errorMessage: expect.stringContaining("restored session did not advertise permission mode 'default'"),
				},
			});
		} finally {
			await second.runtime.close();
		}
		const log = second.entries();
		expect(log.some((entry) => entry.method === "session/resume")).toBe(true);
		expect(log.some((entry) => entry.method === "session/prompt")).toBe(false);
		expect(store.get("mode-restore")).toBeUndefined();
	});
});

describe("permission mode changes on live sessions", () => {
	async function turn(runtime: AntigravityRuntime, messages: Message[]) {
		const writer = runtime.stream(model, normalizeContext({ messages }), { sessionId: "live-mode", apiKey: "test-key" });
		for await (const _event of writer.stream) void _event;
		return writer.message;
	}

	it("applies a supported mode to the live session without respawning", async () => {
		const { runtime, entries } = fakeRuntime();
		try {
			const first = await turn(runtime, [user("one")]);
			await runtime.setPermissionMode("auto_edit");
			expect((await runtime.snapshot()).processes[0]?.permissionMode).toBe("auto_edit");
			const second = await turn(runtime, [user("one"), first, user("two")]);
			expect(second.stopReason).toBe("stop");
		} finally {
			await runtime.close();
		}
		const log = entries();
		expect(log.filter((entry) => entry.method === "session/new")).toHaveLength(1);
		expect(log.filter((entry) => entry.method === "session/prompt").map((entry) => entry.mode)).toEqual([
			"default",
			"auto_edit",
		]);
	});

	for (const scenario of ["no-auto-edit-mode", "set-mode-fails"] as const) {
		it(`closes a live session that cannot apply the new mode (${scenario}); no prompt runs in the old mode`, async () => {
			const { runtime, entries } = fakeRuntime(scenario);
			let second;
			try {
				const first = await turn(runtime, [user("one")]);
				expect(first.stopReason).toBe("stop");
				await runtime.setPermissionMode("auto_edit");
				const snapshot = await runtime.snapshot();
				// No live binding remains in a mode other than the one the caller will persist.
				expect(snapshot.permissionMode).toBe("auto_edit");
				expect(snapshot.processes.filter((process) => process.permissionMode !== "auto_edit")).toEqual([]);
				second = await turn(runtime, [user("one"), first, user("two")]);
			} finally {
				await runtime.close();
			}
			// The next turn re-negotiates through the create path, which refuses the session.
			expect(second.stopReason).toBe("error");
			expect(second.errorMessage).toMatch(
				scenario === "no-auto-edit-mode" ? /did not advertise permission mode 'auto_edit'/u : /set_mode failed/u,
			);
			const log = entries();
			expect(log.filter((entry) => entry.method === "session/new")).toHaveLength(2);
			expect(log.filter((entry) => entry.method === "session/prompt").map((entry) => entry.mode)).toEqual([
				"default",
			]);
		});
	}
});

describe("required Pi tool projection", () => {
	const objectTool = (name: string): Tool => ({
		name,
		description: name,
		parameters: Type.Object({ text: Type.String() }),
	});

	it("names every omission and its reason, and never projects the permission broker", () => {
		const fillers = Array.from({ length: 64 }, (_, index) => objectTool(`filler_${index}`));
		const plan = planToolProjection([
			objectTool(PERMISSION_TOOL_NAME),
			{ name: "ask_user_question", description: "bad", parameters: Type.String() },
			objectTool("work.flow"),
			objectTool("work_flow"),
			...fillers,
			objectTool("advisor"),
		]);
		expect(plan.projected).not.toContain(PERMISSION_TOOL_NAME);
		expect(plan.omissions.map((omission) => omission.name)).not.toContain(PERMISSION_TOOL_NAME);
		expect(plan.omissions).toEqual(
			expect.arrayContaining([
				{ name: "ask_user_question", reason: "schema must be a supported, bounded object" },
				{ name: "work_flow", reason: expect.stringContaining("collides") },
				{ name: "advisor", reason: "tool limit 64 reached" },
			]),
		);
	});

	it("refuses the session when a required tool is active but cannot be projected", async () => {
		const { runtime, entries } = fakeRuntime();
		try {
			const writer = runtime.stream(
				model,
				normalizeContext({
					tools: [
						objectTool("echo"),
						{ name: "ask_user_question", description: "bad", parameters: Type.String() },
					],
					messages: [user("hello")],
				}),
				{ apiKey: "test-key" },
			);
			const events = [];
			for await (const event of writer.stream) events.push(event);
			expect(events.at(-1)).toMatchObject({
				type: "error",
				error: {
					errorMessage: expect.stringMatching(/Required Pi tools cannot be bridged[\s\S]*ask_user_question \(schema/u),
				},
			});
		} finally {
			await runtime.close();
		}
		expect(entries().some((entry) => entry.method === "session/new")).toBe(false);
		expect(entries().some((entry) => entry.method === "session/prompt")).toBe(false);
	});

	it("reports non-required omissions in the runtime snapshot while still serving the session", async () => {
		const { runtime } = fakeRuntime();
		try {
			const writer = runtime.stream(
				model,
				normalizeContext({
					tools: [objectTool("workflow"), { name: "odd", description: "odd", parameters: Type.String() }],
					messages: [user("hello")],
				}),
				{ sessionId: "omissions", apiKey: "test-key" },
			);
			for await (const _event of writer.stream) void _event;
			expect(writer.message.stopReason).toBe("stop");
			expect((await runtime.snapshot()).processes[0]?.omittedTools).toEqual([
				{ name: "odd", reason: "schema must be a supported, bounded object" },
			]);
		} finally {
			await runtime.close();
		}
	});
});

describe("required Pi tool projection on a warm session", () => {
	const badSchemaTool = (name: string): AgentTool => ({
		...agentTool(name),
		parameters: Type.String() as unknown as AgentTool["parameters"],
	});

	it("refuses before the next prompt when an unprojectable required tool becomes active", async () => {
		const { runtime, entries } = fakeRuntime();
		const echo = agentTool("echo");
		const state = initialState([echo]);
		let added: AgentMessage[];
		try {
			await piTurn(runtime, state, [echo], [user("turn one")]);
			const loadout = [echo, badSchemaTool("ask_user_question")];
			// The projected set is unchanged; only the omission differs.
			expect(planToolProjection(loadout).projected).toEqual(["echo"]);
			added = await piTurnMessages(runtime, state, loadout, [user("turn two")]);
		} finally {
			await runtime.close();
		}
		expect(lastError(added)).toMatch(/Required Pi tools cannot be bridged[\s\S]*ask_user_question \(schema/u);
		expect(entries().filter((entry) => entry.method === "session/prompt")).toHaveLength(1);
		expect(entries().filter((entry) => entry.method === "session/new")).toHaveLength(1);
	});

	it("refuses before the next prompt when a required tool is added past the 64-tool cap", async () => {
		const { runtime, entries } = fakeRuntime();
		const fillers = Array.from({ length: 64 }, (_, index) => agentTool(`filler_${index}`));
		const state = initialState(fillers);
		let added: AgentMessage[];
		try {
			await piTurn(runtime, state, fillers, [user("turn one")]);
			const loadout = [...fillers, agentTool("advisor")];
			expect(planToolProjection(loadout).omissions).toEqual([{ name: "advisor", reason: "tool limit 64 reached" }]);
			added = await piTurnMessages(runtime, state, loadout, [user("turn two")]);
		} finally {
			await runtime.close();
		}
		expect(lastError(added)).toMatch(/Required Pi tools cannot be bridged[\s\S]*advisor \(tool limit 64 reached\)/u);
		expect(entries().filter((entry) => entry.method === "session/prompt")).toHaveLength(1);
		expect(entries().filter((entry) => entry.method === "session/new")).toHaveLength(1);
	});

	it("respawns, rather than reusing, when only a non-required omission changes", async () => {
		const { runtime, entries } = fakeRuntime();
		const echo = agentTool("echo");
		const state = initialState([echo]);
		try {
			await piTurn(runtime, state, [echo], [user("turn one")]);
			await piTurn(runtime, state, [echo, badSchemaTool("odd")], [user("turn two")]);
			expect((await runtime.snapshot()).processes[0]?.omittedTools).toEqual([
				{ name: "odd", reason: "schema must be a supported, bounded object" },
			]);
		} finally {
			await runtime.close();
		}
		expect(entries().filter((entry) => entry.method === "session/new")).toHaveLength(2);
	});
});

describe("tool argument narrowing", () => {
	it("accepts plain JSON objects and rejects non-JSON values", () => {
		const shared = { a: 1 };
		expect(toJsonObject({ text: "x", nested: [1, null, true, { deep: "y" }], one: shared, two: shared })).toEqual({
			text: "x",
			nested: [1, null, true, { deep: "y" }],
			one: { a: 1 },
			two: { a: 1 },
		});
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(toJsonObject(cyclic)).toBeUndefined();
		expect(toJsonObject({ run: () => 1 })).toBeUndefined();
		expect(toJsonObject({ missing: undefined })).toBeUndefined();
		expect(toJsonObject({ bad: Number.NaN })).toBeUndefined();
		expect(toJsonObject({ when: new Date(0) })).toBeUndefined();
		expect(toJsonObject([1, 2])).toBeUndefined();
		expect(toJsonObject("text")).toBeUndefined();
	});
});

describe("fail-closed configuration", () => {
	it("falls back to default/manual for a missing, corrupt or unknown config", () => {
		const directory = temporaryDirectory();
		const file = path.join(directory, "config.json");
		expect(loadConfig(file)).toEqual({ permissions: "default", runtimeUpdates: "manual" });
		fs.writeFileSync(file, "{ not json");
		expect(loadConfig(file)).toEqual({ permissions: "default", runtimeUpdates: "manual" });
		fs.writeFileSync(file, JSON.stringify({ permissions: "everything", runtimeUpdates: "sometimes" }));
		expect(loadConfig(file)).toEqual({ permissions: "default", runtimeUpdates: "manual" });
	});

	it("migrates a legacy yolo config to permissions=default, keeping only a valid runtimeUpdates", () => {
		const directory = temporaryDirectory();
		const legacy = path.join(directory, "gemini-acp-provider", "config.json");
		const target = path.join(directory, "antigravity-acp-provider", "config.json");
		fs.mkdirSync(path.dirname(legacy), { recursive: true });
		fs.writeFileSync(legacy, JSON.stringify({ permissions: "yolo", runtimeUpdates: "notify" }));
		migrateLegacyConfig(target, legacy);
		expect(loadConfig(target)).toEqual({ permissions: "default", runtimeUpdates: "notify" });
		expect(fs.statSync(target).mode & 0o777).toBe(0o600);
		expect(fs.readdirSync(path.dirname(target))).toEqual(["config.json"]);
		expect(JSON.parse(fs.readFileSync(legacy, "utf8"))).toEqual({ permissions: "yolo", runtimeUpdates: "notify" });

		// An existing target is never overwritten.
		fs.writeFileSync(target, JSON.stringify({ permissions: "auto_edit", runtimeUpdates: "automatic" }));
		migrateLegacyConfig(target, legacy);
		expect(loadConfig(target)).toEqual({ permissions: "auto_edit", runtimeUpdates: "automatic" });

		const invalid = path.join(directory, "other", "config.json");
		fs.writeFileSync(legacy, JSON.stringify({ permissions: "yolo", runtimeUpdates: "always" }));
		migrateLegacyConfig(invalid, legacy);
		expect(loadConfig(invalid)).toEqual({ permissions: "default", runtimeUpdates: "manual" });
	});
});

describe("runtime installation under runtimeUpdates", () => {
	async function isolatedSetup(mode: "manual" | "notify") {
		const home = temporaryDirectory();
		const empty = temporaryDirectory();
		vi.stubEnv("HOME", home);
		vi.stubEnv("PATH", empty);
		vi.stubEnv("AGY_ACP_BIN", "");
		vi.resetModules();
		const config = await import("../src/config.js");
		expect(config.CONFIG_PATH.startsWith(home)).toBe(true);
		config.saveRuntimeUpdateMode(mode);
		const setup = await import("../src/acp/setup.js");
		const fetchMock = vi.fn(async () => {
			throw new Error("network disabled in test");
		});
		vi.stubGlobal("fetch", fetchMock);
		return { home, setup, fetchMock };
	}

	for (const mode of ["manual", "notify"] as const) {
		it(`never downloads implicitly when runtimeUpdates=${mode} and no runtime is installed`, async () => {
			const { home, setup, fetchMock } = await isolatedSetup(mode);
			await expect(setup.ensureAntigravityAcpReady()).rejects.toThrow("/antigravity-acp setup");
			expect(fetchMock).not.toHaveBeenCalled();
			expect(fs.existsSync(path.join(home, ".local", "opt", "agy-acp"))).toBe(false);
		});
	}

	it("still installs through the explicit setup route under manual", async () => {
		const { setup, fetchMock } = await isolatedSetup("manual");
		await expect(setup.ensureAntigravityAcpReady(undefined, { install: true })).rejects.not.toThrow(
			"/antigravity-acp setup",
		);
		expect(fetchMock).toHaveBeenCalled();
	});
});

describe("persisted session records", () => {
	it("drops records written before the schema version and starts a new ACP session", async () => {
		const file = path.join(temporaryDirectory(), "sessions.json");
		fs.writeFileSync(
			file,
			JSON.stringify([
				{
					piSessionId: "legacy",
					acpSessionId: "fake-session",
					acpModelId: "gemini-test",
					cwd: process.cwd(),
					messageCount: 1,
					historyFingerprint: "pre-patch",
					lastActive: Date.now(),
				},
			]),
		);
		const store = new AcpSessionStore(file);
		expect(store.get("legacy")).toBeUndefined();
		const { runtime, entries } = fakeRuntime(undefined, store);
		try {
			const writer = runtime.stream(model, normalizeContext({ messages: [user("hello")] }), {
				sessionId: "legacy",
				apiKey: "test-key",
			});
			for await (const _event of writer.stream) void _event;
			expect((await runtime.snapshot()).processes[0]?.restored).toBe(false);
		} finally {
			await runtime.close();
		}
		expect(entries().some((entry) => entry.method === "session/resume" || entry.method === "session/load")).toBe(false);
		expect(entries().some((entry) => entry.method === "session/new")).toBe(true);
		expect(store.get("legacy")?.schemaVersion).toBe(SESSION_RECORD_SCHEMA_VERSION);
	});
});
