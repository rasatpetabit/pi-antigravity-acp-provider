import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withStoreLock } from "./store-lock.js";

/** Persisted record schema. Records without this version (pre-Pi-0.99 builds) are never restored. */
export const SESSION_RECORD_SCHEMA_VERSION = 2;

export interface SavedSessionRecord {
	/** Records written before the Pi 0.99 transcript fingerprints lack this and are dropped. */
	schemaVersion: typeof SESSION_RECORD_SCHEMA_VERSION;
	piSessionId: string;
	acpSessionId: string;
	acpModelId: string;
	cwd: string;
	messageCount: number;
	historyFingerprint: string;
	expectedAssistantFingerprint?: string;
	lastActive: number;
}

const DEFAULT_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"antigravity-acp-provider",
	"sessions.json",
);
const MAX_RECORDS = 256;
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;

export class AcpSessionStore {
	constructor(private readonly file = DEFAULT_PATH) {}

	get(piSessionId: string): SavedSessionRecord | undefined {
		return this.read()
			.filter((record) => Date.now() - record.lastActive <= MAX_AGE_MS)
			.find((record) => record.piSessionId === piSessionId);
	}

	save(record: SavedSessionRecord): void {
		withStoreLock(this.file, () => {
			const records = this.read().filter((candidate) => candidate.piSessionId !== record.piSessionId);
			records.push(record);
			records.sort((left, right) => right.lastActive - left.lastActive);
			this.write(records.slice(0, MAX_RECORDS));
		});
	}

	remove(piSessionId: string): void {
		withStoreLock(this.file, () => this.write(this.read().filter((record) => record.piSessionId !== piSessionId)));
	}

	clear(): void {
		withStoreLock(this.file, () => fs.rmSync(this.file, { force: true }));
	}

	private read(): SavedSessionRecord[] {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
			if (!Array.isArray(parsed)) return [];
			return parsed.filter(validRecord);
		} catch {
			return [];
		}
	}

	private write(records: SavedSessionRecord[]): void {
		if (records.length === 0) {
			fs.rmSync(this.file, { force: true });
			return;
		}
		fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
		const temporary = `${this.file}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temporary, this.file);
	}
}

function validRecord(value: unknown): value is SavedSessionRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<SavedSessionRecord>;
	return (
		record.schemaVersion === SESSION_RECORD_SCHEMA_VERSION &&
		typeof record.piSessionId === "string" &&
		typeof record.acpSessionId === "string" &&
		typeof record.acpModelId === "string" &&
		typeof record.cwd === "string" &&
		Number.isSafeInteger(record.messageCount) &&
		(record.messageCount ?? -1) >= 0 &&
		typeof record.historyFingerprint === "string" &&
		(record.expectedAssistantFingerprint === undefined ||
			typeof record.expectedAssistantFingerprint === "string") &&
		typeof record.lastActive === "number" &&
		Number.isFinite(record.lastActive)
	);
}
