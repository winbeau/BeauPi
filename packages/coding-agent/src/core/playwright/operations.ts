import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateHead } from "../tools/truncate.ts";

const PLAYWRIGHT_TEMP_DIR = join(tmpdir(), "beaupi-playwright");

export interface BoundedPlaywrightText {
	text: string;
	truncated: boolean;
	outputCharacters: number;
	fullOutputPath?: string;
}

export async function boundPlaywrightText(
	value: string,
	options: { maxCharacters: number; prefix: string },
): Promise<BoundedPlaywrightText> {
	const maxBytes = Math.min(50 * 1024, options.maxCharacters);
	const truncation = truncateHead(value, { maxLines: 2_000, maxBytes });
	if (!truncation.truncated && value.length <= options.maxCharacters) {
		return { text: value, truncated: false, outputCharacters: value.length };
	}
	await mkdir(PLAYWRIGHT_TEMP_DIR, { recursive: true, mode: 0o700 });
	const fullOutputPath = join(PLAYWRIGHT_TEMP_DIR, `${options.prefix}-${randomUUID()}.txt`);
	await writeFile(fullOutputPath, value, { encoding: "utf8", mode: 0o600 });
	const characterBounded = truncation.content.slice(0, options.maxCharacters);
	return {
		text: `${characterBounded}\n\n[Output truncated. Full output: ${fullOutputPath}]`,
		truncated: true,
		outputCharacters: characterBounded.length,
		fullOutputPath,
	};
}

export class PlaywrightSerializationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PlaywrightSerializationError";
	}
}

function normalizeSerializable(value: unknown, depth: number, seen: WeakSet<object>): unknown {
	if (depth > 12) throw new PlaywrightSerializationError("Evaluation result exceeded the maximum object depth.");
	if (value === undefined) return "[undefined]";
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return typeof value === "string" && value.length > 20_000 ? `${value.slice(0, 20_000)}... [truncated]` : value;
	}
	if (typeof value === "number") {
		if (Number.isNaN(value)) return "[NaN]";
		if (value === Number.POSITIVE_INFINITY) return "[Infinity]";
		if (value === Number.NEGATIVE_INFINITY) return "[-Infinity]";
		if (Object.is(value, -0)) return "[-0]";
		return value;
	}
	if (typeof value === "bigint") return `[BigInt ${value.toString()}]`;
	if (typeof value === "function" || typeof value === "symbol") {
		throw new PlaywrightSerializationError(`Evaluation result contains unsupported ${typeof value} values.`);
	}
	if (typeof value !== "object") return String(value);
	if (seen.has(value)) throw new PlaywrightSerializationError("Evaluation result contains a circular reference.");
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			const items = value.slice(0, 100).map((item) => normalizeSerializable(item, depth + 1, seen));
			if (value.length > 100) items.push(`[${value.length - 100} more items]`);
			return items;
		}
		const output: Record<string, unknown> = {};
		const entries = Object.entries(value as Record<string, unknown>);
		for (const [key, item] of entries.slice(0, 100)) {
			output[key] = normalizeSerializable(item, depth + 1, seen);
		}
		if (entries.length > 100) output["[truncated keys]"] = entries.length - 100;
		return output;
	} finally {
		seen.delete(value);
	}
}

export function serializePlaywrightEvaluation(value: unknown): string {
	return JSON.stringify(normalizeSerializable(value, 0, new WeakSet()), null, 2);
}

export function parsePngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
	if (bytes.byteLength < 24) return undefined;
	const signature = [137, 80, 78, 71, 13, 10, 26, 10];
	if (!signature.every((byte, index) => bytes[index] === byte)) return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function countRedirects(request: { redirectedFrom(): unknown }): number {
	let count = 0;
	let current = request.redirectedFrom() as { redirectedFrom(): unknown } | null;
	while (current && count < 100) {
		count++;
		current = current.redirectedFrom() as { redirectedFrom(): unknown } | null;
	}
	return count;
}
