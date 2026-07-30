import type { SettingsManager } from "../settings-manager.ts";
import type { PolicyBudgetLimits, PolicySettings, ResolvedPolicyConfig } from "./types.ts";

export const DEFAULT_POLICY_BUDGET: Readonly<PolicyBudgetLimits> = Object.freeze({
	maxEquivalentFailures: 1,
	maxFallbackAttempts: 2,
	maxMissingDependencyFailures: 1,
	maxPermissionFailures: 1,
	maxAuthenticationFailures: 1,
	maxNetworkFailures: 2,
	maxRateLimitFailures: 1,
	maxTimeoutFailures: 2,
	maxCommandExitFailures: 2,
	maxConfigurationFailures: 1,
	maxSessionLostFailures: 1,
});

export const DEFAULT_POLICY_SENSITIVE_PATHS: readonly string[] = Object.freeze([
	"/etc",
	"/root",
	"/proc",
	"/sys",
	"/dev",
	"~/.ssh",
	"~/.aws",
	"~/.gnupg",
	"~/.kube",
	"~/.config/gcloud",
	"~/.docker/config.json",
]);

function positiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

export function resolvePolicyConfig(settings: PolicySettings | undefined): ResolvedPolicyConfig {
	const budget = settings?.budget;
	return {
		budget: {
			maxEquivalentFailures: positiveInteger(
				budget?.maxEquivalentFailures,
				DEFAULT_POLICY_BUDGET.maxEquivalentFailures,
			),
			maxFallbackAttempts: positiveInteger(budget?.maxFallbackAttempts, DEFAULT_POLICY_BUDGET.maxFallbackAttempts),
			maxMissingDependencyFailures: positiveInteger(
				budget?.maxMissingDependencyFailures,
				DEFAULT_POLICY_BUDGET.maxMissingDependencyFailures,
			),
			maxPermissionFailures: positiveInteger(
				budget?.maxPermissionFailures,
				DEFAULT_POLICY_BUDGET.maxPermissionFailures,
			),
			maxAuthenticationFailures: positiveInteger(
				budget?.maxAuthenticationFailures,
				DEFAULT_POLICY_BUDGET.maxAuthenticationFailures,
			),
			maxNetworkFailures: positiveInteger(budget?.maxNetworkFailures, DEFAULT_POLICY_BUDGET.maxNetworkFailures),
			maxRateLimitFailures: positiveInteger(
				budget?.maxRateLimitFailures,
				DEFAULT_POLICY_BUDGET.maxRateLimitFailures,
			),
			maxTimeoutFailures: positiveInteger(budget?.maxTimeoutFailures, DEFAULT_POLICY_BUDGET.maxTimeoutFailures),
			maxCommandExitFailures: positiveInteger(
				budget?.maxCommandExitFailures,
				DEFAULT_POLICY_BUDGET.maxCommandExitFailures,
			),
			maxConfigurationFailures: positiveInteger(
				budget?.maxConfigurationFailures,
				DEFAULT_POLICY_BUDGET.maxConfigurationFailures,
			),
			maxSessionLostFailures: positiveInteger(
				budget?.maxSessionLostFailures,
				DEFAULT_POLICY_BUDGET.maxSessionLostFailures,
			),
		},
		sensitivePaths: [...new Set([...(settings?.sensitivePaths ?? []), ...DEFAULT_POLICY_SENSITIVE_PATHS])],
	};
}

export function createPolicyConfigProvider(settingsManager: SettingsManager): () => ResolvedPolicyConfig {
	return () => resolvePolicyConfig(settingsManager.getPolicySettings());
}
