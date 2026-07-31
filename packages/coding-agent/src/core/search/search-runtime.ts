import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "../session-manager.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateHead } from "../tools/truncate.ts";
import { SearchBudgetManager } from "./budget.ts";
import { SearchCache, type SearchCacheEntry } from "./cache.ts";
import { classifyNetworkError, createTimedSignal, SearchRuntimeError } from "./errors.ts";
import { extractHtmlToMarkdown, extractJsonContent, extractTextContent } from "./html.ts";
import {
	canonicalizeWebUrl,
	canonicalSearchQuery,
	displayWebUrl,
	normalizeAndRankResults,
	normalizeDomains,
	normalizeSearchQuery,
} from "./normalize.ts";
import { SearXNGProvider } from "./searxng-provider.ts";
import {
	type FetchExecutionResult,
	hashWebContent,
	type ResolvedSearchConfig,
	type SearchCacheStatus,
	type SearchDiagnostic,
	type SearchExecutionResult,
	type SearchProvider,
	type SearchResult,
	stableWebId,
	type WebCitation,
} from "./types.ts";
import { SafeWebClient, unsupportedContentTypeDiagnostic } from "./web-client.ts";

interface CachedSearchValue {
	query: string;
	results: SearchResult[];
}

interface CachedFetchValue {
	requestedUrl: string;
	finalUrl: string;
	title: string;
	contentType: string;
	content: string;
	summary: string;
	redirects: number;
}

interface PendingSearchResult {
	entry: SearchCacheEntry<CachedSearchValue>;
	diagnostics: SearchDiagnostic[];
}

interface PendingFetchResult {
	entry: SearchCacheEntry<CachedFetchValue>;
	diagnostics: SearchDiagnostic[];
}

function isCachedSearchValue(value: unknown): value is CachedSearchValue {
	if (typeof value !== "object" || value === null || !("query" in value) || !("results" in value)) return false;
	const record = value as { query?: unknown; results?: unknown };
	return (
		typeof record.query === "string" &&
		Array.isArray(record.results) &&
		record.results.every(
			(result) =>
				typeof result === "object" &&
				result !== null &&
				typeof (result as { title?: unknown }).title === "string" &&
				typeof (result as { canonicalUrl?: unknown }).canonicalUrl === "string" &&
				typeof (result as { provider?: unknown }).provider === "string" &&
				typeof (result as { rank?: unknown }).rank === "number",
		)
	);
}

function isCachedFetchValue(value: unknown): value is CachedFetchValue {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<Record<keyof CachedFetchValue, unknown>>;
	return (
		typeof record.requestedUrl === "string" &&
		typeof record.finalUrl === "string" &&
		typeof record.title === "string" &&
		typeof record.contentType === "string" &&
		typeof record.content === "string" &&
		typeof record.summary === "string" &&
		typeof record.redirects === "number"
	);
}

function corruptCacheDiagnostic(): SearchDiagnostic {
	return {
		code: "cache_corrupt",
		severity: "warning",
		message: "A damaged search cache entry was discarded and will be rebuilt.",
	};
}

export interface SearchRuntimeOptions {
	cacheDir: string;
	getConfig: () => ResolvedSearchConfig;
	provider?: SearchProvider;
	webClient?: SafeWebClient;
	now?: () => number;
}

export interface SearchRuntimeCallContext {
	budgetScopeId: string;
	signal?: AbortSignal;
	sessionEntries?: readonly SessionEntry[];
}

export interface SearchRuntimeSearchInput {
	query: string;
	maxResults?: number;
	includeDomains?: readonly string[];
	excludeDomains?: readonly string[];
}

function budgetDiagnostic(
	kind: "results" | "queries" | "fetches" | "provider_attempts" | "input_characters",
	severity: SearchDiagnostic["severity"] = "error",
): SearchDiagnostic {
	const labels = {
		results: "per-search result",
		queries: "per-task query",
		fetches: "per-task fetch",
		provider_attempts: "provider attempt",
		input_characters: "total input character",
	} as const;
	return {
		code: "budget_exhausted",
		severity,
		message: `The M8 ${labels[kind]} budget was exhausted; no equivalent network fallback was attempted.`,
		suggestion: `Adjust search.budget.${
			kind === "results"
				? "maxResultsPerSearch"
				: kind === "queries"
					? "maxQueriesPerTask"
					: kind === "fetches"
						? "maxFetchesPerTask"
						: kind === "provider_attempts"
							? "maxProviderAttemptsPerTask"
							: "maxInputCharactersPerTask"
		} only if the task requires a larger trusted budget.`,
	};
}

