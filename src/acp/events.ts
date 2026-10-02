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
export interface ToolActivityContext {
	/** MCP-side names of the projected Pi tools (for example `pi_read`). */
	bridgedToolNames: ReadonlySet<string>;
	/** toolCallIds classified as bridged when their tool_call arrived; updated by this mapper. */
	bridgedCallIds: Set<string>;
}

export function mapSessionUpdate(
	notification: SessionNotification,
	context: ToolActivityContext = { bridgedToolNames: EMPTY_NAMES, bridgedCallIds: new Set() },
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
			if (isBridgedTitle(update.title, context.bridgedToolNames)) {
				context.bridgedCallIds.add(update.toolCallId);
				return [];
			}
			return [{ type: "tool", text: `\n[Antigravity: ${clean(update.title).slice(0, TITLE_LIMIT)}]\n` }];
		}
		case "tool_call_update": {
			// Identity comes from the tool_call that started this call, not from an optional title.
			if (context.bridgedCallIds.has(update.toolCallId)) {
				if (update.status === "completed" || update.status === "failed") context.bridgedCallIds.delete(update.toolCallId);
				return [];
			}
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

/**
 * True only when the whole title names a projected Pi tool, as Antigravity titles MCP calls
 * ("Running pi_read", or the bare name). A native command that merely mentions a tool name,
 * such as "grep pi_read src", is not a bridged call.
 */
function isBridgedTitle(title: string, bridgedToolNames: ReadonlySet<string>): boolean {
	if (bridgedToolNames.size === 0) return false;
	const match = /^(?:Running\s+)?([A-Za-z0-9_-]+)$/u.exec(title.trim());
	return match !== null && bridgedToolNames.has(match[1]!);
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
