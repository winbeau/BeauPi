// Execution journal for a session.
//
// A typed append-only JSONL fact log explaining what happened to runs and
// tool calls: created/started/settled runs, claimed/started/completed/failed
// tool calls, and cancel requests.
//
// Semantics:
// - appends are serialized per session (promise tail);
// - every event carries seq (persistence order), eventId, schemaVersion and
//   timestamp; revision is the storage version used for optimistic
//   concurrency via expectedRevision;
// - repairTail() drops only an incomplete final line (interrupted append);
//   malformed non-final lines fail loudly;
// - cancel intent is recorded BEFORE the AbortSignal is delivered;
// - completed tool calls are never re-executed (wasCompleted);
// - unknown outcomes are recorded as unknown and never replayed;
// - the journal explains facts; it never replays shell/network/file side
//   effects and never implies authorization.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import type { ExecutionStatus } from "./execution-types.ts";

export const EXECUTION_JOURNAL_SCHEMA_VERSION = 1;

export type ExecutionJournalEventType =
	| "run/created"
	| "run/started"
	| "tool/claimed"
	| "tool/started"
	| "tool/checkpoint"
	| "cancel/requested"
	| "tool/completed"
	| "tool/failed"
	| "tool/unknown"
	| "run/settled";

export type JournalToolStatus = "completed" | "failed" | "unknown";

export interface ExecutionJournalEvent {
	seq: number;
	eventId: string;
	schemaVersion: number;
	timestamp: string;
	type: ExecutionJournalEventType;
	sessionId: string;
	runId: string;
	toolCallId?: string;
	jobId?: string;
	attempt: number;
	owner: string;
	causationId?: string;
	idempotencyKey?: string;
	status?: JournalToolStatus;
	failureCategory?: string;
}

export interface ExecutionJournalAppendResult {
	seqFrom: number;
	seqTo: number;
	revision: number;
}

export interface ExecutionJournalInspection {
	path: string;
	exists: boolean;
	sessionId: string | undefined;
	entryCount: number;
	revision: number;
	lastSeq: number;
	truncatedTail: boolean;
}

export class ExecutionJournalError extends Error {
	readonly code: "invalid_journal" | "revision_conflict" | "storage_error";

	constructor(code: "invalid_journal" | "revision_conflict" | "storage_error", message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ExecutionJournalError";
		this.code = code;
	}
}

interface JournalFileSystem {
	readTextFile(path: string): Promise<string | undefined>;
	appendFile(path: string, data: string): Promise<void>;
	writeFile(path: string, data: string): Promise<void>;
}

const nodeFs: JournalFileSystem = {
	readTextFile: async (path) => (existsSync(path) ? readFile(path, "utf8") : undefined),
	appendFile: async (path, data) => {
		await appendFile(path, data, "utf8");
	},
	writeFile: async (path, data) => {
		await writeFile(path, data, "utf8");
	},
};

function invalidJournal(filePath: string, message: string, cause?: unknown): ExecutionJournalError {
	return new ExecutionJournalError("invalid_journal", `Invalid execution journal ${filePath}: ${message}`, cause);
}

function parseEventLine(line: string, filePath: string): ExecutionJournalEvent {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw invalidJournal(filePath, "line is not valid JSON", error);
	}
	if (typeof parsed !== "object" || parsed === null) throw invalidJournal(filePath, "line is not an event");
	const event = parsed as Record<string, unknown>;
	if (typeof event.seq !== "number" || !Number.isInteger(event.seq) || event.seq < 1) {
		throw invalidJournal(filePath, "event is missing an integer seq");
	}
	if (typeof event.eventId !== "string" || !event.eventId) throw invalidJournal(filePath, "event is missing eventId");
	if (typeof event.timestamp !== "string" || !event.timestamp) {
		throw invalidJournal(filePath, "event is missing timestamp");
	}
	return event as unknown as ExecutionJournalEvent;
}

function parseJournalFile(
	content: string,
	filePath: string,
): { events: ExecutionJournalEvent[]; truncatedTail: boolean } {
	const events: ExecutionJournalEvent[] = [];
	const lines = content.split("\n");
	let truncatedTail = false;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (line.trim() === "") continue;
		const last = index === lines.length - 1;
		if (last && !content.endsWith("\n")) {
			try {
				events.push(parseEventLine(line, filePath));
			} catch {
				truncatedTail = true;
			}
			continue;
		}
		events.push(parseEventLine(line, filePath));
	}
	return { events, truncatedTail };
}