function queryCacheKey(
	provider: string,
	query: string,
	candidateLimit: number,
	includeDomains: readonly string[],
): string {
	return [provider, canonicalSearchQuery(query), String(candidateLimit), includeDomains.join(",")].join("\0");
}

function searchCitation(result: SearchResult, fetchedAt: string): WebCitation {
	return {
		kind: "web",
		id: stableWebId("web_search", result.canonicalUrl),
		level: "search",
		url: result.canonicalUrl,
		displayUrl: displayWebUrl(result.canonicalUrl),
		domain: result.domain ?? new URL(result.canonicalUrl).hostname,
		title: result.title,
		provider: result.provider,
		fetchedAt,
		rank: result.rank,
	};
}

function contentCitation(value: CachedFetchValue, contentHash: string, fetchedAt: string): WebCitation {
	return {
		kind: "web",
		id: stableWebId("web_content", value.finalUrl, contentHash),
		level: "content",
		url: value.finalUrl,
		displayUrl: displayWebUrl(value.finalUrl),
		domain: new URL(value.finalUrl).hostname,
		title: value.title,
		provider: "web_fetch",
		fetchedAt,
		contentHash,
	};
}

function resultCharacterCost(result: SearchResult): number {
	return result.title.length + result.canonicalUrl.length + result.snippet.length + 32;
}

function fitSearchResults(
	results: readonly SearchResult[],
	remaining: number,
): {
	results: SearchResult[];
	characters: number;
	truncated: boolean;
} {
	const output: SearchResult[] = [];
	let characters = 0;
	let truncated = false;
	for (const result of results) {
		const fullCost = resultCharacterCost(result);
		if (characters + fullCost <= remaining) {
			output.push(result);
			characters += fullCost;
			continue;
		}
		const fixedCost = result.title.length + result.canonicalUrl.length + 32;
		const snippetBudget = remaining - characters - fixedCost;
		if (snippetBudget > 0) {
			const snippet =
				result.snippet.length > snippetBudget
					? `${result.snippet.slice(0, Math.max(0, snippetBudget - 1))}…`
					: result.snippet;
			const fitted = { ...result, snippet };
			output.push(fitted);
			characters += resultCharacterCost(fitted);
		}
		truncated = true;
		break;
	}
	return { results: output, characters: Math.min(characters, remaining), truncated };
}

function truncateByCharacters(content: string, maxCharacters: number): TruncationResult {
	const standard = truncateHead(content);
	if (standard.content.length <= maxCharacters) return standard;
	const truncatedContent = standard.content.slice(0, Math.max(0, maxCharacters));
	return {
		content: truncatedContent,
		truncated: true,
		truncatedBy: "bytes",
		totalLines: content ? content.split("\n").length : 0,
		totalBytes: Buffer.byteLength(content, "utf-8"),
		outputLines: truncatedContent ? truncatedContent.split("\n").length : 0,
		outputBytes: Buffer.byteLength(truncatedContent, "utf-8"),
		lastLinePartial: truncatedContent.length > 0 && !truncatedContent.endsWith("\n"),
		firstLineExceedsLimit: false,
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: Math.min(DEFAULT_MAX_BYTES, Buffer.byteLength(truncatedContent, "utf-8")),
	};
}

async function writeFullContent(content: string): Promise<string> {
	const path = join(tmpdir(), `beaupi-web-${randomBytes(8).toString("hex")}.md`);
	await writeFile(path, content, { encoding: "utf-8", mode: 0o600 });
	return path;
}

