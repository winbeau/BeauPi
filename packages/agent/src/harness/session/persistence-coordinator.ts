import { uuidv7 } from "@earendil-works/pi-ai";
import type { FileSystem, Result } from "../types.ts";
import { SessionError } from "../types.ts";

// ============================================================================
// PersistenceCoordinator
//
// A per-session JSONL append coordinator with explicit persistence semantics:
//
// - appends are serialized per session file (a promise tail);
// - every event line carries seq (persistence order), eventId, schemaVersion,
//   and timestamp;
// - revision is the storage version (count of committed event lines) and can
//   be used for optimistic concurrency via expectedRevision;
// - repairTail() drops only an incomplete final line (an interrupted append);
//   malformed non-final lines fail loudly;
// - flush() is an observable checkpoint for the current append state.
//
// This layer only orders and stores facts. It never replays side effects and
// never implies authorization.
// ============================================================================

export interface PersistenceCoordinatorOptions {
	fs: Pick<FileSystem, "readTextFile" | "appendFile" | "writeFile">;
	filePath: string;
	sessionId: string;
	now?: () => Date;
}

export interface PersistenceEvent {
	seq: number;
	eventId: string;
	schemaVersion: number;
	timestamp: string;
	[field: string]: unknown;
}

export interface PersistenceAppendResult {
	seqFrom: number;
	seqTo: number;
	revision: number;
}

export interface PersistenceInspection {
	path: string;
	exists: boolean;
	sessionId: string | undefined;
	entryCount: number;
	revision: number;
	lastSeq: number;
	truncatedTail: boolean;
}

export interface PersistenceBackend {
	appendBatch(events: unknown[], options?: { expectedRevision?: number }): Promise<PersistenceAppendResult>;
	readAfter(seq: number): Promise<PersistenceEvent[]>;
	flush(): Promise<PersistenceInspection>;
	inspect(): Promise<PersistenceInspection>;
	repairTail(): Promise<boolean>;
}

const JOURNAL_SCHEMA_VERSION = 1;

function invalidJournal(filePath: string, message: string, cause?: Error): SessionError {
	return new SessionError("invalid_entry", `Invalid execution journal ${filePath}: ${message}`, cause);
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function parseJournalLine(line: string, filePath: string): PersistenceEvent {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw invalidJournal(filePath, "line is not valid JSON", toError(error));
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw invalidJournal(filePath, "line is not a journal event");
	}
	const event = parsed as Record<string, unknown>;
	if (typeof event.seq !== "number" || !Number.isInteger(event.seq) || event.seq < 1) {
		throw invalidJournal(filePath, "event is missing an integer seq");
	}
	if (typeof event.eventId !== "string" || !event.eventId) {
		throw invalidJournal(filePath, "event is missing eventId");
	}
	if (typeof event.timestamp !== "string" || !event.timestamp) {
		throw invalidJournal(filePath, "event is missing timestamp");
	}
	return event as unknown as PersistenceEvent;
}

/**
 * Parse a journal file. An incomplete final line (an interrupted append) is
 * dropped; malformed non-final lines fail loudly.
 */
export function parseJournalFile(
	content: string,
	filePath: string,
): { events: PersistenceEvent[]; truncatedTail: boolean } {
	const events: PersistenceEvent[] = [];
	const lines = content.split("\n");
	let truncatedTail = false;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (line.trim() === "") continue;
		const last = index === lines.length - 1;
		if (last && !content.endsWith("\n")) {
			// Unterminated final line: only keep it when it is a complete event.
			try {
				events.push(parseJournalLine(line, filePath));
			} catch {
				truncatedTail = true;
			}
			continue;
		}
		events.push(parseJournalLine(line, filePath));
	}
	return { events, truncatedTail };
}

/** In-memory backend for tests and non-persisted sessions. */
export function createMemoryPersistence(): PersistenceBackend {
	const events: PersistenceEvent[] = [];
	let tail: Promise<unknown> = Promise.resolve();
	const serial = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = tail.then(operation, operation);
		tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
	return {
		appendBatch: (batch, options) =>
			serial(async () => {
				const expectedRevision = options?.expectedRevision;
				if (expectedRevision !== undefined && expectedRevision !== events.length) {
					throw new SessionError("invalid_entry", `Expected revision ${expectedRevision}, found ${events.length}`);
				}
				const seqFrom = events.length + 1;
				const now = new Date().toISOString();
				for (let offset = 0; offset < batch.length; offset++) {
					const event = batch[offset] as Record<string, unknown>;
					events.push({
						...(event as object),
						seq: seqFrom + offset,
						eventId: (event?.eventId as string | undefined) ?? uuidv7(),
						schemaVersion: JOURNAL_SCHEMA_VERSION,
						timestamp: (event?.timestamp as string | undefined) ?? now,
					} as PersistenceEvent);
				}
				return { seqFrom, seqTo: seqFrom + batch.length - 1, revision: events.length };
			}),
		readAfter: (seq) =>
			serial(async () => events.filter((event) => event.seq > seq).map((event) => structuredClone(event))),
		flush: async () => {
			const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
			return {
				path: "<memory>",
				exists: true,
				sessionId: undefined,
				entryCount: events.length,
				revision: events.length,
				lastSeq,
				truncatedTail: false,
			};
		},
		inspect: async () => {
			const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
			return {
				path: "<memory>",
				exists: true,
				sessionId: undefined,
				entryCount: events.length,
				revision: events.length,
				lastSeq,
				truncatedTail: false,
			};
		},
		repairTail: async () => false,
	};
}

