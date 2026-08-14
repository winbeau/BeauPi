// Neutral execution failure classification.
//
// Maps structured tool results, thrown errors, and diagnostic payloads to an
// ExecutionFailure fact. This is pure diagnosis: it never affects whether a
// tool executes, only how a failed result is described and whether a retry is
// considered safe.

import { getPlaywrightRuntimeToolDetails } from "../playwright/details.ts";
import { getSearchRuntimeToolDetails } from "../search/types.ts";
import { EXECUTION_FAILURE_CATEGORIES, type ExecutionFailure, type ExecutionFailureCategory } from "./failure-types.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function errorCodes(error: unknown): Set<string> {
	const codes = new Set<string>();
	let current: unknown = error;
	for (let depth = 0; depth < 5; depth++) {
		const record = asRecord(current);
		if (!record) break;
		if (typeof record.code === "string") codes.add(record.code);
		current = record.cause;
	}
	return codes;
}

export function classifyExecutionFailure(input: {
	toolName: string;
	details: unknown;
	isError: boolean;
	thrownError?: unknown;
	signal?: AbortSignal;
}): ExecutionFailure | undefined {
	if (input.signal?.aborted) return { category: "user_cancelled", retryable: false };
	const playwright = getPlaywrightRuntimeToolDetails(input.details);
	if (playwright?.ok === false) {
		const code = playwright.diagnostic?.code;
		const category: ExecutionFailureCategory =
			code === "cancelled"
				? "user_cancelled"
				: code === "timeout"
					? "timeout"
					: code === "browser_unavailable"
						? "missing_dependency"
						: code === "navigation"
							? "network"
							: code === "browser_disconnected"
								? "session_lost"
								: "configuration";
		return { category, retryable: category === "network" || category === "timeout" };
	}
	const search = getSearchRuntimeToolDetails(input.details);
	if (search?.ok === false) {
		const code = search.diagnostics.find((item) => item.severity === "error")?.code;
		const category: ExecutionFailureCategory =
			code === "cancelled"
				? "user_cancelled"
				: code === "authentication"
					? "authentication"
					: code === "rate_limited"
						? "rate_limit"
						: code === "timeout"
							? "timeout"
							: code === "dns" || code === "connection" || code === "tls" || code === "http"
								? "network"
								: code === "budget_exhausted"
									? "budget_exhausted"
									: "configuration";
		return { category, retryable: category === "network" || category === "timeout" };
	}
	const details = asRecord(input.details);
	const diagnostic = asRecord(details?.diagnostic);
	if (diagnostic && typeof diagnostic.code === "string") {
		const code = diagnostic.code;
		const exitCode =
			typeof diagnostic.exitCode === "number" || diagnostic.exitCode === null ? diagnostic.exitCode : undefined;
		const category: ExecutionFailureCategory =
			code === "remote_cancelled"
				? "user_cancelled"
				: code === "ssh_authentication"
					? "authentication"
					: code === "remote_timeout" || code === "ssh_timeout"
						? "timeout"
						: code === "ssh_connection" || code === "ssh_disconnected" || code === "ssh_host_key"
							? "network"
							: code === "terminal_session_lost" || code === "terminal_not_found" || code === "terminal_closed"
								? "session_lost"
								: code === "target_untrusted"
									? "permission"
									: code === "target_invalid" ||
											code === "target_not_found" ||
											code === "target_not_selected" ||
											code === "target_mismatch" ||
											code === "terminal_invalid" ||
											code === "terminal_busy" ||
											code === "adapter_unavailable" ||
											code === "tmux_unavailable"
										? "configuration"
										: code === "remote_command" && exitCode === 127
											? "missing_dependency"
											: code === "remote_command" && exitCode === 126
												? "permission"
												: "command_exit";
		return {
			category,
			exitCode,
			retryable: diagnostic.retryable === true || category === "network" || category === "timeout",
		};
	}
	const thrown = asRecord(input.thrownError);
	if (thrown && typeof thrown.failureCategory === "string") {
		const category = thrown.failureCategory as ExecutionFailureCategory;
		return {
			category,
			exitCode: typeof thrown.exitCode === "number" || thrown.exitCode === null ? thrown.exitCode : undefined,
			retryable: category === "network" || category === "timeout",
		};
	}
	const explicitCategory = details?.failureCategory;
	if (
		typeof explicitCategory === "string" &&
		EXECUTION_FAILURE_CATEGORIES.has(explicitCategory as ExecutionFailureCategory)
	) {
		const category = explicitCategory as ExecutionFailureCategory;
		return {
			category,
			exitCode: typeof details?.exitCode === "number" || details?.exitCode === null ? details.exitCode : undefined,
			retryable: category === "network" || category === "timeout",
		};
	}
	const codes = errorCodes(input.thrownError);
	if (codes.has("ENOENT")) return { category: "missing_dependency", retryable: false };
	if (codes.has("EACCES") || codes.has("EPERM")) return { category: "permission", retryable: false };
	if (codes.has("ETIMEDOUT") || codes.has("UND_ERR_CONNECT_TIMEOUT")) return { category: "timeout", retryable: true };
	if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH"].some((code) => codes.has(code))) {
		return { category: "network", retryable: true };
	}
	const exitCode = typeof details?.exitCode === "number" ? details.exitCode : undefined;
	if (exitCode !== undefined && exitCode !== 0) {
		return {
			category: exitCode === 127 ? "missing_dependency" : exitCode === 126 ? "permission" : "command_exit",
			exitCode,
			retryable: false,
		};
	}
	return input.isError ? { category: "command_exit", retryable: false } : undefined;
}
