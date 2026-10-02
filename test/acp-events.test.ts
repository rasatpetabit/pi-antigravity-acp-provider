import type { SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { mapSessionUpdate } from "../src/acp/events.js";

function notification(update: Record<string, unknown>): SessionNotification {
	return { sessionId: "s1", update } as unknown as SessionNotification;
}

describe("mapSessionUpdate", () => {
	it("renders no Antigravity tool notifications, bridged or native, in any status", () => {
		const updates = [
			{ sessionUpdate: "tool_call", toolCallId: "t1", title: "Running pi_read", status: "in_progress" },
			{ sessionUpdate: "tool_call", toolCallId: "t2", title: "ssh host 'sudo restic list locks'", status: "in_progress", kind: "execute" },
			{ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed" },
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "t3",
				status: "failed",
				content: [{ type: "content", content: { type: "text", text: "exit 1" } }],
			},
			{ sessionUpdate: "tool_call_update", toolCallId: "t4", status: "completed", content: [{ type: "diff", path: "/tmp/a", newText: "b" }] },
		];
		for (const update of updates) expect(mapSessionUpdate(notification(update))).toEqual([]);
	});

	it("still maps text, thought and plan", () => {
		expect(mapSessionUpdate(notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }))).toEqual([
			{ type: "text", delta: "hi" },
		]);
		expect(mapSessionUpdate(notification({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } }))).toEqual([
			{ type: "thought", delta: "hm" },
		]);
		expect(
			mapSessionUpdate(notification({ sessionUpdate: "plan", entries: [{ content: "step", status: "pending", priority: "medium" }] })),
		).toEqual([{ type: "plan", text: "\n[Antigravity plan]\n- [pending] step\n" }]);
	});
});
