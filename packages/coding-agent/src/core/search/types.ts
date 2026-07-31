import { createHash } from "node:crypto";
import type { TruncationResult } from "../tools/truncate.ts";

export const SEARCH_RUNTIME_DETAILS_KEY = "searchRuntime";
export const SEARCH_RUNTIME_DETAILS_VERSION = 1;
export const SEARCH_CACHE_VERSION = 1;

export type SearchDiagnosticSeverity = "info" | "warning" | "error";

export type SearchDiagnosticCode =
	| "not_configured"
	| "unsupported_provider"
	| "authentication"
	| "rate_limited"
	| "dns"
	| "connection"
	| "tls"
	| "http"
	| "invalid_response"
	| "timeout"
	| "cancelled"
	| "invalid_url"
	| "blocked_target"
	| "unsupported_content_type"
	| "body_too_large"
	| "redirect_limit"
	| "cache_corrupt"
	| "cache_read_failed"
	| "cache_write_failed"
	| "budget_exhausted";

export interface SearchDiagnostic {
	code: SearchDiagnosticCode;
	severity: SearchDiagnosticSeverity;
	message: string;
	suggestion?: string;
	statusCode?: number;
	retryAfterMs?: number;
}

export interface SearchProviderResult {
	title: string;
	url: string;
	snippet: string;
	provider: string;
	rank: number;
	score?: number;
	publishedAt?: string;
	domain?: string;
}

export interface SearchResult extends SearchProviderResult {
	canonicalUrl: string;
	providerRank: number;
	priorityReason?: "requested-domain" | "query-domain-match";
}

export interface WebCitation {
	kind: "web";
	id: string;
	level: "search" | "content";
	url: string;
	displayUrl: string;
	domain: string;
	title: string;
	provider: string;
	fetchedAt: string;
	contentHash?: string;
	rank?: number;
}

export interface SearchProviderRequest {
	query: string;
	maxResults: number;
	includeDomains?: readonly string[];
	excludeDomains?: readonly string[];
}

export interface SearchProviderContext {
	signal?: AbortSignal;
	timeoutMs: number;
}

export interface SearchProviderResponse {
	results: SearchProviderResult[];
	diagnostics?: SearchDiagnostic[];
}

/** Stable interface implemented by the single M8 provider and future providers. */
export interface SearchProvider {
	readonly id: string;
	search(request: SearchProviderRequest, context: SearchProviderContext): Promise<SearchProviderResponse>;
}

export interface SearXNGSettings {
	endpoint?: string;
	timeoutMs?: number;
	maxResults?: number;
	engines?: string[];
	apiKeyEnv?: string;
	apiKeyHeader?: string;
	apiKeyPrefix?: string;
}

export interface SearchCacheSettings {
	queryTtlMs?: number;
	fetchTtlMs?: number;
}

export interface SearchBudgetSettings {
	maxResultsPerSearch?: number;
	maxQueriesPerTask?: number;
	maxFetchesPerTask?: number;
	maxProviderAttemptsPerTask?: number;
	maxFetchBytes?: number;
	maxInputCharactersPerTask?: number;
	timeoutMs?: number;
	maxRedirects?: number;
}

export interface SearchSettings {
	enabled?: boolean;
	provider?: "searxng";
	searxng?: SearXNGSettings;
	cache?: SearchCacheSettings;
	budget?: SearchBudgetSettings;
}

export interface ResolvedSearchConfig {
	enabled: boolean;
	provider: "searxng";
	searxng: {
		endpoint?: string;
		timeoutMs: number;
		maxResults: number;
		engines: string[];
		apiKey?: string;
		apiKeyRequired: boolean;
		apiKeyHeader: string;
		apiKeyPrefix: string;
	};
	cache: {
		queryTtlMs: number;
		fetchTtlMs: number;
	};
	budget: SearchBudgetLimits;
}

export interface SearchBudgetLimits {
	maxResultsPerSearch: number;
	maxQueriesPerTask: number;
	maxFetchesPerTask: number;
	maxProviderAttemptsPerTask: number;
	maxFetchBytes: number;
	maxInputCharactersPerTask: number;
	timeoutMs: number;
	maxRedirects: number;
}

export interface SearchBudgetUsage {
	queries: number;
	fetches: number;
	providerAttempts: number;
	inputCharacters: number;
}

export interface SearchBudgetSnapshot {
	limits: SearchBudgetLimits;
	used: SearchBudgetUsage;
	remaining: SearchBudgetUsage;
	exhausted?: "results" | "queries" | "fetches" | "provider_attempts" | "input_characters";
}

export type SearchCacheStatus = "hit" | "miss" | "deduplicated" | "disabled";

