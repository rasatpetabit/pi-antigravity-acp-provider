import type { SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { mapSessionUpdate, type ToolActivityContext } from "../src/acp/events.js";

function notification(update: Record<string, unknown>): SessionNotification {
	return { sessionId: "s1", update } as unknown as SessionNotification;
}

function context(): ToolActivityContext {
	return { bridgedToolNames: new Set(["pi_read", "pi_subagent"]), bridgedCallIds: new Set() };
}

describe("mapSessionUpdate tool quieting", () => {
	it("emits one compact line for a native tool call and no status suffix", () => {
		const out = mapSessionUpdate(
			notification({ sessionUpdate: "tool_call", toolCallId: "t1", title: "git status", status: "in_progress", kind: "execute" }),
			context(),
		);
		expect(out).toEqual([{ type: "tool", text: "\n[Antigravity: git status]\n" }]);
	});

	it("drops the Antigravity-side line for a bridged Pi tool call; Pi renders the real card", () => {
		const bridged = context();
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

	it("does not treat a native command that mentions a bridged name as bridged", () => {
		for (const title of ["cat pi_readme.txt", "grep pi_read src", "pi_read --help | head"]) {
			const ctx = context();
			const out = mapSessionUpdate(notification({ sessionUpdate: "tool_call", toolCallId: "n", title, status: "in_progress" }), ctx);
			expect(out).toHaveLength(1);
			expect(ctx.bridgedCallIds.size).toBe(0);
		}
	});

	it("recognizes the bare projected name as a bridged title", () => {
		const ctx = context();
		expect(mapSessionUpdate(notification({ sessionUpdate: "tool_call", toolCallId: "b", title: "pi_subagent" }), ctx)).toEqual([]);
		expect(ctx.bridgedCallIds.has("b")).toBe(true);
	});

	it("silences title-less updates of a bridged call by toolCallId, including failures and diffs", () => {
		const ctx = context();
		mapSessionUpdate(notification({ sessionUpdate: "tool_call", toolCallId: "b1", title: "Running pi_read", status: "in_progress" }), ctx);
		expect(
			mapSessionUpdate(
				notification({ sessionUpdate: "tool_call_update", toolCallId: "b1", status: "in_progress", content: [{ type: "diff", path: "/x", newText: "" }] }),
				ctx,
			),
		).toEqual([]);
		expect(
			mapSessionUpdate(
				notification({ sessionUpdate: "tool_call_update", toolCallId: "b1", title: null, status: "failed", content: [{ type: "content", content: { type: "text", text: "boom" } }] }),
				ctx,
			),
		).toEqual([]);
		// Terminal status releases the id.
		expect(ctx.bridgedCallIds.has("b1")).toBe(false);
	});

	it("keeps a native call's failure even when its title mentions a bridged name", () => {
		const ctx = context();
		mapSessionUpdate(notification({ sessionUpdate: "tool_call", toolCallId: "n1", title: "grep pi_read src", status: "in_progress" }), ctx);
		const out = mapSessionUpdate(notification({ sessionUpdate: "tool_call_update", toolCallId: "n1", title: "grep pi_read src", status: "failed" }), ctx);
		expect(out).toEqual([{ type: "tool", text: "\n[Antigravity tool failed: grep pi_read src]\n" }]);
	});

	it("drops completed and in_progress tool_call_update notifications", () => {
		for (const status of ["completed", "in_progress", "pending"]) {
			expect(
				mapSessionUpdate(notification({ sessionUpdate: "tool_call_update", toolCallId: "abc:23", status }), context()),
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
			context(),
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
			context(),
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