function decodeBody(body: Buffer, contentType: string, fallbackTitle: string): CachedFetchValue {
	const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
	if (contentType === "text/html" || contentType === "application/xhtml+xml") {
		const extracted = extractHtmlToMarkdown(text, fallbackTitle);
		return {
			requestedUrl: "",
			finalUrl: "",
			title: extracted.title,
			contentType,
			content: extracted.markdown,
			summary: extracted.summary,
			redirects: 0,
		};
	}
	if (contentType === "text/plain" || contentType === "text/markdown") {
		const extracted = extractTextContent(text, fallbackTitle);
		return {
			requestedUrl: "",
			finalUrl: "",
			title: extracted.title,
			contentType,
			content: extracted.markdown,
			summary: extracted.summary,
			redirects: 0,
		};
	}
	if (contentType === "application/json" || contentType.endsWith("+json")) {
		try {
			const extracted = extractJsonContent(text, fallbackTitle);
			return {
				requestedUrl: "",
				finalUrl: "",
				title: extracted.title,
				contentType,
				content: extracted.markdown,
				summary: extracted.summary,
				redirects: 0,
			};
		} catch {
			throw new SearchRuntimeError({
				code: "invalid_response",
				severity: "error",
				message: "The web target returned invalid JSON.",
			});
		}
	}
	throw new SearchRuntimeError(unsupportedContentTypeDiagnostic(contentType));
}

export class SearchRuntime {
	private readonly getConfig: () => ResolvedSearchConfig;
	private readonly injectedProvider?: SearchProvider;
	private readonly webClient: SafeWebClient;
	private readonly cache: SearchCache;
	private readonly budget = new SearchBudgetManager();
	private readonly now: () => number;
	private readonly pendingSearches = new Map<string, Promise<PendingSearchResult>>();
	private readonly pendingFetches = new Map<string, Promise<PendingFetchResult>>();

	constructor(options: SearchRuntimeOptions) {
		this.getConfig = options.getConfig;
		this.injectedProvider = options.provider;
		this.webClient = options.webClient ?? new SafeWebClient();
		this.now = options.now ?? Date.now;
		this.cache = new SearchCache(options.cacheDir, this.now);
	}

	synchronizeBudget(scopeId: string, entries: readonly SessionEntry[]): void {
		this.budget.synchronize(scopeId, entries);
	}