export interface SearchRuntimeToolDetails {
	version: typeof SEARCH_RUNTIME_DETAILS_VERSION;
	operation: "search" | "fetch";
	ok: boolean;
	provider?: string;
	cacheStatus: SearchCacheStatus;
	budget: SearchBudgetSnapshot;
	diagnostics: SearchDiagnostic[];
	citations: WebCitation[];
	contentHash?: string;
	untrustedExternalContent: true;
}

export interface WebSearchToolDetails {
	query: string;
	normalizedQuery: string;
	results: SearchResult[];
	resultCount: number;
	searchRuntime: SearchRuntimeToolDetails;
}

export interface WebFetchToolDetails {
	requestedUrl: string;
	finalUrl?: string;
	title?: string;
	contentType?: string;
	contentHash?: string;
	summary?: string;
	fullOutputPath?: string;
	truncation?: TruncationResult;
	duplicateContent: boolean;
	redirects: number;
	searchRuntime: SearchRuntimeToolDetails;
}

export interface SearchExecutionResult {
	ok: boolean;
	query: string;
	normalizedQuery: string;
	results: SearchResult[];
	citations: WebCitation[];
	provider?: string;
	cacheStatus: SearchCacheStatus;
	diagnostics: SearchDiagnostic[];
	budget: SearchBudgetSnapshot;
}

export interface FetchExecutionResult {
	ok: boolean;
	requestedUrl: string;
	finalUrl?: string;
	title?: string;
	contentType?: string;
	content?: string;
	contentHash?: string;
	summary?: string;
	citation?: WebCitation;
	fullOutputPath?: string;
	truncation?: TruncationResult;
	cacheStatus: SearchCacheStatus;
	diagnostics: SearchDiagnostic[];
	budget: SearchBudgetSnapshot;
	duplicateContent: boolean;
	redirects: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parseDiagnostic(value: unknown): SearchDiagnostic | undefined {
	const record = asRecord(value);
	if (
		!record ||
		typeof record.code !== "string" ||
		typeof record.severity !== "string" ||
		typeof record.message !== "string"
	) {
		return undefined;
	}
	return record as unknown as SearchDiagnostic;
}

function parseCitation(value: unknown): WebCitation | undefined {
	const record = asRecord(value);
	if (
		!record ||
		record.kind !== "web" ||
		(record.level !== "search" && record.level !== "content") ||
		typeof record.id !== "string" ||
		typeof record.url !== "string" ||
		typeof record.displayUrl !== "string" ||
		typeof record.domain !== "string" ||
		typeof record.title !== "string" ||
		typeof record.provider !== "string" ||
		typeof record.fetchedAt !== "string" ||
		(record.contentHash !== undefined && typeof record.contentHash !== "string") ||
		(record.rank !== undefined && typeof record.rank !== "number")
	) {
		return undefined;
	}
	return record as unknown as WebCitation;
}

export function getSearchRuntimeToolDetails(details: unknown): SearchRuntimeToolDetails | undefined {
	const record = asRecord(asRecord(details)?.[SEARCH_RUNTIME_DETAILS_KEY]);
	if (
		!record ||
		record.version !== SEARCH_RUNTIME_DETAILS_VERSION ||
		(record.operation !== "search" && record.operation !== "fetch") ||
		typeof record.ok !== "boolean" ||
		(record.cacheStatus !== "hit" &&
			record.cacheStatus !== "miss" &&
			record.cacheStatus !== "deduplicated" &&
			record.cacheStatus !== "disabled") ||
		!asRecord(record.budget) ||
		!Array.isArray(record.diagnostics) ||
		!Array.isArray(record.citations) ||
		record.untrustedExternalContent !== true
	) {
		return undefined;
	}
	const diagnostics = record.diagnostics.map(parseDiagnostic);
	const citations = record.citations.map(parseCitation);
	if (diagnostics.some((item) => !item) || citations.some((item) => !item)) return undefined;
	return {
		version: SEARCH_RUNTIME_DETAILS_VERSION,
		operation: record.operation,
		ok: record.ok,
		provider: typeof record.provider === "string" ? record.provider : undefined,
		cacheStatus: record.cacheStatus,
		budget: record.budget as unknown as SearchBudgetSnapshot,
		diagnostics: diagnostics as SearchDiagnostic[],
		citations: citations as WebCitation[],
		contentHash: typeof record.contentHash === "string" ? record.contentHash : undefined,
		untrustedExternalContent: true,
	};
}

export function attachSearchRuntimeToolDetails(
	details: unknown,
	metadata: SearchRuntimeToolDetails,
): Record<string, unknown> {
	const record = asRecord(details);
	return record ? { ...record, [SEARCH_RUNTIME_DETAILS_KEY]: metadata } : { [SEARCH_RUNTIME_DETAILS_KEY]: metadata };
}

export function stableWebId(prefix: string, ...parts: string[]): string {
	const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
	return `${prefix}_${digest}`;
}

export function hashWebContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}
