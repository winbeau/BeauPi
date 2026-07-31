import type { SettingsManager } from "../settings-manager.ts";
import type { ResolvedSearchConfig, SearchBudgetLimits, SearchSettings } from "./types.ts";

export const ENV_SEARXNG_ENDPOINT = "BEAUPI_SEARXNG_ENDPOINT";
export const ENV_SEARXNG_API_KEY = "BEAUPI_SEARXNG_API_KEY";

export const DEFAULT_SEARCH_BUDGET: Readonly<SearchBudgetLimits> = Object.freeze({
	maxResultsPerSearch: 10,
	maxQueriesPerTask: 6,
	maxFetchesPerTask: 6,
	maxProviderAttemptsPerTask: 6,
	maxFetchBytes: 2 * 1024 * 1024,
	maxInputCharactersPerTask: 60_000,
	timeoutMs: 15_000,
	maxRedirects: 5,
});

export const DEFAULT_QUERY_CACHE_TTL_MS = 5 * 60_000;
export const DEFAULT_FETCH_CACHE_TTL_MS = 15 * 60_000;
export const DEFAULT_PROVIDER_MAX_RESULTS = 10;

function finiteInteger(value: number | undefined, fallback: number, minimum: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback;
}

function normalizedEngines(values: readonly string[] | undefined): string[] {
	return [
		...new Set(
			(values ?? [])
				.map((value) => value.normalize("NFKC").trim())
				.filter((value) => value.length > 0 && !value.includes(",")),
		),
	];
}

function optionalSecret(
	environment: NodeJS.ProcessEnv,
	configuredName: string | undefined,
): {
	value?: string;
	required: boolean;
} {
	const name = configuredName?.trim();
	if (name) {
		const value = environment[name]?.trim();
		return { value: value || undefined, required: true };
	}
	const value = environment[ENV_SEARXNG_API_KEY]?.trim();
	return { value: value || undefined, required: false };
}

export function resolveSearchConfig(
	settings: SearchSettings | undefined,
	environment: NodeJS.ProcessEnv = process.env,
): ResolvedSearchConfig {
	const budget = settings?.budget;
	const providerTimeoutMs = finiteInteger(
		settings?.searxng?.timeoutMs,
		finiteInteger(budget?.timeoutMs, DEFAULT_SEARCH_BUDGET.timeoutMs, 1),
		1,
	);
	const secret = optionalSecret(environment, settings?.searxng?.apiKeyEnv);
	return {
		enabled: settings?.enabled ?? true,
		provider: settings?.provider ?? "searxng",
		searxng: {
			endpoint: environment[ENV_SEARXNG_ENDPOINT]?.trim() || settings?.searxng?.endpoint?.trim() || undefined,
			timeoutMs: providerTimeoutMs,
			maxResults: finiteInteger(settings?.searxng?.maxResults, DEFAULT_PROVIDER_MAX_RESULTS, 1),
			engines: normalizedEngines(settings?.searxng?.engines),
			apiKey: secret.value,
			apiKeyRequired: secret.required,
			apiKeyHeader: settings?.searxng?.apiKeyHeader?.trim() || "Authorization",
			apiKeyPrefix: settings?.searxng?.apiKeyPrefix ?? "Bearer ",
		},
		cache: {
			queryTtlMs: finiteInteger(settings?.cache?.queryTtlMs, DEFAULT_QUERY_CACHE_TTL_MS, 0),
			fetchTtlMs: finiteInteger(settings?.cache?.fetchTtlMs, DEFAULT_FETCH_CACHE_TTL_MS, 0),
		},
		budget: {
			maxResultsPerSearch: finiteInteger(budget?.maxResultsPerSearch, DEFAULT_SEARCH_BUDGET.maxResultsPerSearch, 1),
			maxQueriesPerTask: finiteInteger(budget?.maxQueriesPerTask, DEFAULT_SEARCH_BUDGET.maxQueriesPerTask, 1),
			maxFetchesPerTask: finiteInteger(budget?.maxFetchesPerTask, DEFAULT_SEARCH_BUDGET.maxFetchesPerTask, 1),
			maxProviderAttemptsPerTask: finiteInteger(
				budget?.maxProviderAttemptsPerTask,
				DEFAULT_SEARCH_BUDGET.maxProviderAttemptsPerTask,
				1,
			),
			maxFetchBytes: finiteInteger(budget?.maxFetchBytes, DEFAULT_SEARCH_BUDGET.maxFetchBytes, 1),
			maxInputCharactersPerTask: finiteInteger(
				budget?.maxInputCharactersPerTask,
				DEFAULT_SEARCH_BUDGET.maxInputCharactersPerTask,
				1,
			),
			timeoutMs: finiteInteger(budget?.timeoutMs, DEFAULT_SEARCH_BUDGET.timeoutMs, 1),
			maxRedirects: finiteInteger(budget?.maxRedirects, DEFAULT_SEARCH_BUDGET.maxRedirects, 0),
		},
	};
}

export function createSearchConfigProvider(
	settingsManager: SettingsManager,
	environment: NodeJS.ProcessEnv = process.env,
): () => ResolvedSearchConfig {
	return () => resolveSearchConfig(settingsManager.getSearchSettings(), environment);
}