	async search(input: SearchRuntimeSearchInput, context: SearchRuntimeCallContext): Promise<SearchExecutionResult> {
		if (context.sessionEntries) this.budget.synchronize(context.budgetScopeId, context.sessionEntries);
		const config = this.getConfig();
		const normalizedQuery = normalizeSearchQuery(input.query);
		const failure = (
			diagnostics: SearchDiagnostic[],
			exhausted?: "results" | "queries" | "provider_attempts" | "input_characters",
			provider?: string,
		): SearchExecutionResult => ({
			ok: false,
			query: input.query,
			normalizedQuery,
			results: [],
			citations: [],
			provider,
			cacheStatus: config.cache.queryTtlMs === 0 ? "disabled" : "miss",
			diagnostics,
			budget: this.budget.snapshot(context.budgetScopeId, config.budget, exhausted),
		});
		if (!config.enabled) {
			return failure([
				{
					code: "not_configured",
					severity: "error",
					message: "Web search is disabled in settings.",
					suggestion: "Set search.enabled to true before using web_search.",
				},
			]);
		}
		if (!normalizedQuery) {
			return failure([{ code: "invalid_response", severity: "error", message: "Search query is empty." }]);
		}
		const requestedResults = Math.max(
			1,
			Math.floor(input.maxResults ?? Math.min(config.searxng.maxResults, config.budget.maxResultsPerSearch)),
		);
		const includeDomains = normalizeDomains(input.includeDomains);
		const excludeDomains = normalizeDomains(input.excludeDomains);
		const providerCandidateLimit =
			includeDomains.length > 0 || excludeDomains.length > 0
				? 50
				: Math.min(config.searxng.maxResults, config.budget.maxResultsPerSearch);
		if (requestedResults > config.budget.maxResultsPerSearch) {
			return failure([budgetDiagnostic("results")], "results");
		}
		if (!this.budget.reserveQuery(context.budgetScopeId, config.budget)) {
			return failure([budgetDiagnostic("queries")], "queries");
		}
		if (this.budget.remainingCharacters(context.budgetScopeId, config.budget) <= 0) {
			return failure([budgetDiagnostic("input_characters")], "input_characters");
		}

		if (!this.injectedProvider && !config.searxng.endpoint) {
			return failure(
				[
					{
						code: "not_configured",
						severity: "error",
						message: "SearXNG is not configured.",
						suggestion: "Set search.searxng.endpoint or BEAUPI_SEARXNG_ENDPOINT.",
					},
				],
				undefined,
				"searxng",
			);
		}
		if (!this.injectedProvider && config.searxng.apiKeyRequired && !config.searxng.apiKey) {
			return failure(
				[
					{
						code: "not_configured",
						severity: "error",
						message: "The configured SearXNG API key environment variable is missing.",
						suggestion: "Set the configured environment variable before retrying web_search.",
					},
				],
				undefined,
				"searxng",
			);
		}
		const provider = this.injectedProvider ?? new SearXNGProvider(config.searxng);
		const key = queryCacheKey(provider.id, normalizedQuery, providerCandidateLimit, includeDomains);
		const cacheDiagnostics: SearchDiagnostic[] = [];
		let cacheStatus: SearchCacheStatus = config.cache.queryTtlMs === 0 ? "disabled" : "miss";
		let entry: SearchCacheEntry<CachedSearchValue> | undefined;
		if (config.cache.queryTtlMs > 0) {
			const cached = await this.cache.read<CachedSearchValue>("queries", key);
			cacheDiagnostics.push(...cached.diagnostics);
			entry = cached.entry;
			if (entry && !isCachedSearchValue(entry.value)) {
				cacheDiagnostics.push(corruptCacheDiagnostic());
				await this.cache.remove("queries", key);
				entry = undefined;
			}
			if (entry) cacheStatus = "hit";
		}
		if (!entry) {
			const pending = this.pendingSearches.get(key);
			if (pending) {
				cacheStatus = "deduplicated";
				const shared = await pending;
				entry = shared.entry;
				cacheDiagnostics.push(...shared.diagnostics);
			} else {
				if (!this.budget.reserveProviderAttempt(context.budgetScopeId, config.budget)) {
					return failure(
						[...cacheDiagnostics, budgetDiagnostic("provider_attempts")],
						"provider_attempts",
						provider.id,
					);
				}
				const promise = this.fetchSearchFromProvider(
					provider,
					normalizedQuery,
					providerCandidateLimit,
					includeDomains,
					config,
					context.signal,
					key,
				);
				this.pendingSearches.set(key, promise);
				try {
					const network = await promise;
					entry = network.entry;
					cacheDiagnostics.push(...network.diagnostics);
				} catch (error) {
					const diagnostic =
						error instanceof SearchRuntimeError
							? error.diagnostic
							: classifyNetworkError(error, {
									operation: "provider",
									cancelled: context.signal?.aborted === true,
									timedOut: false,
								});
					return failure([...cacheDiagnostics, diagnostic], undefined, provider.id);
				} finally {
					this.pendingSearches.delete(key);
				}
			}
		}
		const broadResults = entry.value.results;
		const filtered = normalizeAndRankResults(broadResults, normalizedQuery, includeDomains, excludeDomains).slice(
			0,
			requestedResults,
		);
		const remaining = this.budget.remainingCharacters(context.budgetScopeId, config.budget);
		const fitted = fitSearchResults(filtered, remaining);
		this.budget.consumeCharacters(context.budgetScopeId, config.budget, fitted.characters);
		const diagnostics = [...cacheDiagnostics];
		if (fitted.truncated) {
			diagnostics.push(budgetDiagnostic("input_characters", fitted.results.length > 0 ? "warning" : "error"));
		}
		const citations = fitted.results.map((result) => searchCitation(result, entry.fetchedAt));
		return {
			ok: fitted.results.length > 0 || broadResults.length === 0,
			query: input.query,
			normalizedQuery,
			results: fitted.results,
			citations,
			provider: provider.id,
			cacheStatus,
			diagnostics,
			budget: this.budget.snapshot(
				context.budgetScopeId,
				config.budget,
				fitted.truncated ? "input_characters" : undefined,
			),
		};
	}

