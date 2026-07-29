import type { SkillAllowlist } from "../skill-registry.ts";

export type AgentCancellationStrategy = "abort" | "graceful";

/** Configuration for one controlled in-process sub-agent. */
export interface AgentProfile {
	/** Stable profile name used by delegate_task. */
	id: string;
	/** System prompt used only by this sub-agent. */
	systemPrompt: string;
	/** Tool names exposed to the sub-agent. delegate_task is always removed. */
	toolAllowlist?: readonly string[];
	/** M4 Skill policy applied to the shared ResourceLoader projection. */
	skillAllowlist?: SkillAllowlist;
	/** Maximum generated output tokens across the whole task. */
	maxTokens?: number;
	/** Maximum number of model turns, including turns that execute tools. */
	maxTurns?: number;
	/** Maximum wall-clock time for the task. */
	timeoutMs?: number;
	/** How a cancellation signal should stop the sub-agent. */
	cancelStrategy?: AgentCancellationStrategy;
	/** Whether edit/write tools may be exposed. */
	allowFileModifications?: boolean;
}

/** Pool-level settings used by createAgentSession({ agentPool }). */
export interface AgentPoolConfig {
	maxConcurrency?: number;
	profiles?: readonly AgentProfile[];
	defaultProfile?: string;
}

export const DEFAULT_AGENT_PROFILE: AgentProfile = Object.freeze({
	id: "reviewer",
	systemPrompt:
		"You are a controlled BeauPi sub-agent. Work independently on the assigned task. " +
		"Return a concise summary with concrete findings, references, modified files, and checks. " +
		"Do not delegate to another agent.",
	toolAllowlist: ["read", "grep", "find", "ls", "docs_search", "docs_read", "docs_resolve_task"],
	skillAllowlist: { allow: [] },
	maxTokens: 4096,
	maxTurns: 8,
	timeoutMs: 120_000,
	cancelStrategy: "abort",
	allowFileModifications: false,
});

export const DEFAULT_IMPLEMENTER_PROFILE: AgentProfile = Object.freeze({
	id: "implementer",
	systemPrompt:
		"You are a controlled BeauPi implementation sub-agent. Make only the requested changes, " +
		"verify them with focused checks, and return a concise structured summary. Do not delegate to another agent.",
	toolAllowlist: [
		"read",
		"bash",
		"edit",
		"write",
		"grep",
		"find",
		"ls",
		"docs_search",
		"docs_read",
		"docs_resolve_task",
	],
	skillAllowlist: { allow: [] },
	maxTokens: 8192,
	maxTurns: 12,
	timeoutMs: 300_000,
	cancelStrategy: "abort",
	allowFileModifications: true,
});

export const DEFAULT_AGENT_PROFILES: readonly AgentProfile[] = [DEFAULT_AGENT_PROFILE, DEFAULT_IMPLEMENTER_PROFILE];

function assertPositiveInteger(value: number | undefined, field: string): void {
	if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
		throw new Error(`${field} must be a positive integer`);
	}
}

/** Validate profile configuration before a child session is created. */
export function validateAgentProfile(profile: AgentProfile): void {
	if (!profile.id.trim()) throw new Error("Agent profile id must not be empty");
	if (!profile.systemPrompt.trim())
		throw new Error(`Agent profile ${JSON.stringify(profile.id)} needs a system prompt`);
	assertPositiveInteger(profile.maxTokens, `Agent profile ${JSON.stringify(profile.id)} maxTokens`);
	assertPositiveInteger(profile.maxTurns, `Agent profile ${JSON.stringify(profile.id)} maxTurns`);
	assertPositiveInteger(profile.timeoutMs, `Agent profile ${JSON.stringify(profile.id)} timeoutMs`);
	if (
		profile.cancelStrategy !== undefined &&
		profile.cancelStrategy !== "abort" &&
		profile.cancelStrategy !== "graceful"
	) {
		throw new Error(`Agent profile ${JSON.stringify(profile.id)} has an invalid cancelStrategy`);
	}
	if (profile.toolAllowlist) {
		for (const name of profile.toolAllowlist) {
			if (!name.trim()) throw new Error(`Agent profile ${JSON.stringify(profile.id)} contains an empty tool name`);
		}
	}
}

export function validateAgentPoolConfig(config: AgentPoolConfig): void {
	if (
		config.maxConcurrency !== undefined &&
		(!Number.isInteger(config.maxConcurrency) || config.maxConcurrency <= 0)
	) {
		throw new Error("Agent pool maxConcurrency must be a positive integer");
	}
	const profiles = config.profiles ?? DEFAULT_AGENT_PROFILES;
	if (profiles.length === 0) throw new Error("Agent pool needs at least one profile");
	const ids = new Set<string>();
	for (const profile of profiles) {
		validateAgentProfile(profile);
		if (ids.has(profile.id)) throw new Error(`Duplicate agent profile ${JSON.stringify(profile.id)}`);
		ids.add(profile.id);
	}
	if (config.defaultProfile !== undefined && !ids.has(config.defaultProfile)) {
		throw new Error(`Unknown default agent profile ${JSON.stringify(config.defaultProfile)}`);
	}
}

export function resolveAgentProfiles(config: AgentPoolConfig): Map<string, AgentProfile> {
	validateAgentPoolConfig(config);
	return new Map((config.profiles ?? DEFAULT_AGENT_PROFILES).map((profile) => [profile.id, profile]));
}
