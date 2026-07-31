import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	attachSearchRuntimeToolDetails,
	canonicalizeWebUrl,
	classifyNetworkError,
	resolveSearchConfig,
	SearchCache,
	type SearchProvider,
	type SearchProviderContext,
	type SearchProviderRequest,
	type SearchProviderResponse,
	SearchRuntime,
	SearXNGProvider,
} from "../src/core/search/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

class FakeProvider implements SearchProvider {
	readonly id = "fake";
	calls: SearchProviderRequest[] = [];
	response: SearchProviderResponse = { results: [] };
	error?: Error;
	delayMs = 0;

	async search(request: SearchProviderRequest, context: SearchProviderContext): Promise<SearchProviderResponse> {
		this.calls.push(request);
		if (this.delayMs > 0) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, this.delayMs);
				context.signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(new DOMException("aborted", "AbortError"));
					},
					{ once: true },
				);
			});
		}
		if (this.error) throw this.error;
		return structuredClone(this.response);
	}
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "beaupi-search-test-"));
	cleanups.push(async () => await rm(path, { recursive: true, force: true }));
	return path;
}

function config(overrides: Parameters<typeof resolveSearchConfig>[0] = {}) {
	return resolveSearchConfig(
		{
			searxng: { endpoint: "http://unused.test", timeoutMs: 100, maxResults: 10 },
			cache: { queryTtlMs: 1_000, fetchTtlMs: 1_000 },
			budget: {
				maxResultsPerSearch: 10,
				maxQueriesPerTask: 6,
				maxFetchesPerTask: 6,
				maxProviderAttemptsPerTask: 6,
				maxFetchBytes: 1024 * 1024,
				maxInputCharactersPerTask: 60_000,
				timeoutMs: 100,
				maxRedirects: 3,
			},
			...overrides,
		},
		{},
	);
}

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(
		async () =>
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	);
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}`;
}

describe("M8 SearchRuntime", () => {
	it("normalizes queries, prioritizes likely first-party domains, canonicalizes URLs, and deduplicates results", async () => {
		const cacheDir = await tempDir();
		const provider = new FakeProvider();
		provider.response = {
			results: [
				{
					title: "Third-party guide",
					url: "https://blog.example/openai?utm_source=test",
					snippet: "commentary",
					provider: "fake",
					rank: 1,
					score: 0.9,
				},
				{
					title: "OpenAI API documentation",
					url: "https://OPENAI.com/docs/api/?b=2&a=1#intro",
					snippet: "official API reference",
					provider: "fake",
					rank: 2,
					score: 0.5,
				},
				{
					title: "duplicate",
					url: "https://openai.com/docs/api?a=1&b=2&utm_medium=x",
					snippet: "duplicate",
					provider: "fake",
					rank: 3,
					score: 0.1,
				},
			],
		};
		const runtime = new SearchRuntime({ cacheDir, getConfig: () => config(), provider });
		const result = await runtime.search({ query: "  OpenAI   API docs  ", maxResults: 5 }, { budgetScopeId: "task" });

		expect(result.ok).toBe(true);
		expect(provider.calls[0]?.query).toBe("OpenAI API docs");
		expect(result.results).toHaveLength(2);
		expect(result.results[0]).toMatchObject({ domain: "openai.com", priorityReason: "query-domain-match" });
		expect(result.results[0]?.canonicalUrl).toBe("https://openai.com/docs/api?a=1&b=2");
		expect(result.citations[0]).toMatchObject({ kind: "web", level: "search", provider: "fake", rank: 1 });

		const filtered = await runtime.search(
			{ query: "OpenAI API docs", includeDomains: ["blog.example"], excludeDomains: ["openai.com"] },
			{ budgetScopeId: "filters" },
		);
		expect(filtered.results.map((item) => item.domain)).toEqual(["blog.example"]);
		expect(provider.calls).toHaveLength(2);
		expect(provider.calls[1]?.maxResults).toBe(50);
	});

	it("requests a broader provider candidate pool before applying domain filters", async () => {
		const cacheDir = await tempDir();
		const provider = new FakeProvider();
		provider.response.results = [
			...Array.from({ length: 15 }, (_, index) => ({
				title: `Unrelated ${index}`,
				url: `https://example${index}.com/page`,
				snippet: "noise",
				provider: "fake",
				rank: index + 1,
			})),
			{
				title: "Google Search Help",
				url: "https://support.google.com/websearch",
				snippet: "search help",
				provider: "fake",
				rank: 16,
			},
		];
		const runtime = new SearchRuntime({ cacheDir, getConfig: () => config(), provider });
		const result = await runtime.search(
			{ query: "Google Search documentation", maxResults: 3, includeDomains: ["support.google.com"] },
			{ budgetScopeId: "domain-filter" },
		);

		expect(provider.calls[0]).toMatchObject({ maxResults: 50, includeDomains: ["support.google.com"] });
		expect(result.results).toEqual([
			expect.objectContaining({ title: "Google Search Help", domain: "support.google.com" }),
		]);
	});

	it("returns empty results and reuses query cache across equivalent requests until TTL expiry", async () => {
		const cacheDir = await tempDir();
		let now = 1_000;
		const provider = new FakeProvider();
		const runtime = new SearchRuntime({ cacheDir, getConfig: () => config(), provider, now: () => now });

		const first = await runtime.search({ query: " empty   query " }, { budgetScopeId: "task" });
		const second = await runtime.search({ query: "empty query" }, { budgetScopeId: "task" });
		expect(first.ok).toBe(true);
		expect(first.results).toEqual([]);
		expect(second.cacheStatus).toBe("hit");
		expect(provider.calls).toHaveLength(1);

		now = 2_001;
		const expired = await runtime.search({ query: "empty query" }, { budgetScopeId: "task" });
		expect(expired.cacheStatus).toBe("miss");
		expect(provider.calls).toHaveLength(2);
	});

	it("deduplicates concurrent equivalent queries without consuming another provider attempt", async () => {
		const cacheDir = await tempDir();
		const provider = new FakeProvider();
		provider.delayMs = 20;
		provider.response.results = [
			{ title: "Result", url: "https://example.com", snippet: "ok", provider: "fake", rank: 1 },
		];
		const runtime = new SearchRuntime({ cacheDir, getConfig: () => config(), provider });
		const [first, second] = await Promise.all([
			runtime.search({ query: "same query" }, { budgetScopeId: "task" }),
			runtime.search({ query: " same   query " }, { budgetScopeId: "task" }),
		]);
		expect(provider.calls).toHaveLength(1);
		expect([first.cacheStatus, second.cacheStatus]).toContain("deduplicated");
		expect(first.budget.used.providerAttempts).toBe(1);
	});

	it("discards malformed cache entries and rebuilds them without reporting a false cache success", async () => {
		const cacheDir = await tempDir();
		const provider = new FakeProvider();
		provider.response.results = [
			{ title: "Result", url: "https://example.com", snippet: "ok", provider: "fake", rank: 1 },
		];
		const cache = new SearchCache(cacheDir);
		const key = ["fake", "query", "10", ""].join("\0");
		const path = cache.pathFor("queries", key);
		await mkdir(join(cacheDir, "queries"), { recursive: true });
		await writeFile(path, "{broken", "utf-8");
		const runtime = new SearchRuntime({ cacheDir, getConfig: () => config(), provider });

		const result = await runtime.search({ query: "query" }, { budgetScopeId: "task" });
		expect(result.ok).toBe(true);
		expect(result.cacheStatus).toBe("miss");
		expect(result.diagnostics.map((item) => item.code)).toContain("cache_corrupt");
		expect(provider.calls).toHaveLength(1);
	});

	it("enforces result, query, provider-attempt, character, timeout, and cancellation budgets deterministically", async () => {
		const cacheDir = await tempDir();
		const provider = new FakeProvider();
		provider.response.results = [
			{
				title: "Long result",
				url: "https://example.com/page",
				snippet: "x".repeat(500),
				provider: "fake",
				rank: 1,
			},
		];
		const tight = config({
			budget: {
				maxResultsPerSearch: 1,
				maxQueriesPerTask: 2,
				maxFetchesPerTask: 1,
				maxProviderAttemptsPerTask: 1,
				maxFetchBytes: 1024,
				maxInputCharactersPerTask: 120,
				timeoutMs: 10,
				maxRedirects: 0,
			},
			cache: { queryTtlMs: 0, fetchTtlMs: 0 },
		});
		const runtime = new SearchRuntime({ cacheDir, getConfig: () => tight, provider });

		const tooMany = await runtime.search({ query: "one", maxResults: 2 }, { budgetScopeId: "results" });
		expect(tooMany.diagnostics[0]?.code).toBe("budget_exhausted");
		expect(provider.calls).toHaveLength(0);

		const truncated = await runtime.search({ query: "one" }, { budgetScopeId: "task" });
		expect(truncated.budget.exhausted).toBe("input_characters");
		expect(truncated.results[0]?.snippet.length).toBeLessThan(500);
		const noCharacters = await runtime.search({ query: "two" }, { budgetScopeId: "task" });
		expect(noCharacters.ok).toBe(false);
		expect(noCharacters.budget.exhausted).toBe("input_characters");

		const attemptConfig = {
			...tight,
			budget: { ...tight.budget, maxInputCharactersPerTask: 60_000 },
		};
		const attempts = new SearchRuntime({
			cacheDir: join(cacheDir, "attempts"),
			getConfig: () => attemptConfig,
			provider,
		});
		await attempts.search({ query: "first" }, { budgetScopeId: "attempts" });
		const attemptLimit = await attempts.search({ query: "second" }, { budgetScopeId: "attempts" });
		expect(attemptLimit.budget.exhausted).toBe("provider_attempts");

		provider.delayMs = 50;
		const timeoutRuntime = new SearchRuntime({
			cacheDir: join(cacheDir, "timeout"),
			getConfig: () => tight,
			provider,
		});
		const timedOut = await timeoutRuntime.search({ query: "slow" }, { budgetScopeId: "timeout" });
		expect(timedOut.diagnostics[0]?.code).toBe("timeout");

		const controller = new AbortController();
		const cancelledPromise = timeoutRuntime.search(
			{ query: "cancel" },
			{ budgetScopeId: "cancel", signal: controller.signal },
		);
		controller.abort();
		const cancelled = await cancelledPromise;
		expect(cancelled.diagnostics[0]?.code).toBe("cancelled");
	});

	it("stops immediately on missing provider configuration without a fallback attempt", async () => {
		const cacheDir = await tempDir();
		const missing = resolveSearchConfig({}, {});
		const runtime = new SearchRuntime({ cacheDir, getConfig: () => missing });
		const result = await runtime.search({ query: "configured?" }, { budgetScopeId: "task" });
		expect(result.ok).toBe(false);
		expect(result.diagnostics[0]?.code).toBe("not_configured");
		expect(result.budget.used.providerAttempts).toBe(0);
	});

	it("never leaks provider secrets through structured diagnostics", async () => {
		const cacheDir = await tempDir();
		const provider = new FakeProvider();
		const secret = "super-secret-provider-token";
		provider.error = new Error(`failed with ${secret}`);
		const runtime = new SearchRuntime({ cacheDir, getConfig: () => config(), provider });
		const result = await runtime.search({ query: "secret test" }, { budgetScopeId: "task" });
		const serialized = JSON.stringify(result);
		expect(result.ok).toBe(false);
		expect(serialized).not.toContain(secret);
	});

	it("resolves Settings and environment overrides without persisting secret values", () => {
		const manager = SettingsManager.inMemory({
			search: {
				searxng: {
					endpoint: "https://settings.example/search",
					engines: [" bing ", "mojeek", "bing", "invalid,engine"],
					apiKeyEnv: "CUSTOM_SEARCH_KEY",
				},
				budget: { maxQueriesPerTask: 3 },
			},
		});
		const resolved = resolveSearchConfig(manager.getSearchSettings(), {
			BEAUPI_SEARXNG_ENDPOINT: "https://env.example/search",
			CUSTOM_SEARCH_KEY: "secret-value",
		});
		expect(resolved.searxng.endpoint).toBe("https://env.example/search");
		expect(resolved.searxng.apiKey).toBe("secret-value");
		expect(resolved.searxng.engines).toEqual(["bing", "mojeek"]);
		expect(resolved.budget.maxQueriesPerTask).toBe(3);
		expect(JSON.stringify(manager.getGlobalSettings())).not.toContain("secret-value");
	});

	it("implements the SearXNG JSON API and classifies auth, rate-limit, engine, and malformed responses", async () => {
		let mode: "success" | "auth" | "rate" | "engines" | "invalid" = "success";
		const server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://localhost");
			if (mode === "auth") {
				response.writeHead(401).end("unauthorized");
				return;
			}
			if (mode === "rate") {
				response.writeHead(429, { "retry-after": "2" }).end("limited");
				return;
			}
			if (mode === "engines") {
				response.writeHead(200, { "content-type": "application/json" }).end(
					JSON.stringify({
						results: [],
						unresponsive_engines: [["bing", "Suspended: too many requests"]],
					}),
				);
				return;
			}
			if (mode === "invalid") {
				response.writeHead(200, { "content-type": "application/json" }).end("not-json");
				return;
			}
			expect(url.searchParams.get("engines")).toBe("bing,mojeek");
			response.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({
					results: [{ title: "Found", url: "https://example.com", content: url.searchParams.get("q"), score: 1 }],
				}),
			);
		});
		const endpoint = await listen(server);
		const provider = new SearXNGProvider({ endpoint, engines: ["bing", "mojeek", "bing"] });
		const success = await provider.search(
			{ query: "needle", maxResults: 3, includeDomains: ["example.com"] },
			{ timeoutMs: 100 },
		);
		expect(success.results[0]).toMatchObject({
			title: "Found",
			snippet: "needle site:example.com",
			provider: "searxng",
		});

		for (const [nextMode, expected] of [
			["auth", "authentication"],
			["rate", "rate_limited"],
			["engines", "rate_limited"],
			["invalid", "invalid_response"],
		] as const) {
			mode = nextMode;
			await expect(provider.search({ query: "x", maxResults: 1 }, { timeoutMs: 100 })).rejects.toMatchObject({
				diagnostic: { code: expected },
			});
		}
	});

	it("restores cumulative budgets on resume and resets them to the selected Session branch facts", async () => {
		const cacheDir = await tempDir();
		const provider = new FakeProvider();
		const branchConfig = config({ cache: { queryTtlMs: 0, fetchTtlMs: 0 } });
		const runtime = new SearchRuntime({ cacheDir, getConfig: () => branchConfig, provider });
		const manager = SessionManager.inMemory("/repo");
		const userId = manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "research" }],
			timestamp: 1,
		});
		manager.appendMessage(
			fauxAssistantMessage(fauxToolCall("web_search", { query: "old" }, { id: "old-search" }), {
				stopReason: "toolUse",
			}),
		);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "old-search",
			toolName: "web_search",
			content: [{ type: "text", text: "old" }],
			details: attachSearchRuntimeToolDetails(undefined, {
				version: 1,
				operation: "search",
				ok: true,
				provider: "fake",
				cacheStatus: "miss",
				budget: {
					limits: branchConfig.budget,
					used: { queries: 1, fetches: 0, providerAttempts: 1, inputCharacters: 0 },
					remaining: { queries: 5, fetches: 6, providerAttempts: 5, inputCharacters: 60_000 },
				},
				diagnostics: [],
				citations: [],
				untrustedExternalContent: true,
			}),
			isError: false,
			timestamp: 3,
		});

		const resumed = await runtime.search(
			{ query: "resumed" },
			{ budgetScopeId: manager.getSessionId(), sessionEntries: manager.getBranch() },
		);
		expect(resumed.budget.used.queries).toBe(2);

		manager.branch(userId);
		const switched = await runtime.search(
			{ query: "current branch" },
			{ budgetScopeId: manager.getSessionId(), sessionEntries: manager.getBranch() },
		);
		expect(switched.budget.used.queries).toBe(1);
	});

	it("classifies provider DNS, connection, and TLS transport failures without raw error text", () => {
		const dns = Object.assign(new Error("secret DNS detail"), { code: "ENOTFOUND" });
		const connection = Object.assign(new Error("secret connection detail"), { code: "ECONNREFUSED" });
		const tls = Object.assign(new Error("wrapper"), {
			code: "UND_ERR_SOCKET",
			cause: Object.assign(new Error("secret certificate detail"), { code: "CERT_HAS_EXPIRED" }),
		});
		expect(classifyNetworkError(dns, { operation: "provider", cancelled: false, timedOut: false }).code).toBe("dns");
		expect(classifyNetworkError(connection, { operation: "provider", cancelled: false, timedOut: false }).code).toBe(
			"connection",
		);
		expect(classifyNetworkError(tls, { operation: "provider", cancelled: false, timedOut: false }).code).toBe("tls");
		expect(
			JSON.stringify(classifyNetworkError(tls, { operation: "provider", cancelled: false, timedOut: false })),
		).not.toContain("secret certificate detail");
	});

	it("canonicalizes stable HTTP/HTTPS URLs and rejects credentials", () => {
		expect(canonicalizeWebUrl("HTTPS://Example.COM:443/a/../b/?z=2&utm_source=x&a=1#part")).toBe(
			"https://example.com/b?a=1&z=2",
		);
		expect(() => canonicalizeWebUrl("https://user:pass@example.com/")).toThrow("credentials");
	});
});
