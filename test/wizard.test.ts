import { describe, expect, it, vi } from "vitest";

vi.mock("../src/acp/setup.js", () => ({
	ensureAntigravityAcpReady: vi.fn(async () => undefined),
	inspectRuntimeSetup: () => ({ installedVersion: "1.2.1", approvedVersion: "1.2.1", platform: "linux-x86_64" }),
}));
vi.mock("../src/acp/antigravity.js", () => ({
	inspectAntigravityAuth: () => ({ status: "oauth-refreshable", authType: "oauth-personal" }),
}));
const saved: string[] = [];
vi.mock("../src/config.js", () => ({ savePermissionMode: (mode: string) => saved.push(mode) }));

const { runSetupWizard } = await import("../src/wizard.js");

function harness(pick: (options: string[]) => string | undefined) {
	const offered: string[][] = [];
	const ui = {
		notify: () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		select: async (_title: string, options: string[]) => {
			offered.push(options);
			return pick(options);
		},
	};
	const modes: string[] = [];
	const runtime = {
		setPermissionMode: async (mode: string) => void modes.push(mode),
		authHealth: async () => ({ networkValid: false, error: "stop here" }),
	};
	return { ui, runtime, offered, modes };
}

describe("setup wizard permission picker", () => {
	it("offers the fail-closed default mode first, so the highlighted choice is default", async () => {
		saved.length = 0;
		const h = harness((options) => options[0]);
		await runSetupWizard(h.ui as never, h.runtime as never);
		expect(h.offered[0]?.[0]).toMatch(/^default /u);
		expect(h.offered[0]?.at(-1)).toMatch(/^yolo /u);
		expect(h.modes).toEqual(["default"]);
		expect(saved).toEqual(["default"]);
	});

	it("still maps an explicit auto-edit or yolo choice", async () => {
		for (const [prefix, mode] of [["auto-edit", "auto_edit"], ["yolo", "yolo"]] as const) {
			saved.length = 0;
			const h = harness((options) => options.find((option) => option.startsWith(prefix)));
			await runSetupWizard(h.ui as never, h.runtime as never);
			expect(h.modes).toEqual([mode]);
			expect(saved).toEqual([mode]);
		}
	});
});
