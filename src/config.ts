import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type PermissionMode = "default" | "auto_edit" | "yolo";
export type RuntimeUpdateMode = "automatic" | "notify" | "manual";

export interface AntigravityAcpConfig {
	permissions: PermissionMode;
	runtimeUpdates: RuntimeUpdateMode;
}

const CONFIG_ROOT = path.join(os.homedir(), ".pi", "agent", "antigravity-acp-provider");
export const CONFIG_PATH = path.join(CONFIG_ROOT, "config.json");
export const LEGACY_CONFIG_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"gemini-acp-provider",
	"config.json",
);

export function loadConfig(file = CONFIG_PATH): AntigravityAcpConfig {
	if (file === CONFIG_PATH) migrateLegacyConfig();
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
			permissions?: unknown;
			runtimeUpdates?: unknown;
		};
		return {
			permissions: isPermissionMode(parsed.permissions) ? parsed.permissions : DEFAULT_CONFIG.permissions,
			runtimeUpdates: isRuntimeUpdateMode(parsed.runtimeUpdates)
				? parsed.runtimeUpdates
				: DEFAULT_CONFIG.runtimeUpdates,
		};
	} catch {
		// Missing or malformed configuration fails closed to the safe defaults.
	}
	return { ...DEFAULT_CONFIG };
}

/** Fail-closed defaults: ask before tool actions, never self-update the runtime. */
export const DEFAULT_CONFIG: Readonly<AntigravityAcpConfig> = Object.freeze({
	permissions: "default",
	runtimeUpdates: "manual",
});

export function savePermissionMode(mode: PermissionMode, file = CONFIG_PATH): void {
	writeConfig({ ...loadConfig(file), permissions: mode }, file);
}

export function saveRuntimeUpdateMode(mode: RuntimeUpdateMode, file = CONFIG_PATH): void {
	writeConfig({ ...loadConfig(file), runtimeUpdates: mode }, file);
}

function writeConfig(config: AntigravityAcpConfig, file: string): void {
	const directory = path.dirname(file);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, file);
}

/**
 * Migrate the legacy gemini-acp-provider config. Only runtimeUpdates is carried over (validated);
 * permissions is never inherited, because a legacy 'yolo' or 'auto_edit' must not be adopted
 * silently. The migrated file always starts at permissions='default'.
 */
export function migrateLegacyConfig(target = CONFIG_PATH, legacy = LEGACY_CONFIG_PATH): void {
	if (fs.existsSync(target) || !fs.existsSync(legacy)) return;
	try {
		const legacyConfig = loadConfig(legacy);
		fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
		const temporary = `${target}.${process.pid}.tmp`;
		try {
			fs.writeFileSync(
				temporary,
				`${JSON.stringify({ permissions: DEFAULT_CONFIG.permissions, runtimeUpdates: legacyConfig.runtimeUpdates }, null, 2)}\n`,
				{ mode: 0o600 },
			);
			// link() publishes atomically and fails if a concurrent writer already created the
			// target; rename() would silently overwrite that newer config.
			fs.linkSync(temporary, target);
		} finally {
			fs.rmSync(temporary, { force: true });
		}
	} catch {
		// Migration is best-effort; fail-closed defaults remain available.
	}
}

export function isPermissionMode(value: unknown): value is PermissionMode {
	return value === "default" || value === "auto_edit" || value === "yolo";
}

export function isRuntimeUpdateMode(value: unknown): value is RuntimeUpdateMode {
	return value === "automatic" || value === "notify" || value === "manual";
}

export function permissionModeLabel(mode: PermissionMode): string {
	if (mode === "auto_edit") return "auto-edit";
	return mode;
}