export class ExecutionJournal {
	private readonly sessionId: string;
	private readonly fs: JournalFileSystem = nodeFs;
	private readonly filePath: string | undefined;
	private readonly now: () => Date;
	private readonly memory: ExecutionJournalEvent[] = [];
	private revision: number = 0;
	private tail: Promise<unknown> = Promise.resolve();

	constructor(options: { sessionId: string; filePath?: string; now?: () => Date; fs?: JournalFileSystem }) {
		this.sessionId = options.sessionId;
		this.filePath = options.filePath;
		this.now = options.now ?? (() => new Date());
		if (options.fs) this.fs = options.fs;
	}

	/** Serialize all operations for this journal. */
	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation, operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async load(): Promise<{ events: ExecutionJournalEvent[]; truncatedTail: boolean }> {
		if (this.filePath === undefined) {
			return { events: [...this.memory], truncatedTail: false };
		}
		let content: string | undefined;
		try {
			content = await this.fs.readTextFile(this.filePath);
		} catch (error) {
			throw new ExecutionJournalError("storage_error", `Failed to read execution journal ${this.filePath}`, error);
		}
		if (content === undefined) return { events: [], truncatedTail: false };
		return parseJournalFile(content, this.filePath);
	}

	private event(
		type: ExecutionJournalEventType,
		fields: Omit<ExecutionJournalEvent, "seq" | "eventId" | "schemaVersion" | "timestamp" | "type" | "sessionId">,
	): Record<string, unknown> {
		return { ...fields, type, sessionId: this.sessionId };
	}

	appendBatch(batch: unknown[], options?: { expectedRevision?: number }): Promise<ExecutionJournalAppendResult> {
		return this.serial(async () => {
			if (options?.expectedRevision !== undefined && options.expectedRevision !== this.revision) {
				throw new ExecutionJournalError(
					"revision_conflict",
					`Execution journal ${this.filePath ?? "<memory>"}: expected revision ${options.expectedRevision}, found ${this.revision}`,
				);
			}
			const loaded = await this.load();
			if (loaded.truncatedTail) {
				throw invalidJournal(
					this.filePath ?? "<memory>",
					"journal tail is incomplete; call repairTail() before appending",
				);
			}
			const seqFrom = loaded.events.length + 1;
			const timestamp = this.now().toISOString();
			const prepared: ExecutionJournalEvent[] = batch.map((raw, offset) => {
				const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
				return {
					...record,
					seq: seqFrom + offset,
					eventId: (record.eventId as string | undefined) ?? randomUUID(),
					schemaVersion: EXECUTION_JOURNAL_SCHEMA_VERSION,
					timestamp: (record.timestamp as string | undefined) ?? timestamp,
				} as ExecutionJournalEvent;
			});
			if (prepared.length === 0) return { seqFrom, seqTo: seqFrom - 1, revision: this.revision };
			if (this.filePath !== undefined) {
				const content = prepared.map((event) => `${JSON.stringify(event)}\n`).join("");
				try {
					await this.fs.appendFile(this.filePath, content);
				} catch (error) {
					throw new ExecutionJournalError(
						"storage_error",
						`Failed to append execution journal ${this.filePath}`,
						error,
					);
				}
			} else {
				this.memory.push(...prepared);
			}
			this.revision = seqFrom + prepared.length - 1;
			return { seqFrom, seqTo: this.revision, revision: this.revision };
		});
	}

	readAfter(seq: number): Promise<ExecutionJournalEvent[]> {
		return this.serial(async () => {
			const loaded = await this.load();
			return loaded.events.filter((event) => event.seq > seq).map((event) => structuredClone(event));
		});
	}

	inspect(): Promise<ExecutionJournalInspection> {
		return this.serial(async () => {
			const loaded = await this.load();
			const lastSeq = loaded.events.length > 0 ? loaded.events[loaded.events.length - 1]!.seq : 0;
			return {
				path: this.filePath ?? "<memory>",
				exists: this.filePath === undefined || loaded.events.length > 0 || loaded.truncatedTail,
				sessionId: this.sessionId,
				entryCount: loaded.events.length,
				revision: loaded.events.length,
				lastSeq,
				truncatedTail: loaded.truncatedTail,
			};
		});
	}

