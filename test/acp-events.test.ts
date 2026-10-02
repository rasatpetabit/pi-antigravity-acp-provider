import type { SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { mapSessionUpdate } from "../src/acp/events.js";

function notification(update: Record<string, unknown>): SessionNotification {
	return { sessionId: "s1", update } as unknown as SessionNotification;
}

const bridged = new Set(["pi_read", "pi_subagent"]);

describe("mapSessionUpdate tool quieting", () => {
	it("emits one compact line for a native tool call and no status suffix", () => {
		const out = mapSessionUpdate(
			notification({ sessionUpdate: "tool_call", toolCallId: "t1", title: "git status", status: "in_progress", kind: "execute" }),
			bridged,
		);
		expect(out).toEqual([{ type: "tool", text: "\n[Antigravity: git status]\n" }]);
	});

	it("drops the Antigravity-side line for a bridged Pi tool call; Pi renders the real card", () => {
		expect(
			mapSessionUpdate(
				notification({ sessionUpdate: "tool_call", toolCallId: "t2", title: "Running pi_read", status: "in_progress" }),
				bridged,
			),
		).toEqual([]);
		expect(
			mapSessionUpdate(
				notification({ sessionUpdate: "tool_call_update", toolCallId: "t2", title: "Running pi_read", status: "completed" }),
				bridged,
			),
		).toEqual([]);
	});

	it("does not treat a native command that merely contains a similar word as bridged", () => {
		const out = mapSessionUpdate(
			notification({ sessionUpdate: "tool_call", toolCallId: "t3", title: "cat pi_readme.txt", status: "in_progress" }),
			bridged,
		);
		expect(out).toHaveLength(1);
	});

	it("drops completed and in_progress tool_call_update notifications", () => {
		for (const status of ["completed", "in_progress", "pending"]) {
			expect(
				mapSessionUpdate(notification({ sessionUpdate: "tool_call_update", toolCallId: "abc:23", status }), bridged),
			).toEqual([]);
		}
	});

	it("keeps failures, with their details", () => {
		const out = mapSessionUpdate(
			notification({
				sessionUpdate: "tool_call_update",
				toolCallId: "t4",
				title: "ssh host false",
				status: "failed",
				content: [{ type: "content", content: { type: "text", text: "exit 1" } }],
			}),
			bridged,
		);
		expect(out).toEqual([{ type: "tool", text: "\n[Antigravity tool failed: ssh host false]\nexit 1\n" }]);
	});

	it("keeps file edits as a one-line notice", () => {
		const out = mapSessionUpdate(
			notification({
				sessionUpdate: "tool_call_update",
				toolCallId: "t5",
				status: "completed",
				content: [{ type: "diff", path: "/tmp/a.txt", oldText: "a", newText: "b" }],
			}),
			bridged,
		);
		expect(out).toEqual([{ type: "tool", text: "\n[Antigravity edited: /tmp/a.txt]\n" }]);
	});

	it("truncates very long titles", () => {
		const out = mapSessionUpdate(
			notification({ sessionUpdate: "tool_call", toolCallId: "t6", title: "x".repeat(1000), status: "in_progress" }),
		);
		expect(out[0]?.type).toBe("tool");
		expect((out[0] as { text: string }).text.length).toBeLessThan(230);
	});
});
