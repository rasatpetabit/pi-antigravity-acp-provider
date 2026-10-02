import type { SessionNotification } from "@agentclientprotocol/sdk";

export type AcpActivity =
	| { type: "text"; delta: string }
	| { type: "thought"; delta: string }
	| { type: "tool"; text: string }
	| { type: "plan"; text: string }
	| { type: "unknown"; updateType: string };

/**
 * Map one ACP session notification to Pi activity.
 *
 * Tool notifications are kept quiet on purpose: a call to a bridged Pi tool already renders as a
 * genuine Pi tool card, so its Antigravity-side status line is dropped; a native Antigravity tool
 * gets exactly one compact line when it starts; progress updates surface only when they fail or
 * report a file edit.
 */
export function mapSessionUpdate(
	notification: SessionNotification,
	bridgedToolNames: ReadonlySet<string> = EMPTY_NAMES,
): AcpActivity[] {
	const update = notification.update;
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
			return update.content.type === "text"
				? [{ type: "text", delta: update.content.text }]
				: [{ type: "unknown", updateType: `agent_message:${update.content.type}` }];
		case "agent_thought_chunk":
			return update.content.type === "text"
				? [{ type: "thought", delta: update.content.text }]
				: [{ type: "unknown", updateType: `agent_thought:${update.content.type}` }];
		case "tool_call": {
			if (mentionsBridgedTool(update.title, bridgedToolNames)) return [];
			return [{ type: "tool", text: `\n[Antigravity: ${clean(update.title).slice(0, TITLE_LIMIT)}]\n` }];
		}
		case "tool_call_update": {
			if (update.title && mentionsBridgedTool(update.title, bridgedToolNames)) return [];
			const label = clean(update.title ?? update.toolCallId).slice(0, TITLE_LIMIT);
			if (update.status === "failed") {
				const details = toolContentText(update.content);
				return [{ type: "tool", text: `\n[Antigravity tool failed: ${label}]${details ? `\n${details}\n` : "\n"}` }];
			}
			const edited = editedPaths(update.content);
			if (edited.length) return [{ type: "tool", text: `\n[Antigravity edited: ${edited.join(", ")}]\n` }];
			return [];
		}
		case "plan": {
			const lines = update.entries.map((entry) => `- [${entry.status}] ${clean(entry.content)}`);
			return lines.length ? [{ type: "plan", text: `\n[Antigravity plan]\n${lines.join("\n")}\n` }] : [];
		}
		default:
			return [{ type: "unknown", updateType: update.sessionUpdate }];
	}
}

function toolContentText(content: SessionNotification["update"] extends infer _T ? unknown : never): string {
	if (!Array.isArray(content)) return "";
	const output: string[] = [];
	for (const item of content.slice(0, 8)) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (record.type === "diff") {
			const path = typeof record.path === "string" ? clean(record.path) : "file";
			output.push(`[diff: ${path}]`);
		} else if (record.type === "content") {
			const block = record.content as Record<string, unknown> | undefined;
			if (block?.type === "text" && typeof block.text === "string") {
				output.push(clean(block.text).slice(0, 2_000));
			}
		}
	}
	return output.join("\n").slice(0, 4_000);
}

const EMPTY_NAMES: ReadonlySet<string> = new Set();
const TITLE_LIMIT = 200;

/** True when the title names a tool the Pi MCP bridge projected (for example "Running pi_read"). */
function mentionsBridgedTool(title: string, bridgedToolNames: ReadonlySet<string>): boolean {
	if (bridgedToolNames.size === 0) return false;
	return title.split(/[^A-Za-z0-9_-]+/u).some((token) => bridgedToolNames.has(token));
}

function editedPaths(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const paths: string[] = [];
	for (const item of content.slice(0, 8)) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (record.type === "diff") paths.push(typeof record.path === "string" ? clean(record.path) : "file");
	}
	return paths;
}

function clean(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").slice(0, 2_000);
}
