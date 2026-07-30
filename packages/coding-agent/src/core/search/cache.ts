import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SEARCH_CACHE_VERSION, type SearchDiagnostic } from "./types.ts";

export interface SearchCacheEntry<T> {
	version: typeof SEARCH_CACHE_VERSION;
	canonicalKey: string;
	source: string;
	fetchedAt: string;
	expiresAt: string;
	contentHash: string;
	value: T;
}

export interface SearchCacheReadResult<T> {
	entry?: SearchCacheEntry<T>;
	diagnostics: SearchDiagnostic[];
	expired: boolean;
}

function cacheDigest(key: string): string {
	return createHash("sha256").update(key).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parseEntry<T>(value: unknown, expectedKey: string): SearchCacheEntry<T> | undefined {
	const record = asRecord(value);
	if (
		!record ||
		record.version !== SEARCH_CACHE_VERSION ||
		record.canonicalKey !== expectedKey ||
		typeof record.source !== "string" ||
		typeof record.fetchedAt !== "string" ||
		typeof record.expiresAt !== "string" ||
		typeof record.contentHash !== "string" ||
		!("value" in record)
	) {
		return undefined;
	}
	return record as unknown as SearchCacheEntry<T>;
}

export class SearchCache {
	private readonly root: string;
	private readonly now: () => number;

	constructor(root: string, now: () => number = Date.now) {
		this.root = root;
		this.now = now;
	}

	pathFor(kind: "queries" | "urls", canonicalKey: string): string {
		return join(this.root, kind, `${cacheDigest(canonicalKey)}.json`);
	}

	async read<T>(kind: "queries" | "urls", canonicalKey: string): Promise<SearchCacheReadResult<T>> {
		const path = this.pathFor(kind, canonicalKey);
		let text: string;
		try {
			text = await readFile(path, "utf-8");
		} catch (error) {
			if (isFileNotFound(error)) return { diagnostics: [], expired: false };
			return {
				diagnostics: [
					{
						code: "cache_read_failed",
						severity: "warning",
						message: "Search cache could not be read; the network result will be rebuilt safely.",
					},
				],
				expired: false,
			};
		}
		try {
			const entry = parseEntry<T>(JSON.parse(text), canonicalKey);
			if (!entry) throw new Error("invalid cache entry");
			const expiresAt = Date.parse(entry.expiresAt);
			if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
				await rm(path, { force: true }).catch(() => {});
				return { diagnostics: [], expired: true };
			}
			return { entry, diagnostics: [], expired: false };
		} catch {
			await rm(path, { force: true }).catch(() => {});
			return {
				diagnostics: [
					{
						code: "cache_corrupt",
						severity: "warning",
						message: "A damaged search cache entry was discarded and will be rebuilt.",
					},
				],
				expired: false,
			};
		}
	}

	async remove(kind: "queries" | "urls", canonicalKey: string): Promise<void> {
		await rm(this.pathFor(kind, canonicalKey), { force: true }).catch(() => {});
	}

	async write<T>(kind: "queries" | "urls", entry: SearchCacheEntry<T>): Promise<SearchDiagnostic | undefined> {
		const path = this.pathFor(kind, entry.canonicalKey);
		const temporaryPath = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		try {
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await writeFile(temporaryPath, JSON.stringify(entry), { encoding: "utf-8", mode: 0o600 });
			await rename(temporaryPath, path);
			return undefined;
		} catch {
			await rm(temporaryPath, { force: true }).catch(() => {});
			return {
				code: "cache_write_failed",
				severity: "warning",
				message: "The network result succeeded, but its cache entry could not be saved.",
			};
		}
	}
}

function isFileNotFound(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}
