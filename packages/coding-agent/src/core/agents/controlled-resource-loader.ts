import type { ResourceExtensionPaths, ResourceLoader, ResourceLoaderSkillProjection } from "../resource-loader.ts";
import { createSkillAllowlistOverride, type SkillResourceSet } from "../skill-registry.ts";
import type { AgentProfile } from "./agent-profile.ts";

export const CONTROLLED_AGENT_CLARIFICATION_PROTOCOL = `If the task cannot be completed without user clarification, do not ask interactively. Return exactly one machine-readable block in the final response:
<clarification_request>{"version":1,"questions":[{"question":"A focused question","options":["Option A","Option B"]}]}</clarification_request>
Use 1-4 questions and 2-4 concrete options per question. Do not request secrets.`;

export interface ControlledAgentRuntimeContext {
	agentId: string;
	peerControl: boolean;
}

function runtimePrompt(context: ControlledAgentRuntimeContext | undefined): string {
	if (!context) return "";
	const control = context.peerControl
		? "Use agent_control with stable Agent IDs to list peers, inspect status, capture a bounded tmux transcript, steer/follow up, or cancel."
		: "Peer Agent control is disabled for this task.";
	return `\n\n<agent_runtime version="1">\nAgent ID: ${context.agentId}\n${control}\n</agent_runtime>`;
}

function getRawSkills(loader: ResourceLoader): SkillResourceSet {
	const projection = loader.getSkillProjection?.();
	if (projection) return projection.raw;
	return loader.getSkills();
}

/**
 * Project the Coordinator's already-loaded resources for one child session.
 * It deliberately does not reload or rediscover resources, so M5 shares the
 * existing ResourceLoader lifecycle while still isolating Skills and prompts.
 */
export function createControlledResourceLoader(
	base: ResourceLoader,
	profile: AgentProfile,
	context?: ControlledAgentRuntimeContext,
): ResourceLoader {
	const skillPolicy = createSkillAllowlistOverride(profile.skillAllowlist ?? { allow: [] });
	const rawSkills = getRawSkills(base);
	const projectedSkills = skillPolicy(rawSkills);
	const projection: ResourceLoaderSkillProjection = {
		raw: rawSkills,
		projected: projectedSkills,
	};

	return {
		getExtensions: () => base.getExtensions(),
		getSkills: () => projectedSkills,
		getSkillProjection: () => projection,
		getPrompts: () => base.getPrompts(),
		getThemes: () => base.getThemes(),
		getAgentsFiles: () => base.getAgentsFiles(),
		getSystemPrompt: () =>
			`${profile.systemPrompt}\n\n${CONTROLLED_AGENT_CLARIFICATION_PROTOCOL}${runtimePrompt(context)}`,
		getAppendSystemPrompt: () => [],
		// Child extensions are not allowed to mutate the Coordinator's resource set.
		extendResources: (_paths: ResourceExtensionPaths) => {},
		// A child must never start another ResourceLoader lifecycle.
		reload: async () => {},
	};
}
