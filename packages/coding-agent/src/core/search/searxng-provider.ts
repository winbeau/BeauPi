import { request } from "undici";
import { SearchRuntimeError } from "./errors.ts";
import type {
	SearchDiagnostic,
	SearchProvider,
	SearchProviderContext,
	SearchProviderRequest,
	SearchProviderResponse,
	SearchProviderResult,
} from "./types.ts";

const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

export interface SearXNGProviderOptions {
	endpoint?: string;
	engines?: readonly string[];
	apiKey?: string;
	apiKeyRequired?: boolean;
	apiKeyHeader?: string;
	apiKeyPrefix?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function publishedAt(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function normalizeProviderResult(value: unknown, rank: number): SearchProviderResult | undefined {
	const record = asRecord(value);
	if (!record || typeof record.url !== "string") return undefined;
	let domain: string | undefined;
	try {
		domain = new URL(record.url).hostname.toLowerCase();
	} catch {
		return undefined;
	}
	return {
		title: typeof record.title === "string" ? record.title : domain,
		url: record.url,
		snippet:
			typeof record.content === "string" ? record.content : typeof record.snippet === "string" ? record.snippet : "",
		provider: "searxng",
		rank,
		score: finiteNumber(record.score),
		publishedAt: publishedAt(record.publishedDate ?? record.published_at),
		domain,
	};
}

function firstHeader(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function queryWithDomainConstraint(input: SearchProviderRequest): string {
	const domains = [
		...new Set((input.includeDomains ?? []).map((domain) => domain.trim().toLowerCase()).filter(Boolean)),
	];
	if (domains.length !== 1) return input.query;
	const domain = domains[0]!;
	return input.query.toLowerCase().includes(`site:${domain}`) ? input.query : `${input.query} site:${domain}`;
}

function engineFailureDiagnostic(value: unknown, hasResults: boolean): SearchDiagnostic | undefined {
	if (!Array.isArray(value)) return undefined;
	const failures = value
		.map((item) => {
			if (!Array.isArray(item) || typeof item[0] !== "string") return undefined;
			return { engine: item[0], reason: typeof item[1] === "string" ? item[1] : "unavailable" };
		})
		.filter((item): item is { engine: string; reason: string } => item !== undefined);
	if (failures.length === 0) return undefined;
	const rateLimited = failures.some((item) => /captcha|rate|too many requests|suspended/i.test(item.reason));
	return {
		code: rateLimited ? "rate_limited" : "connection",
		severity: hasResults ? "warning" : "error",
		message: hasResults
			? "Some configured SearXNG engines were unavailable; partial results were returned."
			: "One or more configured SearXNG engines were unavailable or suspended, and no results were returned.",
		suggestion: rateLimited
			? "Wait for the engine limits to reset or configure search.searxng.engines with available engines."
			: "Check the configured SearXNG engines and outbound network access.",
	};
}

async function readProviderBody(body: NodeJS.ReadableStream): Promise<string> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of body) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
		bytes += buffer.byteLength;
		if (bytes > MAX_PROVIDER_RESPONSE_BYTES) {
			throw new SearchRuntimeError({
				code: "body_too_large",
				severity: "error",
				message: "The search provider response exceeded the allowed size.",
			});
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf-8");
}

function httpDiagnostic(statusCode: number, retryAfter: string | undefined): SearchDiagnostic {
	const retrySeconds = retryAfter ? Number(retryAfter) : Number.NaN;
	if (statusCode === 401 || statusCode === 403) {
		return {
			code: "authentication",
			severity: "error",
			message: "The configured search provider rejected authentication.",
			suggestion: "Check the configured SearXNG API key environment variable and access policy.",
			statusCode,
		};
	}
	if (statusCode === 429) {
		return {
			code: "rate_limited",
			severity: "error",
			message: "The configured search provider rate limit was reached.",
			suggestion: "Wait for the provider limit to reset or reduce the per-task query budget.",
			statusCode,
			retryAfterMs: Number.isFinite(retrySeconds) ? Math.max(0, retrySeconds * 1000) : undefined,
		};
	}
	return {
		code: "http",
		severity: "error",
		message: `The configured search provider returned HTTP ${statusCode}.`,
		statusCode,
	};
}

export class SearXNGProvider implements SearchProvider {
	readonly id = "searxng";
	private readonly options: SearXNGProviderOptions;

	constructor(options: SearXNGProviderOptions) {
		this.options = options;
	}

	async search(input: SearchProviderRequest, context: SearchProviderContext): Promise<SearchProviderResponse> {
		const endpoint = this.options.endpoint?.trim();
		if (!endpoint) {
			throw new SearchRuntimeError({
				code: "not_configured",
				severity: "error",
				message: "SearXNG is not configured.",
				suggestion: "Set search.searxng.endpoint or BEAUPI_SEARXNG_ENDPOINT.",
			});
		}
		if (this.options.apiKeyRequired && !this.options.apiKey) {
			throw new SearchRuntimeError({
				code: "not_configured",
				severity: "error",
				message: "The configured SearXNG API key environment variable is missing.",
				suggestion: "Set the configured environment variable before retrying web_search.",
			});
		}
		let url: URL;
		try {
			url = new URL(endpoint);
			if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
			if (url.username || url.password) throw new Error("credentials are not allowed");
			if (url.pathname === "/" || url.pathname === "") url.pathname = "/search";
		} catch {
			throw new SearchRuntimeError({
				code: "not_configured",
				severity: "error",
				message: "The configured SearXNG endpoint is invalid.",
				suggestion: "Configure an HTTP or HTTPS SearXNG JSON API endpoint without URL credentials.",
			});
		}
		url.searchParams.set("q", queryWithDomainConstraint(input));
		url.searchParams.set("format", "json");
		const engines = [...new Set((this.options.engines ?? []).map((engine) => engine.trim()).filter(Boolean))];
		if (engines.length > 0) url.searchParams.set("engines", engines.join(","));
		const headers: Record<string, string> = {
			accept: "application/json",
			"accept-encoding": "identity",
		};
		if (this.options.apiKey) {
			headers[this.options.apiKeyHeader?.trim() || "Authorization"] =
				`${this.options.apiKeyPrefix ?? "Bearer "}${this.options.apiKey}`;
		}
		try {
			const response = await request(url, {
				method: "GET",
				headers,
				signal: context.signal,
				headersTimeout: context.timeoutMs,
				bodyTimeout: context.timeoutMs,
			});
			if (response.statusCode < 200 || response.statusCode >= 300) {
				await response.body.dump({ limit: 64 * 1024, signal: context.signal }).catch(() => {});
				throw new SearchRuntimeError(
					httpDiagnostic(response.statusCode, firstHeader(response.headers["retry-after"])),
				);
			}
			const text = await readProviderBody(response.body);
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				throw new SearchRuntimeError({
					code: "invalid_response",
					severity: "error",
					message: "The search provider returned invalid JSON.",
				});
			}
			const record = asRecord(parsed);
			const results = record?.results;
			if (!Array.isArray(results)) {
				throw new SearchRuntimeError({
					code: "invalid_response",
					severity: "error",
					message: "The search provider response did not contain a results array.",
				});
			}
			const normalizedResults = results
				.map((result, index) => normalizeProviderResult(result, index + 1))
				.filter((result): result is SearchProviderResult => result !== undefined)
				.slice(0, input.maxResults);
			const engineDiagnostic = engineFailureDiagnostic(record?.unresponsive_engines, normalizedResults.length > 0);
			if (engineDiagnostic?.severity === "error") throw new SearchRuntimeError(engineDiagnostic);
			return {
				results: normalizedResults,
				diagnostics: engineDiagnostic ? [engineDiagnostic] : undefined,
			};
		} catch (error) {
			if (error instanceof SearchRuntimeError) throw error;
			throw error;
		}
	}
}
