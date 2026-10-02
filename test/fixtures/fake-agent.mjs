import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import readline from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const scenario = process.argv[2];
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let model = "auto";
let mode = scenario === "starts-yolo" ? "yolo" : "default";
let permissionPromptId;
let hangingPromptId;
let bridgePromptId;
let mcpServer;
// Set when session/cancel arrives while a permission request is outstanding: as ACP requires, the
// turn ends with stopReason "cancelled" once the client answers that request.
let permissionCancelRequested = false;
let cancellablePermission = false;
// A prompt that makes one more bridged MCP call after session/cancel, then reports cancelled.
let lateCallPromptId;
// A prompt that requests one more permission after session/cancel, then reports cancelled.
let latePermissionPromptId;
// Opt-in observation log for tests: one JSON line per ACP request the fake agent received.
const logFile = process.env.FAKE_AGENT_LOG;
const log = (entry) => {
	if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
};
const advertisedModes = (restoring) =>
	scenario === "no-default-mode" || (restoring && scenario === "no-default-mode-on-restore")
		? [{ id: "yolo", name: "YOLO" }]
		: [
				{ id: "default", name: "Default" },
				...(scenario === "no-auto-edit-mode" ? [] : [{ id: "auto_edit", name: "Auto Edit" }]),
				{ id: "yolo", name: "YOLO" },
			];

