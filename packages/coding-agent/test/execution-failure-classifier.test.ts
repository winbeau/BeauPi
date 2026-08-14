import { describe, expect, it } from "vitest";
import { classifyExecutionFailure } from "../src/core/execution/failure-classifier.ts";
import { attachSearchRuntimeToolDetails, type SearchDiagnosticCode } from "../src/core/search/index.ts";
import { BashToolExecutionError } from "../src/core/tools/bash.ts";

function failedSearchDetails(code: SearchDiagnosticCode) {
	return attachSearchRuntimeToolDetails(undefined, {
		version: 1,
		operation: "search",
		ok: false,
		provider: "searxng",
		cacheStatus: "miss",
		budget: {
			limits: {
				maxResultsPerSearch: 10,
				maxQueriesPerTask: 6,
				maxFetchesPerTask: 6,
				maxProviderAttemptsPerTask: 6,
				maxFetchBytes: 1024,
				maxInputCharactersPerTask: 60_000,
				timeoutMs: 100,
				maxRedirects: 3,
			},
			used: { queries: 1, fetches: 0, providerAttempts: 0, inputCharacters: 0 },
			remaining: { queries: 5, fetches: 6, providerAttempts: 6, inputCharacters: 60_000 },
		},
		diagnostics: [{ code, severity: "error", message: "classified" }],
		citations: [],
		untrustedExternalContent: true,
	});
}

describe("execution failure classifier", () => {
	it("classifies structured failures into neutral execution categories", () => {
		for (const scenario of [
			{
				expected: "missing_dependency",
				input: {
					toolName: "bash",
					details: {},
					isError: true,
					thrownError: Object.assign(new Error("missing"), { code: "ENOENT" }),
				},
			},
			{
				expected: "permission",
				input: {
					toolName: "bash",
					details: {},
					isError: true,
					thrownError: Object.assign(new Error("denied"), { code: "EACCES" }),
				},
			},
			{
				expected: "timeout",
				input: {
					toolName: "bash",
					details: {},
					isError: true,
					thrownError: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
				},
			},
			{
				expected: "network",
				input: {
					toolName: "bash",
					details: {},
					isError: true,
					thrownError: Object.assign(new Error("network"), { code: "ECONNREFUSED" }),
				},
			},
			{
				expected: "authentication",
				input: { toolName: "remote_exec", details: { diagnostic: { code: "ssh_authentication" } }, isError: true },
			},
			{
				expected: "session_lost",
				input: {
					toolName: "remote_exec",
					details: { diagnostic: { code: "terminal_session_lost" } },
					isError: true,
				},
			},
			{
				expected: "permission",
				input: { toolName: "remote_exec", details: { diagnostic: { code: "target_untrusted" } }, isError: true },
			},
			{
				expected: "configuration",
				input: { toolName: "remote_exec", details: { diagnostic: { code: "target_mismatch" } }, isError: true },
			},
			{
				expected: "missing_dependency",
				input: {
					toolName: "remote_exec",
					details: { diagnostic: { code: "remote_command", exitCode: 127 } },
					isError: true,
				},
			},
			{
				expected: "permission",
				input: {
					toolName: "remote_exec",
					details: { diagnostic: { code: "remote_command", exitCode: 126 } },
					isError: true,
				},
			},
			{
				expected: "rate_limit",
				input: { toolName: "web_search", details: failedSearchDetails("rate_limited"), isError: true },
			},
			{
				expected: "budget_exhausted",
				input: { toolName: "web_search", details: failedSearchDetails("budget_exhausted"), isError: true },
			},
			{
				expected: "configuration",
				input: { toolName: "web_search", details: failedSearchDetails("not_configured"), isError: true },
			},
		] as const) {
			expect(classifyExecutionFailure(scenario.input)?.category, scenario.expected).toBe(scenario.expected);
		}
	});

	it("reads failureCategory and the real exit code from BashToolExecutionError", () => {
		const failure = classifyExecutionFailure({
			toolName: "bash",
			details: {},
			isError: true,
			thrownError: new BashToolExecutionError("Command exited with code 2", "command_exit", 2),
		});
		expect(failure).toEqual({ category: "command_exit", exitCode: 2, retryable: false });
	});

	it("maps an aborted signal to user_cancelled", () => {
		const controller = new AbortController();
		controller.abort();
		expect(
			classifyExecutionFailure({
				toolName: "bash",
				details: {},
				isError: false,
				signal: controller.signal,
			}),
		).toEqual({ category: "user_cancelled", retryable: false });
	});

	it("returns undefined for successful results", () => {
		expect(classifyExecutionFailure({ toolName: "bash", details: { exitCode: 0 }, isError: false })).toBeUndefined();
	});
});
