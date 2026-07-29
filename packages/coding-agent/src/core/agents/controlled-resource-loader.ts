import type { ResourceExtensionPaths, ResourceLoader, ResourceLoaderSkillProjection } from "../resource-loader.ts";
import { createSkillAllowlistOverride, type SkillResourceSet } from "../skill-registry.ts";
import type { AgentProfile } from "./agent-profile.ts";

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
export function createControlledResourceLoader(base: ResourceLoader, profile: AgentProfile): ResourceLoader {
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
		getSystemPrompt: () => profile.systemPrompt,
		getAppendSystemPrompt: () => [],
		// Child extensions are not allowed to mutate the Coordinator's resource set.
		extendResources: (_paths: ResourceExtensionPaths) => {},
		// A child must never start another ResourceLoader lifecycle.
		reload: async () => {},
	};
}
