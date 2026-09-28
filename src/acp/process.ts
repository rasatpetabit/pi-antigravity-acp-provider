import fs from "node:fs";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { resolveAntigravityAcpLaunch } from "./antigravity.js";
import { redact } from "./errors.js";
const STDERR_LIMIT = 16 * 1024;
// Longer than supervisor.mjs's 750 ms agent-tree escalation window.
const KILL_GRACE_MS = 1_500;
let nextGeneration = 1;

export interface AntigravityProcessOptions {
	cwd: string;
	entryPath?: string;
	command?: string;
	args?: string[];
	env?: NodeJS.ProcessEnv;
}

export interface ProcessExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	stderrTail: string;
}

export function resolveSupervisorEntry(): string {
	return fileURLToPath(new URL("./supervisor.mjs", import.meta.url));
}

export function resolveAntigravityAcpEntry(): string {
	// Kept as a compatibility export for diagnostics; the provider now targets
	// Google Antigravity's ACP server rather than the retired Gemini CLI client.
	return resolveAntigravityAcpLaunch().command;
}

export function resolveNodeBinary(execPath?: string): string {
	// An explicitly provided executable (entry option or NODE env override set
	// by the caller/package manager) is trusted as-is: NixOS names its node
	// wrapper "nodejs", and basename matching would silently discard a valid
	// override when no ambient node exists.
	const explicit = execPath || process.env.NODE;
	if (explicit) return explicit;
	const candidate = process.execPath;
	const base = (candidate.split(/[\\/]/).pop() ?? "").toLowerCase();
	// When Pi is distributed as a standalone executable (e.g. NixOS package,
	// SEA, or packaged release), process.execPath points to the pi binary rather
	// than node. Fall back to standard ambient node in that case.
	if (/^node(?:\.exe|\.cmd|\.bat)?$/i.test(base)) return candidate;
	return "node";
}

export const DEFAULT_CA_BUNDLE_PATHS = [
	"/etc/ssl/certs/ca-bundle.crt",
	"/etc/ssl/certs/ca-certificates.crt",
	"/etc/pki/tls/certs/ca-bundle.crt",
	"/etc/ssl/ca-bundle.pem",
	"/etc/ssl/cert.pem",
];

export function resolveDefaultSslCertFile(
	env: NodeJS.ProcessEnv = process.env,
	exists: (filePath: string) => boolean = fs.existsSync,
): string | undefined {
	if (env.SSL_CERT_FILE && exists(env.SSL_CERT_FILE)) return env.SSL_CERT_FILE;
	if (env.NIX_SSL_CERT_FILE && exists(env.NIX_SSL_CERT_FILE)) return env.NIX_SSL_CERT_FILE;
	for (const candidate of DEFAULT_CA_BUNDLE_PATHS) {
		if (exists(candidate)) return candidate;
	}
	return undefined;
}

export function applyDefaultTlsEnvironment(
	baseEnv: NodeJS.ProcessEnv = process.env,
	exists: (filePath: string) => boolean = fs.existsSync,
): NodeJS.ProcessEnv {
	const env = { ...baseEnv };
	if (!env.SSL_CERT_FILE) {
		const certFile = resolveDefaultSslCertFile(env, exists);
		if (certFile) env.SSL_CERT_FILE = certFile;
	}
	return env;
}
export class AntigravityProcess {
	readonly generation = nextGeneration++;
	readonly child: ChildProcessWithoutNullStreams;
	readonly input: ReadableStream<Uint8Array>;
	readonly output: WritableStream<Uint8Array>;
	readonly exited: Promise<ProcessExit>;
	private stderr = "";
	private ignoredStdoutNoise = 0;
	private settled = false;
	private closing?: Promise<void>;

	constructor(options: AntigravityProcessOptions) {
		let command: string;
		let args: string[];
		if (options.command) {
			command = options.command;
			args = options.args ?? [];
		} else {
			const nodeBinary = resolveNodeBinary(options.env?.NODE);
			const launch = options.entryPath
				? { command: nodeBinary, args: [options.entryPath, ...(options.args ?? [])] }
				: resolveAntigravityAcpLaunch();
			command = nodeBinary;
			args = [resolveSupervisorEntry(), "--command", launch.command, ...launch.args];
		}
		let resolveExit!: (exit: ProcessExit) => void;
		this.exited = new Promise((resolve) => {
			resolveExit = resolve;
		});

		const env = applyDefaultTlsEnvironment(options.env ?? process.env);
		const child = spawn(command, args, {
			cwd: path.resolve(options.cwd),
			env,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			windowsHide: true,
			detached: process.platform !== "win32",
		});
		this.child = child;
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderr = redact((this.stderr + chunk).slice(-STDERR_LIMIT));
		});
		child.once("error", (cause) => {
			this.finish(resolveExit, null, null, `spawn failed: ${cause.message}`);
		});
		child.once("exit", (code, signal) => {
			this.finish(resolveExit, code, signal, this.stderr);
		});

		this.input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
		this.output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
	}

	get pid(): number | undefined {
		return this.child.pid;
	}

	get stderrTail(): string {
		return this.stderr;
	}

	get ignoredStdoutNoiseLines(): number {
		return this.ignoredStdoutNoise;
	}

	recordCompatibilityNoise(): void {
		this.ignoredStdoutNoise += 1;
	}

	get alive(): boolean {
		// child.killed only records that kill() was called; it does not mean the
		// process has exited. Keep it alive until exit/error settles.
		return !this.settled && this.child.exitCode === null;
	}

	async close(): Promise<void> {
		this.closing ??= this.closeOnce();
		return this.closing;
	}

	private async closeOnce(): Promise<void> {
		if (!this.alive) return;
		// Do not end stdin independently of the Web WritableStream adapter. An
		// in-flight SDK write may otherwise reach Node after stdin.end() and raise
		// ERR_STREAM_WRITE_AFTER_END as an uncaught stream error. Terminating the
		// owned process tree closes all three stdio streams together.
		this.signal("SIGTERM");
		const exited = await Promise.race([
			this.exited.then(() => true),
			delay(KILL_GRACE_MS).then(() => false),
		]);
		if (!exited && this.alive) {
			this.signal("SIGKILL");
			await Promise.race([this.exited, delay(KILL_GRACE_MS)]);
		}
	}

	private signal(signal: NodeJS.Signals): void {
		try {
			if (process.platform === "win32" && this.child.pid) {
				const args = ["/PID", String(this.child.pid), "/T"];
				if (signal === "SIGKILL") args.push("/F");
				spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
				return;
			}
			if (this.child.pid) process.kill(-this.child.pid, signal);
			else this.child.kill(signal);
		} catch {
			// ESRCH means the process tree is already gone.
		}
	}

	private finish(
		resolve: (exit: ProcessExit) => void,
		code: number | null,
		signal: NodeJS.Signals | null,
		stderrTail: string,
	): void {
		if (this.settled) return;
		this.settled = true;
		resolve({ code, signal, stderrTail: redact(stderrTail) });
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