	async fetch(input: string, context: SearchRuntimeCallContext): Promise<FetchExecutionResult> {
		if (context.sessionEntries) this.budget.synchronize(context.budgetScopeId, context.sessionEntries);
		const config = this.getConfig();
		const failure = (
			diagnostics: SearchDiagnostic[],
			exhausted?: "fetches" | "input_characters",
			requestedUrl = input,
		): FetchExecutionResult => ({
			ok: false,
			requestedUrl,
			cacheStatus: config.cache.fetchTtlMs === 0 ? "disabled" : "miss",
			diagnostics,
			budget: this.budget.snapshot(context.budgetScopeId, config.budget, exhausted),
			duplicateContent: false,
			redirects: 0,
		});
		if (!config.enabled) {
			return failure([
				{ code: "not_configured", severity: "error", message: "Web access is disabled in settings." },
			]);
		}
		if (!this.budget.reserveFetch(context.budgetScopeId, config.budget)) {
			return failure([budgetDiagnostic("fetches")], "fetches");
		}
		if (this.budget.remainingCharacters(context.budgetScopeId, config.budget) <= 0) {
			return failure([budgetDiagnostic("input_characters")], "input_characters");
		}
		let requestedUrl: string;
		try {
			requestedUrl = canonicalizeWebUrl(input);
		} catch {
			return failure([
				{
					code: "invalid_url",
					severity: "error",
					message: "web_fetch requires an HTTP or HTTPS URL without credentials.",
				},
			]);
		}
		const cacheDiagnostics: SearchDiagnostic[] = [];
		let cacheStatus: SearchCacheStatus = config.cache.fetchTtlMs === 0 ? "disabled" : "miss";
		let entry: SearchCacheEntry<CachedFetchValue> | undefined;
		if (config.cache.fetchTtlMs > 0) {
			const cached = await this.cache.read<CachedFetchValue>("urls", requestedUrl);
			cacheDiagnostics.push(...cached.diagnostics);
			entry = cached.entry;
			if (entry && !isCachedFetchValue(entry.value)) {
				cacheDiagnostics.push(corruptCacheDiagnostic());
				await this.cache.remove("urls", requestedUrl);
				entry = undefined;
			}
			if (entry) cacheStatus = "hit";
		}
		if (!entry) {
			const pending = this.pendingFetches.get(requestedUrl);
			if (pending) {
				cacheStatus = "deduplicated";
				const shared = await pending;
				entry = shared.entry;
				cacheDiagnostics.push(...shared.diagnostics);
			} else {
				const promise = this.fetchWebContent(requestedUrl, config, context.signal);
				this.pendingFetches.set(requestedUrl, promise);
				try {
					const network = await promise;
					entry = network.entry;
					cacheDiagnostics.push(...network.diagnostics);
				} catch (error) {
					const diagnostic =
						error instanceof SearchRuntimeError
							? error.diagnostic
							: classifyNetworkError(error, {
									operation: "fetch",
									cancelled: context.signal?.aborted === true,
									timedOut: false,
								});
					return failure([...cacheDiagnostics, diagnostic], undefined, requestedUrl);
				} finally {
					this.pendingFetches.delete(requestedUrl);
				}
			}
		}
		const citation = contentCitation(entry.value, entry.contentHash, entry.fetchedAt);
		const duplicateContent = this.budget.hasContentHash(context.budgetScopeId, entry.contentHash);
		const remaining = this.budget.remainingCharacters(context.budgetScopeId, config.budget);
		const truncation = truncateByCharacters(entry.value.content, remaining);
		const shouldPersistFull = truncation.truncated;
		const fullOutputPath = shouldPersistFull ? await writeFullContent(entry.value.content) : undefined;
		const content = duplicateContent ? undefined : truncation.content;
		if (!duplicateContent) {
			this.budget.consumeCharacters(context.budgetScopeId, config.budget, content?.length ?? 0);
			this.budget.markContentHash(context.budgetScopeId, entry.contentHash);
		}
		const diagnostics = [...cacheDiagnostics];
		const characterTruncated = truncation.truncated && truncation.content.length >= remaining;
		if (characterTruncated) diagnostics.push(budgetDiagnostic("input_characters", "warning"));
		return {
			ok: true,
			requestedUrl,
			finalUrl: entry.value.finalUrl,
			title: entry.value.title,
			contentType: entry.value.contentType,
			content,
			contentHash: entry.contentHash,
			summary: entry.value.summary,
			citation,
			cacheStatus,
			diagnostics,
			budget: this.budget.snapshot(
				context.budgetScopeId,
				config.budget,
				characterTruncated ? "input_characters" : undefined,
			),
			duplicateContent,
			redirects: entry.value.redirects,
			...(fullOutputPath ? { fullOutputPath, truncation } : {}),
		};
	}

