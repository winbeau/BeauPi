/**
 * Adapted from DeepSeek-Reasonix internal/agent/cache_shape.go
 * (MIT, Copyright (c) 2026 Reasonix Contributors).
 * See docs/third-party/reasonix.md for the full notice and modification notes.
 */

import { createHash } from "node:crypto";
import type { Tool } from "@earendil-works/pi-ai";

export interface PrefixShape {
	systemHash: string;
	toolsHash: string;
	prefixHash: string;
	toolSchemaTokens: number;
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function compareTools(left: Tool, right: Tool): number {
	if (left.name !== right.name) return left.name < right.name ? -1 : 1;
	if (left.description !== right.description) return left.description < right.description ? -1 : 1;
	const leftParameters = JSON.stringify(left.parameters);
	const rightParameters = JSON.stringify(right.parameters);
	return leftParameters < rightParameters ? -1 : leftParameters > rightParameters ? 1 : 0;
}

function normalizeTools(tools: Tool[]): Array<Pick<Tool, "name" | "description" | "parameters">> {
	return [...tools].sort(compareTools).map(({ name, description, parameters }) => ({ name, description, parameters }));
}

/** Capture deterministic hashes for the provider-visible system/tools prefix. */
export function capturePrefixShape(systemPrompt: string, tools: Tool[]): PrefixShape {
	const normalizedTools = normalizeTools(tools);
	const toolsJson = JSON.stringify(normalizedTools);
	const systemHash = shortHash(systemPrompt);
	const toolsHash = shortHash(toolsJson);

	return {
		systemHash,
		toolsHash,
		prefixHash: shortHash(systemHash + toolsHash),
		toolSchemaTokens: Math.floor(Buffer.byteLength(toolsJson, "utf8") / 4),
	};
}

/** Return provider-visible prefix segments that changed since the previous turn. */
export function comparePrefixShape(prev: PrefixShape | undefined, cur: PrefixShape): string[] {
	if (!prev) return [];
	const reasons: string[] = [];
	if (prev.systemHash !== cur.systemHash) reasons.push("system");
	if (prev.toolsHash !== cur.toolsHash) reasons.push("tools");
	return reasons;
}
