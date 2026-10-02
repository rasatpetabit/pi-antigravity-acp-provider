import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, savePermissionMode, saveRuntimeUpdateMode } from "../src/config.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("permission configuration", () => {
	it("defaults to the fail-closed modes and persists an explicit mode", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-acp-config-"));
		directories.push(directory);
		const file = path.join(directory, "nested", "config.json");
		expect(loadConfig(file)).toEqual({ permissions: "default", runtimeUpdates: "manual" });
		saveRuntimeUpdateMode("notify", file);
		savePermissionMode("auto_edit", file);
		expect(loadConfig(file)).toEqual({ permissions: "auto_edit", runtimeUpdates: "notify" });
	});
});