	private async fetchSearchFromProvider(
		provider: SearchProvider,
		query: string,
		candidateLimit: number,
		includeDomains: readonly string[],
		config: ResolvedSearchConfig,
		signal: AbortSignal | undefined,
		key: string,
	): Promise<PendingSearchResult> {
		const timed = createTimedSignal(signal, Math.min(config.searxng.timeoutMs, config.budget.timeoutMs));
		try {
			const response = await provider.search(
				{ query, maxResults: candidateLimit, includeDomains },
				{ signal: timed.signal, timeoutMs: Math.min(config.searxng.timeoutMs, config.budget.timeoutMs) },
			);
			const results = normalizeAndRankResults(response.results, query);
			const fetchedAtMs = this.now();
			const entry: SearchCacheEntry<CachedSearchValue> = {
				version: 1,
				canonicalKey: key,
				source: provider.id,
				fetchedAt: new Date(fetchedAtMs).toISOString(),
				expiresAt: new Date(fetchedAtMs + config.cache.queryTtlMs).toISOString(),
				contentHash: hashWebContent(JSON.stringify(results)),
				value: { query, results },
			};
			const diagnostics = [...(response.diagnostics ?? [])];
			if (config.cache.queryTtlMs > 0) {
				const writeDiagnostic = await this.cache.write("queries", entry);
				if (writeDiagnostic) diagnostics.push(writeDiagnostic);
			}
			return { entry, diagnostics };
		} catch (error) {
			if (error instanceof SearchRuntimeError) throw error;
			throw new SearchRuntimeError(
				classifyNetworkError(error, {
					operation: "provider",
					cancelled: signal?.aborted === true,
					timedOut: timed.timedOut(),
				}),
			);
		} finally {
			timed.cleanup();
		}
	}

	private async fetchWebContent(
		requestedUrl: string,
		config: ResolvedSearchConfig,
		signal: AbortSignal | undefined,
	): Promise<PendingFetchResult> {
		const response = await this.webClient.fetch(requestedUrl, {
			signal,
			timeoutMs: config.budget.timeoutMs,
			maxBytes: config.budget.maxFetchBytes,
			maxRedirects: config.budget.maxRedirects,
		});
		const fallbackTitle = new URL(response.finalUrl).hostname;
		const extracted = decodeBody(response.body, response.contentType, fallbackTitle);
		const value: CachedFetchValue = {
			...extracted,
			requestedUrl,
			finalUrl: response.finalUrl,
			redirects: response.redirects,
		};
		const fetchedAtMs = this.now();
		const contentHash = hashWebContent(value.content);
		const entry: SearchCacheEntry<CachedFetchValue> = {
			version: 1,
			canonicalKey: requestedUrl,
			source: response.finalUrl,
			fetchedAt: new Date(fetchedAtMs).toISOString(),
			expiresAt: new Date(fetchedAtMs + config.cache.fetchTtlMs).toISOString(),
			contentHash,
			value,
		};
		const diagnostics: SearchDiagnostic[] = [];
		if (config.cache.fetchTtlMs > 0) {
			const writeDiagnostic = await this.cache.write("urls", entry);
			if (writeDiagnostic) diagnostics.push(writeDiagnostic);
			if (response.finalUrl !== requestedUrl) {
				const alias: SearchCacheEntry<CachedFetchValue> = { ...entry, canonicalKey: response.finalUrl };
				const aliasDiagnostic = await this.cache.write("urls", alias);
				if (aliasDiagnostic) diagnostics.push(aliasDiagnostic);
			}
		}
		return { entry, diagnostics };
	}
}
