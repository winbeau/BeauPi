import type { SearchProviderResult, SearchResult } from "./types.ts";

const TRACKING_PARAMETERS = new Set([
	"fbclid",
	"gclid",
	"dclid",
	"msclkid",
	"mc_cid",
	"mc_eid",
	"igshid",
	"vero_conv",
	"vero_id",
]);

const GENERIC_QUERY_TOKENS = new Set([
	"a",
	"an",
	"and",
	"api",
	"best",
	"documentation",
	"docs",
	"for",
	"guide",
	"how",
	"in",
	"latest",
	"of",
	"official",
	"on",
	"reference",
	"the",
	"to",
	"using",
	"with",
]);

export function normalizeSearchQuery(query: string): string {
	return query.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function canonicalSearchQuery(query: string): string {
	return normalizeSearchQuery(query).toLowerCase();
}

export function normalizeDomain(domain: string): string {
	const trimmed = domain
		.normalize("NFKC")
		.trim()
		.toLowerCase()
		.replace(/^\.+|\.+$/g, "");
	if (!trimmed) return "";
	try {
		return new URL(`http://${trimmed}`).hostname.toLowerCase();
	} catch {
		return trimmed;
	}
}

export function normalizeDomains(domains: readonly string[] | undefined): string[] {
	return [...new Set((domains ?? []).map(normalizeDomain).filter((domain) => domain.length > 0))].sort();
}

export function domainMatches(hostname: string, configuredDomain: string): boolean {
	const host = hostname.toLowerCase();
	const domain = normalizeDomain(configuredDomain);
	return domain.length > 0 && (host === domain || host.endsWith(`.${domain}`));
}

export function canonicalizeWebUrl(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only HTTP and HTTPS URLs are supported");
	}
	if (url.username || url.password) throw new Error("URL credentials are not allowed");
	url.protocol = url.protocol.toLowerCase();
	url.hostname = url.hostname.toLowerCase();
	url.hash = "";
	if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
		url.port = "";
	}
	url.pathname = url.pathname.replace(/\/{2,}/g, "/");
	if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
	const parameters = [...url.searchParams.entries()]
		.filter(([name]) => {
			const lower = name.toLowerCase();
			return !lower.startsWith("utm_") && !TRACKING_PARAMETERS.has(lower);
		})
		.sort(
			([leftName, leftValue], [rightName, rightValue]) =>
				leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue),
		);
	url.search = "";
	for (const [name, valuePart] of parameters) url.searchParams.append(name, valuePart);
	return url.toString();
}

export function displayWebUrl(value: string): string {
	const url = new URL(value);
	const path = url.pathname === "/" ? "" : url.pathname;
	const display = `${url.hostname}${url.port ? `:${url.port}` : ""}${path}`;
	return display.length > 160 ? `${display.slice(0, 159)}…` : display;
}

function queryDomainTokens(query: string): Set<string> {
	return new Set(
		normalizeSearchQuery(query)
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((token) => token.length >= 3 && !GENERIC_QUERY_TOKENS.has(token)),
	);
}

function domainLabels(hostname: string): Set<string> {
	return new Set(
		hostname
			.toLowerCase()
			.split(".")
			.filter((label) => label !== "www" && label.length >= 2),
	);
}

function priorityForResult(
	result: SearchResult,
	queryTokens: ReadonlySet<string>,
	includeDomains: readonly string[],
): { score: number; reason?: SearchResult["priorityReason"] } {
	if (includeDomains.some((domain) => domainMatches(result.domain ?? "", domain))) {
		return { score: 2, reason: "requested-domain" };
	}
	const labels = domainLabels(result.domain ?? "");
	if ([...queryTokens].some((token) => labels.has(token))) {
		return { score: 1, reason: "query-domain-match" };
	}
	return { score: 0 };
}

export function normalizeAndRankResults(
	providerResults: readonly SearchProviderResult[],
	query: string,
	includeDomains?: readonly string[],
	excludeDomains?: readonly string[],
): SearchResult[] {
	const included = normalizeDomains(includeDomains);
	const excluded = normalizeDomains(excludeDomains);
	const queryTokens = queryDomainTokens(query);
	const byUrl = new Map<string, SearchResult>();
	for (const result of providerResults) {
		let canonicalUrl: string;
		try {
			canonicalUrl = canonicalizeWebUrl(result.url);
		} catch {
			continue;
		}
		const domain = new URL(canonicalUrl).hostname.toLowerCase();
		if (included.length > 0 && !included.some((candidate) => domainMatches(domain, candidate))) continue;
		if (excluded.some((candidate) => domainMatches(domain, candidate))) continue;
		const normalized: SearchResult = {
			...result,
			title: result.title.replace(/\s+/g, " ").trim() || domain,
			snippet: result.snippet.replace(/\s+/g, " ").trim(),
			url: canonicalUrl,
			canonicalUrl,
			domain,
			providerRank: result.rank,
		};
		const current = byUrl.get(canonicalUrl);
		if (!current || (normalized.score ?? Number.NEGATIVE_INFINITY) > (current.score ?? Number.NEGATIVE_INFINITY)) {
			byUrl.set(canonicalUrl, normalized);
		}
	}
	return [...byUrl.values()]
		.map((result) => {
			const priority = priorityForResult(result, queryTokens, included);
			return { result: { ...result, priorityReason: priority.reason }, priority: priority.score };
		})
		.sort(
			(left, right) =>
				right.priority - left.priority ||
				(right.result.score ?? Number.NEGATIVE_INFINITY) - (left.result.score ?? Number.NEGATIVE_INFINITY) ||
				left.result.providerRank - right.result.providerRank ||
				left.result.canonicalUrl.localeCompare(right.result.canonicalUrl),
		)
		.map(({ result }, index) => ({ ...result, rank: index + 1 }));
}
