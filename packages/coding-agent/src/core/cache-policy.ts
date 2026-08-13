/**
 * Adapted from DeepSeek-Reasonix internal/config/cache_policy.go
 * (MIT, Copyright (c) 2026 Reasonix Contributors).
 * See docs/third-party/reasonix.md for the full notice and modification notes.
 *
 * This policy is diagnostic guidance for cold-resume and idle-gap handling.
 * It must never actively rewrite conversation history or provider requests.
 * Runtime idle-gap integration is intentionally deferred until after Step 5.
 */

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function hostForBaseUrl(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) return undefined;
	try {
		return new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

function isHostOrSubdomain(host: string | undefined, root: string): boolean {
	return host === root || host?.endsWith(`.${root}`) === true;
}

/** Return the vendor's prompt-cache TTL in milliseconds for diagnostics. */
export function defaultPromptCacheTtlMs(baseUrl: string | undefined): number {
	const host = hostForBaseUrl(baseUrl);
	if (
		isHostOrSubdomain(host, "dashscope.aliyuncs.com") ||
		isHostOrSubdomain(host, "maas.aliyuncs.com") ||
		isHostOrSubdomain(host, "anthropic.com")
	) {
		return FIVE_MINUTES_MS;
	}
	if (isHostOrSubdomain(host, "deepseek.com")) return TWENTY_FOUR_HOURS_MS;
	return TWENTY_FOUR_HOURS_MS;
}