for await (const line of rl) {
	if (!line.trim()) continue;
	const message = JSON.parse(line);
	if (!("id" in message)) {
		if (message.method === "session/cancel" && hangingPromptId !== undefined) {
			send({ jsonrpc: "2.0", id: hangingPromptId, result: { stopReason: "cancelled" } });
			hangingPromptId = undefined;
		}
		if (message.method === "session/cancel" && bridgePromptId !== undefined) {
			send({ jsonrpc: "2.0", id: bridgePromptId, result: { stopReason: "cancelled" } });
			bridgePromptId = undefined;
		}
		if (message.method === "session/cancel" && permissionPromptId !== undefined && cancellablePermission) {
			permissionCancelRequested = true;
		}
		if (message.method === "session/cancel" && latePermissionPromptId !== undefined) {
			// One more permission request after session/cancel; the turn ends once it is answered.
			permissionPromptId = latePermissionPromptId;
			latePermissionPromptId = undefined;
			permissionCancelRequested = true;
			send({
				jsonrpc: "2.0",
				id: "permission-1",
				method: "session/request_permission",
				params: {
					sessionId: message.params.sessionId,
					toolCall: { toolCallId: "native-tool-late", title: "Run native command", kind: "execute" },
					options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
				},
			});
		}
		if (message.method === "session/cancel" && lateCallPromptId !== undefined) {
			const promptId = lateCallPromptId;
			lateCallPromptId = undefined;
			void invokeMcpTool(mcpServer, "after cancel")
				.catch(() => undefined)
				.then(() => send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } }));
		}
		continue;
	}
	const { id, method, params } = message;
	if (method && logFile) {
		const entry = { method };
		if (method === "session/set_mode") entry.modeId = params.modeId;
		if (method === "session/prompt") {
			entry.prompt = params.prompt;
			entry.mode = mode;
		}
		if (method === "session/new" || method === "session/resume" || method === "session/load") {
			const server = params.mcpServers?.find((candidate) => candidate.type === "http");
			entry.mcpTools = server ? await listMcpTools(server) : [];
		}
		log(entry);
	}
	if (id === "permission-1" && method === undefined && permissionPromptId !== undefined) {
		const decision = message.result?.outcome?.outcome ?? "cancelled";
		log({ event: "permission-answer", decision });
		if (permissionCancelRequested) {
			send({ jsonrpc: "2.0", id: permissionPromptId, result: { stopReason: "cancelled" } });
			permissionPromptId = undefined;
			permissionCancelRequested = false;
			continue;
		}
		send({
			jsonrpc: "2.0",
			method: "session/update",
			params: {
				sessionId: "fake-session",
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Decision: ${decision}` } },
			},
		});
		send({ jsonrpc: "2.0", id: permissionPromptId, result: { stopReason: "end_turn" } });
		permissionPromptId = undefined;
	} else if (method === "initialize") {
		if (scenario === "initialize-timeout") continue;
		if (scenario === "malformed-output") {
			process.stdout.write("not-json\n");
			continue;
		}
		if (scenario === "browser-noise") {
			process.stdout.write("Opening in existing browser session.\n");
		}
		send({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: 1,
				agentInfo: { name: "fake-gemini", version: "1.0.0" },
				authMethods: [
					{ id: "oauth-personal", name: "Log in with Google" },
					{ id: "api", name: "Gemini API key", _meta: { "api-key": { provider: "google" } } },
				],
				agentCapabilities: {
					loadSession: true,
					promptCapabilities: { image: true, embeddedContext: true },
					mcpCapabilities: { http: true },
					sessionCapabilities: { resume: {} },
				},
			},
		});
		if (scenario === "exit-after-initialize") {
			setTimeout(() => process.exit(0), 10);
		}
	} else if (method === "authenticate") {
		if (scenario === "headless-auth") {
			const state = "fake-oauth-state";
			const server = http.createServer((request, response) => {
				const callback = new URL(request.url ?? "/", "http://127.0.0.1");
				if (callback.searchParams.get("state") !== state || !callback.searchParams.get("code")) {
					response.writeHead(400).end("Invalid callback");
					return;
				}
				response.writeHead(200).end("Authenticated");
				server.close();
				send({ jsonrpc: "2.0", id, result: {} });
			});
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("missing fake OAuth address");
				const redirect = `http://127.0.0.1:${address.port}/`;
				const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
				authorization.searchParams.set("redirect_uri", redirect);
				authorization.searchParams.set("state", state);
				const browser = process.env.BROWSER;
				if (!browser) throw new Error("missing BROWSER capture command");
				const child = spawn(browser, [authorization.toString()], { env: process.env, stdio: "ignore" });
				child.once("error", (error) => {
					server.close();
					send({ jsonrpc: "2.0", id, error: { code: -32603, message: error.message } });
				});
			});
			continue;
		}
		send({ jsonrpc: "2.0", id, result: {} });
	} else if (method === "session/new") {
		if (scenario === "session-timeout") continue;
		if (scenario === "internal-error") {
			send({
				jsonrpc: "2.0",
				id,
				error: {
					code: -32603,
					message: "Internal error",
					data: { details: "Permission denied: localharness_external; api_key=AIza1234567890abcdefghijkl" },
				},
			});
			continue;
		}
		mcpServer = params.mcpServers?.find((server) => server.type === "http");
		send({
			jsonrpc: "2.0",
			id,
			result: {
				sessionId: "fake-session",
				modes: { currentModeId: mode, availableModes: advertisedModes(false) },
				models: {
					currentModelId: model,
					availableModels: [
						{ modelId: "auto", name: "Auto" },
						{ modelId: "gemini-test", name: "Gemini Test" },
					],
				},
			},
		});
	} else if (method === "session/resume" || method === "session/load") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				modes: { currentModeId: mode, availableModes: advertisedModes(true) },
				models: { currentModelId: model, availableModels: [] },
			},
		});
	} else if (method === "session/set_model") {
		model = params.modelId;
		send({ jsonrpc: "2.0", id, result: {} });
	} else if (method === "session/set_mode") {
		if (scenario === "set-mode-fails" && params.modeId !== "default") {
			send({ jsonrpc: "2.0", id, error: { code: -32603, message: "set_mode failed" } });
			continue;
		}
		mode = params.modeId;
		send({ jsonrpc: "2.0", id, result: {} });
	} else if (method === "session/prompt") {
		const text = params.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		if (text.includes("late permission")) {
			latePermissionPromptId = id;
			continue;
		}
		if (text.includes("late call") && mcpServer) {
			// Silent until session/cancel, which it answers with one more bridged call first.
			lateCallPromptId = id;
			continue;
		}
		if (text.includes("orphan call") && mcpServer) {
			// Ends the turn while its bridged call is still parked in Pi: no turn is in flight when
			// Pi later returns that call's result.
			void invokeMcpTool(mcpServer, "orphan").catch(() => undefined);
			void sleep(300).then(() => send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));
			continue;
		}
		if (text.includes("bridge") && mcpServer) {
			bridgePromptId = id;
			if (text.includes("leaky")) {
				// A tool call that never reaches a terminal status before the prompt ends.
				sendUpdate(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "leaked-1", title: "Running pi_echo", status: "in_progress" });
			}
			if (text.includes("noisy")) {
				// Tool status notifications as Antigravity sends them around a bridged MCP call and native tools.
				const notes = [
					{ sessionUpdate: "tool_call", toolCallId: "bridged-1", title: "Running pi_echo", status: "in_progress" },
					{ sessionUpdate: "tool_call", toolCallId: "native-1", title: "grep pi_echo src", status: "in_progress", kind: "search" },
					{ sessionUpdate: "tool_call_update", toolCallId: "native-1", status: "completed" },
					{ sessionUpdate: "tool_call_update", toolCallId: "bridged-1", status: "failed", content: [{ type: "content", content: { type: "text", text: "BRIDGED_DETAIL" } }] },
					{ sessionUpdate: "tool_call", toolCallId: "native-2", title: "false", status: "in_progress", kind: "execute" },
					{ sessionUpdate: "tool_call_update", toolCallId: "native-2", status: "failed", content: [{ type: "content", content: { type: "text", text: "NATIVE_FAILURE" } }] },
				];
				for (const update of notes) {
					send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update } });
				}
			}
			const invocation = text.includes("parallel")
				? Promise.all([
						invokeMcpTool(mcpServer, "first"),
						new Promise((resolve) => setTimeout(resolve, 50)).then(() => invokeMcpTool(mcpServer, "second")),
					]).then((results) => results.join(","))
				: invokeMcpTool(mcpServer, "from gemini");
			const chained = text.includes("twice")
				? // A second bridged call made only after the first one's result arrived.
					invocation.then((first) => (bridgePromptId === id ? invokeMcpTool(mcpServer, "second call") : first))
				: invocation;
			void chained.then(async (result) => {
				if (text.includes("bridge delayed")) await new Promise((resolve) => setTimeout(resolve, 500));
				if (bridgePromptId !== id) return;
				bridgePromptId = undefined;
				send({
					jsonrpc: "2.0",
					method: "session/update",
					params: {
						sessionId: params.sessionId,
						update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: result } },
					},
				});
				send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
			});
			continue;
		}
		if (text.includes("stream slow")) {
			// Keeps making progress: one chunk every 50 ms, twelve chunks, then the end of the turn.
			void (async () => {
				for (let index = 0; index < 12; index += 1) {
					await sleep(50);
					sendUpdate(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${index},` } });
				}
				send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
			})();
			continue;
		}
		if (text.includes("native slow")) {
			// A silent native command: open for 800 ms with no other update, then completed.
			sendUpdate(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "native-slow", title: "sleep", status: "in_progress", kind: "execute" });
			void sleep(800).then(() => {
				sendUpdate(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "native-slow", status: "completed" });
				sendUpdate(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "native done" } });
				send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
			});
			continue;
		}
		if (text.includes("update first")) {
			// A native tool call first seen through tool_call_update (never a tool_call): open and
			// silent for 800 ms, then completed and the turn ends.
			sendUpdate(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "native-late", status: "in_progress" });
			void sleep(800).then(() => {
				sendUpdate(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "native-late", status: "completed" });
				sendUpdate(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late done" } });
				send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
			});
			continue;
		}
		if (text.includes("tool hang")) {
			// A native command that never finishes; only session/cancel ends the prompt.
			hangingPromptId = id;
			sendUpdate(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "native-hang", title: "sleep", status: "in_progress", kind: "execute" });
			continue;
		}
		if (text.includes("tool leak")) {
			// The turn ends while a reported tool call never reached a terminal status.
			sendUpdate(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "native-leak", title: "sleep", status: "in_progress", kind: "execute" });
			send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
			continue;
		}
		if (text.includes("hang")) {
			hangingPromptId = id;
			continue;
		}
		if (text.includes("permission")) {
			permissionPromptId = id;
			cancellablePermission = text.includes("cancellable");
			send({
				jsonrpc: "2.0",
				id: "permission-1",
				method: "session/request_permission",
				params: {
					sessionId: params.sessionId,
					toolCall: { toolCallId: "native-tool-1", title: "Run native command", kind: "execute" },
					options: [
						{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
						{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
					],
				},
			});
			continue;
		}
		send({
			jsonrpc: "2.0",
			method: "session/update",
			params: {
				sessionId: params.sessionId,
				update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking" } },
			},
		});
		send({
			jsonrpc: "2.0",
			method: "session/update",
			params: {
				sessionId: params.sessionId,
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } },
			},
		});
		send({
			jsonrpc: "2.0",
			id,
			result: {
				stopReason: "end_turn",
				_meta: { quota: { token_count: { input_tokens: 7, output_tokens: 3 }, model_usage: [] } },
			},
		});
	} else {
		send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } });
	}
}

function sendUpdate(sessionId, update) {
	send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listMcpTools(server) {
	const headers = Object.fromEntries(server.headers.map((header) => [header.name, header.value]));
	const client = new Client({ name: "fake-gemini", version: "1" }, { capabilities: {} });
	const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } });
	try {
		await client.connect(transport);
		return (await client.listTools()).tools.map((tool) => tool.name).sort();
	} finally {
		await client.close();
	}
}

async function invokeMcpTool(server, text) {
	const headers = Object.fromEntries(server.headers.map((header) => [header.name, header.value]));
	const client = new Client({ name: "fake-gemini", version: "1" }, { capabilities: {} });
	const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } });
	try {
		await client.connect(transport);
		const result = await client.callTool({ name: "pi_echo", arguments: { text } }).catch((error) => {
			log({ event: "mcp-call", arguments: text, threw: String(error?.message ?? error) });
			throw error;
		});
		const output = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		log({ event: "mcp-call", arguments: text, isError: result.isError === true, text: output });
		return output;
	} finally {
		await client.close();
	}
}