export class PersistenceCoordinator implements PersistenceBackend {
	private readonly fs: PersistenceCoordinatorOptions["fs"];
	private readonly filePath: string;
	private readonly sessionId: string;
	private readonly now: () => Date;
	private revision: number;
	private tail: Promise<unknown> = Promise.resolve();

	constructor(options: PersistenceCoordinatorOptions) {
		this.fs = options.fs;
		this.filePath = options.filePath;
		this.sessionId = options.sessionId;
		this.now = options.now ?? (() => new Date());
		this.revision = 0;
	}

	/** Serialize all operations for this session file. */
	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation, operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async load(): Promise<{ events: PersistenceEvent[]; truncatedTail: boolean }> {
		const read = await this.fs.readTextFile(this.filePath);
		if (!read.ok) {
			if (
				((read.error as { code?: string } | undefined)?.code ?? "") === "ENOENT" ||
				(read.error as { code?: string } | undefined)?.code === "not_found"
			) {
				return { events: [], truncatedTail: false };
			}
			throw new SessionError("storage", `Failed to read execution journal ${this.filePath}`, toError(read.error));
		}
		return parseJournalFile(read.value, this.filePath);
	}

	private async writeEvents(events: PersistenceEvent[]): Promise<void> {
		const content = events.map((event) => `${JSON.stringify(event)}\n`).join("");
		const result = await this.fs.appendFile(this.filePath, content);
		if (!result.ok) {
			throw new SessionError(
				"storage",
				`Failed to append execution journal ${this.filePath}`,
				toError(result.error),
			);
		}
	}

	appendBatch(events: unknown[], options?: { expectedRevision?: number }): Promise<PersistenceAppendResult> {
		return this.serial(async () => {
			if (options?.expectedRevision !== undefined && options.expectedRevision !== this.revision) {
				throw new SessionError(
					"invalid_entry",
					`Execution journal ${this.filePath}: expected revision ${options.expectedRevision}, found ${this.revision}`,
				);
			}
			const loaded = await this.load();
			if (loaded.truncatedTail) {
				throw invalidJournal(this.filePath, "journal tail is incomplete; call repairTail() before appending");
			}
			const seqFrom = loaded.events.length + 1;
			const timestamp = this.now().toISOString();
			const prepared: PersistenceEvent[] = events.map((event, offset) => {
				const record = (typeof event === "object" && event !== null ? event : {}) as Record<string, unknown>;
				return {
					...(record as object),
					seq: seqFrom + offset,
					eventId: (record.eventId as string | undefined) ?? uuidv7(),
					schemaVersion: JOURNAL_SCHEMA_VERSION,
					timestamp: (record.timestamp as string | undefined) ?? timestamp,
				} as PersistenceEvent;
			});
			if (prepared.length === 0) {
				return { seqFrom, seqTo: seqFrom - 1, revision: this.revision };
			}
			await this.writeEvents(prepared);
			this.revision = seqFrom + prepared.length - 1;
			return { seqFrom, seqTo: this.revision, revision: this.revision };
		});
	}

	readAfter(seq: number): Promise<PersistenceEvent[]> {
		return this.serial(async () => {
			const loaded = await this.load();
			return loaded.events.filter((event) => event.seq > seq).map((event) => structuredClone(event));
		});
	}

	flush(): Promise<PersistenceInspection> {
		return this.inspect();
	}

	inspect(): Promise<PersistenceInspection> {
		return this.serial(async () => {
			const loaded = await this.load();
			const lastSeq = loaded.events.length > 0 ? loaded.events[loaded.events.length - 1]!.seq : 0;
			return {
				path: this.filePath,
				exists: loaded.events.length > 0 || loaded.truncatedTail,
				sessionId: this.sessionId,
				entryCount: loaded.events.length,
				revision: loaded.events.length,
				lastSeq,
				truncatedTail: loaded.truncatedTail,
			};
		});
	}

	repairTail(): Promise<boolean> {
		return this.serial(async () => {
			const read = await this.fs.readTextFile(this.filePath);
			if (!read.ok) {
				if (
					((read.error as { code?: string } | undefined)?.code ?? "") === "ENOENT" ||
					(read.error as { code?: string } | undefined)?.code === "not_found"
				)
					return false;
				throw new SessionError("storage", `Failed to read execution journal ${this.filePath}`, toError(read.error));
			}
			const { events, truncatedTail } = parseJournalFile(read.value, this.filePath);
			if (!truncatedTail) return false;
			const repaired = events.map((event) => `${JSON.stringify(event)}\n`).join("");
			const result = await this.fs.writeFile(this.filePath, repaired);
			if (!result.ok) {
				throw new SessionError(
					"storage",
					`Failed to repair execution journal ${this.filePath}`,
					toError(result.error),
				);
			}
			this.revision = events.length;
			return true;
		});
	}
}

export type { Result };
