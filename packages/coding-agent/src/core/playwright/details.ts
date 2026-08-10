import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	PlaywrightAction,
	PlaywrightDiagnostic,
	PlaywrightRuntimeToolDetailsV1,
	PlaywrightToolDetails,
} from "./types.ts";
import { PLAYWRIGHT_RUNTIME_DETAILS_KEY, PLAYWRIGHT_RUNTIME_DETAILS_VERSION } from "./types.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function isAction(value: unknown): value is PlaywrightAction {
	return (
		value === "navigate" ||
		value === "snapshot" ||
		value === "act" ||
		value === "screenshot" ||
		value === "evaluate" ||
		value === "events" ||
		value === "pages"
	);
}

function isDiagnostic(value: unknown): value is PlaywrightDiagnostic {
	const record = asRecord(value);
	return !!record && typeof record.code === "string" && typeof record.message === "string";
}

export function getPlaywrightRuntimeToolDetails(details: unknown): PlaywrightRuntimeToolDetailsV1 | undefined {
	const record = asRecord(asRecord(details)?.[PLAYWRIGHT_RUNTIME_DETAILS_KEY]);
	if (
		!record ||
		record.version !== PLAYWRIGHT_RUNTIME_DETAILS_VERSION ||
		!isAction(record.operation) ||
		typeof record.ok !== "boolean" ||
		typeof record.durationMs !== "number" ||
		!Number.isFinite(record.durationMs) ||
		(record.diagnostic !== undefined && !isDiagnostic(record.diagnostic))
	) {
		return undefined;
	}
	return record as unknown as PlaywrightRuntimeToolDetailsV1;
}

export function attachPlaywrightRuntimeToolDetails(
	details: unknown,
	metadata: PlaywrightRuntimeToolDetailsV1,
): PlaywrightToolDetails {
	const record = asRecord(details);
	return {
		...(record ?? {}),
		[PLAYWRIGHT_RUNTIME_DETAILS_KEY]: structuredClone(metadata),
	} as PlaywrightToolDetails;
}

export function createPlaywrightRuntimeDetails(
	operation: PlaywrightAction,
	startedAt: number,
	fields: Omit<PlaywrightRuntimeToolDetailsV1, "version" | "operation" | "durationMs">,
): PlaywrightRuntimeToolDetailsV1 {
	return {
		version: PLAYWRIGHT_RUNTIME_DETAILS_VERSION,
		operation,
		durationMs: Math.max(0, Date.now() - startedAt),
		...fields,
	};
}

export function playwrightErrorResult(
	operation: PlaywrightAction,
	startedAt: number,
	diagnostic: PlaywrightDiagnostic,
	fields: Partial<
		Omit<PlaywrightRuntimeToolDetailsV1, "version" | "operation" | "ok" | "durationMs" | "diagnostic">
	> = {},
): AgentToolResult<PlaywrightToolDetails> {
	const metadata = createPlaywrightRuntimeDetails(operation, startedAt, {
		...fields,
		ok: false,
		diagnostic,
	});
	return {
		content: [{ type: "text", text: `Playwright ${operation} failed: ${diagnostic.message}` }],
		details: attachPlaywrightRuntimeToolDetails(undefined, metadata),
	};
}
