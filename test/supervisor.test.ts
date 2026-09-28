import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
	AntigravityProcess,
	applyDefaultTlsEnvironment,
	DEFAULT_CA_BUNDLE_PATHS,
	resolveDefaultSslCertFile,
	resolveNodeBinary,
	resolveSupervisorEntry,
} from "../src/acp/process.js";

const parentFixture = fileURLToPath(new URL("./fixtures/watchdog-parent.mjs", import.meta.url));
const agentFixture = fileURLToPath(new URL("./fixtures/long-agent.mjs", import.meta.url));
const ignoreTermFixture = fileURLToPath(new URL("./fixtures/ignore-term.mjs", import.meta.url));
const exitAgentFixture = fileURLToPath(new URL("./fixtures/exit-agent.mjs", import.meta.url));
const envDumpFixture = fileURLToPath(new URL("./fixtures/env-dump-agent.mjs", import.meta.url));
const cleanupPids = new Set<number>();

afterEach(() => {
	for (const pid of cleanupPids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	cleanupPids.clear();
});

describe("resolveNodeBinary", () => {
	it("preserves standard node executables", () => {
		expect(resolveNodeBinary("/usr/bin/node")).toBe("/usr/bin/node");
		expect(resolveNodeBinary("/usr/local/bin/node")).toBe("/usr/local/bin/node");
		expect(resolveNodeBinary("C:\\Program Files\\nodejs\\node.exe")).toBe("C:\\Program Files\\nodejs\\node.exe");
	});

	it("falls back to ambient node when process.execPath is a standalone binary like pi", () => {
		// resolveNodeBinary() with no explicit override evaluates
		// process.execPath; stub it to simulate running inside a standalone
		// Pi binary with no NODE env override.
		const original = process.execPath;
		const originalNode = process.env.NODE;
		delete process.env.NODE;
		try {
			for (const piExecPath of [
				"/nix/store/ai9szyf9fivph9rdk65gzjiy30sll754-pi-0.87.1/libexec/pi/pi",
				"/usr/local/bin/pi",
				"C:\\bin\\pi.exe",
			]) {
				Object.defineProperty(process, "execPath", { value: piExecPath, configurable: true });
				expect(resolveNodeBinary()).toBe("node");
			}
		} finally {
			Object.defineProperty(process, "execPath", { value: original, configurable: true });
			if (originalNode === undefined) delete process.env.NODE;
			else process.env.NODE = originalNode;
		}
	});

	it("preserves a nonstandard explicit NODE override with no ambient node", () => {
		// NixOS names its node wrapper "nodejs" and may have no `node` on
		// PATH; discarding the override would return the ambient "node" and
		// fail to spawn. An explicit override is trusted regardless of
		// basename.
		expect(resolveNodeBinary("/nix/store/xxym3ni0yy0wq9c0r2i5dp2akqc8h444-nodejs-22.12.0/bin/nodejs")).toBe(
			"/nix/store/xxym3ni0yy0wq9c0r2i5dp2akqc8h444-nodejs-22.12.0/bin/nodejs",
		);
	});

	it("preserves a nonstandard NODE environment variable override with no ambient node", () => {
		const original = process.env.NODE;
		try {
			process.env.NODE = "/nix/store/xxym3ni0yy0wq9c0r2i5dp2akqc8h444-nodejs-22.12.0/bin/nodejs";
			expect(resolveNodeBinary()).toBe(
				"/nix/store/xxym3ni0yy0wq9c0r2i5dp2akqc8h444-nodejs-22.12.0/bin/nodejs",
			);
		} finally {
			if (original === undefined) delete process.env.NODE;
			else process.env.NODE = original;
		}
	});

	it("respects custom NODE environment variable override", () => {
		const original = process.env.NODE;
		try {
			process.env.NODE = "/opt/custom/bin/node";
			expect(resolveNodeBinary()).toBe("/opt/custom/bin/node");
		} finally {
			if (original === undefined) delete process.env.NODE;
			else process.env.NODE = original;
		}
	});
});

describe("resolveDefaultSslCertFile", () => {
	it("returns existing SSL_CERT_FILE if present and file exists", () => {
		const exists = (p: string) => p === "/custom/ca.crt";
		expect(resolveDefaultSslCertFile({ SSL_CERT_FILE: "/custom/ca.crt" }, exists)).toBe("/custom/ca.crt");
	});

	it("falls back to NIX_SSL_CERT_FILE if SSL_CERT_FILE does not exist", () => {
		const exists = (p: string) => p === "/nix/ca.crt";
		expect(
			resolveDefaultSslCertFile(
				{ SSL_CERT_FILE: "/broken/ca.crt", NIX_SSL_CERT_FILE: "/nix/ca.crt" },
				exists,
			),
		).toBe("/nix/ca.crt");
	});

	it("falls back to system CA bundle when neither env var points to an existing file", () => {
		const exists = (p: string) => p === "/etc/ssl/certs/ca-bundle.crt";
		expect(resolveDefaultSslCertFile({}, exists)).toBe("/etc/ssl/certs/ca-bundle.crt");
	});

	it("returns undefined when no candidates exist", () => {
		const exists = () => false;
		expect(resolveDefaultSslCertFile({}, exists)).toBeUndefined();
	});
});

describe("applyDefaultTlsEnvironment", () => {
	it("preserves explicit SSL_CERT_FILE if already set", () => {
		const env = applyDefaultTlsEnvironment({ SSL_CERT_FILE: "/custom/ca.crt" });
		expect(env.SSL_CERT_FILE).toBe("/custom/ca.crt");
	});

	it("falls back to NIX_SSL_CERT_FILE if present and existing", () => {
		const exists = (p: string) => p === "/nix/ca.crt";
		const env = applyDefaultTlsEnvironment({ NIX_SSL_CERT_FILE: "/nix/ca.crt" }, exists);
		expect(env.SSL_CERT_FILE).toBe("/nix/ca.crt");
	});

	it("resolves the first existing candidate when SSL_CERT_FILE is not set", () => {
		const exists = (p: string) => p === "/etc/ssl/certs/ca-bundle.crt";
		const env = applyDefaultTlsEnvironment({}, exists);
		expect(env.SSL_CERT_FILE).toBe("/etc/ssl/certs/ca-bundle.crt");
	});

	it("leaves SSL_CERT_FILE unset when no candidates exist", () => {
		const exists = () => false;
		const env = applyDefaultTlsEnvironment({}, exists);
		expect(env.SSL_CERT_FILE).toBeUndefined();
	});

	it("propagates the resolved SSL_CERT_FILE to the spawned supervisor process", async () => {
		// Integration check for the real spawn path: applyDefaultTlsEnvironment
		// runs inside AntigravityProcess's constructor, and the supervisor
		// forwards its environment to the supervised agent unchanged.
		const child = new AntigravityProcess({
			cwd: process.cwd(),
			entryPath: envDumpFixture,
			args: [],
			env: { ...process.env, SSL_CERT_FILE: "/custom/integration-ca.crt" },
		});
		const exit = await Promise.race([
			child.exited,
			delay(2_000).then(() => {
				throw new Error("env-dump agent did not exit");
			}),
		]);
		expect(exit.code).toBe(0);
		const reported = JSON.parse(exit.stderrTail) as { sslCertFile: string | null };
		expect(reported.sslCertFile).toBe("/custom/integration-ca.crt");
	});

	it("injects a detected fallback bundle when SSL_CERT_FILE is unset", async () => {
		// Simulate an environment with no SSL_CERT_FILE (NixOS/minimal Linux) by
		// passing a filtered env; applyDefaultTlsEnvironment must detect the
		// real system bundle and the supervisor must forward it.
		const baseEnv: NodeJS.ProcessEnv = { ...process.env };
		delete baseEnv.SSL_CERT_FILE;
		const detected = resolveDefaultSslCertFile(baseEnv);
		if (!detected) return; // nothing to detect on this machine
		const child = new AntigravityProcess({
			cwd: process.cwd(),
			entryPath: envDumpFixture,
			args: [],
			env: baseEnv,
		});
		const exit = await Promise.race([
			child.exited,
			delay(2_000).then(() => {
				throw new Error("env-dump agent did not exit");
			}),
		]);
		expect(exit.code).toBe(0);
		const reported = JSON.parse(exit.stderrTail) as { sslCertFile: string | null };
		expect(reported.sslCertFile).toBe(detected);
	});

	it("propagates custom-CA environment when running as a standalone Pi binary", async () => {
		// Simulates running inside a standalone Pi binary (process.execPath
		// points to pi rather than node). resolveNodeBinary must fall back to
		// ambient "node" to spawn the supervisor, and the injected CA bundle
		// must propagate through supervisor to the agent.
		const originalExecPath = process.execPath;
		const originalNode = process.env.NODE;
		delete process.env.NODE;
		try {
			Object.defineProperty(process, "execPath", {
				value: "/nix/store/ai9szyf9fivph9rdk65gzjiy30sll754-pi-0.87.1/libexec/pi/pi",
				configurable: true,
			});
			const child = new AntigravityProcess({
				cwd: process.cwd(),
				entryPath: envDumpFixture,
				args: [],
				env: { ...process.env, SSL_CERT_FILE: "/custom/standalone-ca.crt" },
			});
			const exit = await Promise.race([
				child.exited,
				delay(2_000).then(() => {
					throw new Error("env-dump agent did not exit");
				}),
			]);
			expect(exit.code).toBe(0);
			const reported = JSON.parse(exit.stderrTail) as { sslCertFile: string | null };
			expect(reported.sslCertFile).toBe("/custom/standalone-ca.crt");
		} finally {
			Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
			if (originalNode === undefined) delete process.env.NODE;
			else process.env.NODE = originalNode;
		}
	});
});
describe.skipIf(process.platform === "win32")("parent-death supervisor", () => {
	it("escalates from TERM to KILL for a stuck direct child", async () => {
		const child = new AntigravityProcess({
			cwd: process.cwd(),
			command: process.execPath,
			args: [ignoreTermFixture],
		});
		await new Promise<void>((resolve) => child.child.stdout.once("data", () => resolve()));
		const started = Date.now();
		const closing = child.close();
		await delay(25);
		expect(child.child.stdin.writableEnded).toBe(false);
		await closing;
		expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
		expect(child.alive).toBe(false);
	});

	it("exits promptly when the supervised agent exits", async () => {
		const child = new AntigravityProcess({ cwd: process.cwd(), entryPath: exitAgentFixture, args: [] });
		const exit = await Promise.race([
			child.exited,
			delay(2_000).then(() => {
				throw new Error("supervisor stayed alive after agent exit");
			}),
		]);
		expect(exit.code).toBe(3);
		expect(child.alive).toBe(false);
	});

	it("kills the Gemini process group after an abrupt parent death", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-acp-watchdog-"));
		const pidFile = path.join(directory, "pids.json");
		const parent = spawn(process.execPath, [parentFixture, resolveSupervisorEntry(), agentFixture, pidFile], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		if (!parent.pid) throw new Error("parent fixture did not start");
		cleanupPids.add(parent.pid);
		const lines = readline.createInterface({ input: parent.stdout, crlfDelay: Infinity });
		const first = await Promise.race([
			new Promise<string>((resolve) => lines.once("line", resolve)),
			delay(6_000).then(() => {
				throw new Error("watchdog fixture timed out");
			}),
		]);
		const pids = JSON.parse(first) as { supervisor: number; agent: number; grandchild: number };
		for (const pid of Object.values(pids)) cleanupPids.add(pid);

		process.kill(parent.pid, "SIGKILL");
		cleanupPids.delete(parent.pid);
		await waitUntilGone([pids.supervisor, pids.agent, pids.grandchild], 4_000);
		for (const pid of Object.values(pids)) {
			expect(isAlive(pid), `pid ${pid} should be gone`).toBe(false);
			cleanupPids.delete(pid);
		}
		await fs.rm(directory, { recursive: true, force: true });
	}, 10_000);
});

async function waitUntilGone(pids: number[], timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (pids.some(isAlive) && Date.now() < deadline) await delay(50);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