	/** Drop only an incomplete final line; malformed non-final lines fail loudly. */
	repairTail(): Promise<boolean> {
		return this.serial(async () => {
			if (this.filePath === undefined) return false;
			let content: string | undefined;
			try {
				content = await this.fs.readTextFile(this.filePath);
			} catch (error) {
				throw new ExecutionJournalError(
					"storage_error",
					`Failed to read execution journal ${this.filePath}`,
					error,
				);
			}
			if (content === undefined) return false;
			const { events, truncatedTail } = parseJournalFile(content, this.filePath);
			if (!truncatedTail) return false;
			const repaired = events.map((event) => `${JSON.stringify(event)}\n`).join("");
			try {
				await this.fs.writeFile(this.filePath, repaired);
			} catch (error) {
				throw new ExecutionJournalError(
					"storage_error",
					`Failed to repair execution journal ${this.filePath}`,
					error,
				);
			}
			this.revision = events.length;
			return true;
		});
	}

	recordRunCreated(runId: string, owner: string): Promise<void> {
		return this.append(this.event("run/created", { runId, attempt: 1, owner }));
	}

	recordRunStarted(runId: string, owner: string, causationId?: string): Promise<void> {
		return this.append(this.event("run/started", { runId, attempt: 1, owner, causationId }));
	}

	recordToolClaimed(runId: string, toolCallId: string, owner: string, attempt = 1, jobId?: string): Promise<void> {
		return this.append(this.event("tool/claimed", { runId, toolCallId, jobId, attempt, owner }));
	}

	recordToolStarted(
		runId: string,
		toolCallId: string,
		owner: string,
		attempt = 1,
		causationId?: string,
	): Promise<void> {
		return this.append(this.event("tool/started", { runId, toolCallId, attempt, owner, causationId }));
	}

	recordToolCheckpoint(runId: string, toolCallId: string, owner: string, idempotencyKey?: string): Promise<void> {
		return this.append(this.event("tool/checkpoint", { runId, toolCallId, attempt: 1, owner, idempotencyKey }));
	}

	/** Cancel intent is recorded BEFORE the AbortSignal is delivered. */
	recordCancelRequested(runId: string, toolCallId: string | undefined, owner: string): Promise<void> {
		return this.append(this.event("cancel/requested", { runId, toolCallId, attempt: 1, owner }));
	}

	recordToolFinished(
		runId: string,
		toolCallId: string,
		status: JournalToolStatus,
		owner: string,
		failureCategory?: string,
	): Promise<void> {
		const type: ExecutionJournalEventType =
			status === "completed" ? "tool/completed" : status === "failed" ? "tool/failed" : "tool/unknown";
		return this.append(this.event(type, { runId, toolCallId, attempt: 1, owner, status, failureCategory }));
	}

	recordRunSettled(runId: string, status: ExecutionStatus, owner: string): Promise<void> {
		const settled: JournalToolStatus =
			status === "completed" || status === "failed" || status === "unknown" ? status : "unknown";
		return this.append(this.event("run/settled", { runId, attempt: 1, owner, status: settled }));
	}

	private append(event: unknown): Promise<void> {
		return this.appendBatch([event]).then(() => undefined);
	}

	async readEvents(): Promise<ExecutionJournalEvent[]> {
		const events = await this.readAfter(0);
		return events.filter(
			(event): event is ExecutionJournalEvent => typeof event.type === "string" && typeof event.runId === "string",
		);
	}

	/** True when the tool call already recorded a completed outcome (never re-execute). */
	async wasCompleted(toolCallId: string): Promise<boolean> {
		const events = await this.readEvents();
		return events.some((event) => event.toolCallId === toolCallId && event.status === "completed");
	}

	async settledStatus(runId: string): Promise<ExecutionStatus | undefined> {
		const events = await this.readEvents();
		for (let index = events.length - 1; index >= 0; index--) {
			const event = events[index]!;
			if (event.runId === runId && event.type === "run/settled" && event.status) return event.status;
		}
		return undefined;
	}
}
