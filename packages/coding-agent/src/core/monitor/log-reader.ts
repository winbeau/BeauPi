import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export interface IncrementalLogReadOptions {
	monitorId: string;
	path: string;
	cursor?: number;
	hash?: string;
	prefixHash?: string;
	mode?: "incremental" | "full";
}

export interface IncrementalLogReadResult {
	path: string;
	content: string;
	cursor: number;
	hash: string;
	prefixHash: string;
	changed: boolean;
	truncated: boolean;
	rotated: boolean;
	missing: boolean;
	diagnostic?: string;
}

interface LogCursorState {
	cursor: number;
	hash?: string;
	prefixHash?: string;
	device?: number;
	inode?: number;
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function asNonNegativeInteger(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isInteger(value) || value < 0) return undefined;
	return value;
}

/**
 * Reads log files without re-emitting bytes already consumed by this monitor.
 * The complete file is hashed when it is read so truncation and rotation are
 * detected deterministically even when a file is replaced without changing its
 * size or mtime.
 */
export class IncrementalLogReader {
	private readonly cursors = new Map<string, LogCursorState>();

	async read(options: IncrementalLogReadOptions): Promise<IncrementalLogReadResult> {
		const requestedCursor = asNonNegativeInteger(options.cursor);
		const previous = this.cursors.get(options.monitorId) ?? {
			cursor: requestedCursor ?? 0,
			hash: options.hash,
			prefixHash: options.prefixHash,
		};

		let file: string;
		try {
			file = await readFile(options.path, "utf8");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				path: options.path,
				content: "",
				cursor: previous.cursor,
				hash: previous.hash ?? "",
				prefixHash: previous.prefixHash ?? "",
				changed: false,
				truncated: false,
				rotated: false,
				missing: true,
				diagnostic: `Log file unavailable: ${message}`,
			};
		}

		let fileStat: { dev?: number; ino?: number } | undefined;
		try {
			fileStat = await stat(options.path);
		} catch {
			// The read succeeded, so the file is usable. A concurrent rotation can
			// make stat fail and is handled as an ordinary content comparison.
		}

		const currentHash = hashText(file);
		const full = options.mode === "full";
		const baseCursor = requestedCursor ?? previous.cursor;
		const previousPrefixHash = previous.prefixHash;
		const currentPrefixHash = hashText(file.slice(0, Math.min(baseCursor, file.length)));
		const identityChanged =
			fileStat !== undefined &&
			previous.device !== undefined &&
			previous.inode !== undefined &&
			(fileStat.dev !== previous.device || fileStat.ino !== previous.inode);
		const truncated = baseCursor > file.length;
		const prefixChanged =
			baseCursor > 0 && previousPrefixHash !== undefined && currentPrefixHash !== previousPrefixHash;
		const rotated = identityChanged || (baseCursor > 0 && prefixChanged);
		const changed = currentHash !== previous.hash || truncated || rotated;

		const start = full || rotated || truncated ? 0 : Math.min(baseCursor, file.length);
		const content = full ? file : changed ? file.slice(start) : "";
		const nextCursor = full ? file.length : changed ? file.length : baseCursor;
		const nextState: LogCursorState = {
			cursor: nextCursor,
			hash: currentHash,
			prefixHash: hashText(file.slice(0, nextCursor)),
			device: fileStat?.dev,
			inode: fileStat?.ino,
		};
		this.cursors.set(options.monitorId, nextState);

		return {
			path: options.path,
			content,
			cursor: nextCursor,
			hash: currentHash,
			prefixHash: nextState.prefixHash ?? "",
			changed: full || changed,
			truncated,
			rotated,
			missing: false,
		};
	}

	forget(monitorId: string): void {
		this.cursors.delete(monitorId);
	}

	clear(): void {
		this.cursors.clear();
	}
}
