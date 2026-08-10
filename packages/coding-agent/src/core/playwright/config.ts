import type { SettingsManager } from "../settings-manager.ts";
import type { PlaywrightSettings, ResolvedPlaywrightConfig } from "./types.ts";

export const DEFAULT_PLAYWRIGHT_ACTION_TIMEOUT_MS = 15_000;
export const DEFAULT_PLAYWRIGHT_NAVIGATION_TIMEOUT_MS = 30_000;

function timeout(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(120_000, Math.max(100, Math.floor(value)));
}

export function resolvePlaywrightConfig(settings: PlaywrightSettings | undefined): ResolvedPlaywrightConfig {
	if (settings?.executablePath && settings.channel) {
		throw new Error("playwright.executablePath and playwright.channel are mutually exclusive");
	}
	return {
		executablePath: settings?.executablePath?.trim() || undefined,
		channel: settings?.channel,
		headless: settings?.headless ?? true,
		actionTimeoutMs: timeout(settings?.actionTimeoutMs, DEFAULT_PLAYWRIGHT_ACTION_TIMEOUT_MS),
		navigationTimeoutMs: timeout(settings?.navigationTimeoutMs, DEFAULT_PLAYWRIGHT_NAVIGATION_TIMEOUT_MS),
		allowPrivateNetwork: settings?.allowPrivateNetwork ?? false,
	};
}

export function createPlaywrightConfigProvider(settingsManager: SettingsManager): () => ResolvedPlaywrightConfig {
	return () => resolvePlaywrightConfig(settingsManager.getPlaywrightSettings());
}
