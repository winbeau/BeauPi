import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { DefaultResourceLoader, type DefaultResourceLoaderOptions } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	getSkillRegistryScopePaths,
	SKILL_REGISTRY_VERSION,
	type SkillRegistryEntry,
	writeSkillRegistry,
} from "../src/core/skill-registry.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";

function createSkill(root: string, name: string, description = `${name} skill`, body = "Instructions"): string {
	mkdirSync(root, { recursive: true });
	const skillPath = join(root, "SKILL.md");
	writeFileSync(skillPath, `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
	return skillPath;
}

function registryEntry(options: {
	id: string;
	name: string;
	scope: "user" | "project";
	path: string;
	enabled?: boolean;
}): SkillRegistryEntry {
	return {
		id: options.id,
		name: options.name,
		source: { type: "local", path: options.path },
		scope: options.scope,
		path: options.path,
		enabled: options.enabled ?? true,
		importedAt: 100,
		diagnostics: [],
	};
}

describe("controlled Skill allowlists", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `beaupi-skill-allowlist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("preserves the main-session projection when no allow or deny list is provided", async () => {
		createSkill(join(agentDir, "skills", "docs-research"), "docs-research");
		createSkill(join(agentDir, "skills", "code-review"), "code-review");
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const mainLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		const controlledLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, skillPolicy: {} });

		await mainLoader.reload();
		await controlledLoader.reload();

		expect(controlledLoader.getSkills()).toEqual(mainLoader.getSkills());
		expect(controlledLoader.getSkillProjection().projected).toEqual(controlledLoader.getSkillProjection().raw);
	});

	it("applies allow by Skill name and deny after allow while retaining the raw projection", async () => {
		const docsPath = createSkill(join(agentDir, "skills", "docs-research"), "docs-research");
		createSkill(join(agentDir, "skills", "code-review"), "code-review");
		createSkill(join(agentDir, "skills", "deploy-production"), "deploy-production");
		createSkill(join(agentDir, "skills", "unlisted"), "unlisted");
		const options: DefaultResourceLoaderOptions = {
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
			skillPolicy: {
				allow: ["docs-research", "code-review", "deploy-production"],
				deny: ["deploy-production"],
			},
		};
		const loader = new DefaultResourceLoader(options);
		await loader.reload();

		expect(
			loader
				.getSkills()
				.skills.map((skill) => skill.name)
				.sort(),
		).toEqual(["code-review", "docs-research"]);
		expect(loader.getSkills().diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "skill_policy_filtered",
					name: "deploy-production",
					policy: "deny",
					reason: "denied",
				}),
				expect.objectContaining({
					code: "skill_policy_filtered",
					name: "unlisted",
					policy: "allow",
					reason: "not-allowed",
				}),
			]),
		);
		const projection = loader.getSkillProjection();
		expect(projection.raw.skills.map((skill) => skill.name)).toEqual(
			expect.arrayContaining(["docs-research", "code-review", "deploy-production", "unlisted"]),
		);
		expect(projection.raw.skills.find((skill) => skill.name === "docs-research")?.sourceInfo.path).toBe(docsPath);
		expect(projection.projected.skills).toEqual(loader.getSkills().skills);
	});

	it("returns structured diagnostics for missing allow and deny names", async () => {
		createSkill(join(agentDir, "skills", "docs-research"), "docs-research");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
			skillPolicy: { allow: ["missing-allow"], deny: ["missing-deny"] },
		});
		await loader.reload();

		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getSkills().diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "error",
					code: "skill_allowlist_missing",
					name: "missing-allow",
					policy: "allow",
					reason: "missing",
				}),
				expect.objectContaining({
					type: "warning",
					code: "skill_denylist_missing",
					name: "missing-deny",
					policy: "deny",
					reason: "missing",
				}),
			]),
		);

		const emptyLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
			skillPolicy: { allow: [] },
		});
		await emptyLoader.reload();
		expect(emptyLoader.getSkills().skills).toEqual([]);
	});

	it("does not bypass disabled, invalid, collision, or untrusted project discovery rules", async () => {
		createSkill(join(agentDir, "registry-skills", "disabled"), "disabled");
		createSkill(join(agentDir, "registry-skills", "invalid"), "different-name");
		createSkill(join(agentDir, "registry-skills", "collision-one"), "collision");
		createSkill(join(agentDir, "registry-skills", "collision-two"), "collision");
		createSkill(join(cwd, CONFIG_DIR_NAME, "registry-skills", "project-only"), "project-only");
		writeSkillRegistry({
			scope: "user",
			cwd,
			agentDir,
			registry: {
				version: SKILL_REGISTRY_VERSION,
				entries: [
					registryEntry({
						id: "disabled",
						name: "disabled",
						scope: "user",
						path: "registry-skills/disabled",
						enabled: false,
					}),
					registryEntry({
						id: "invalid",
						name: "invalid",
						scope: "user",
						path: "registry-skills/invalid",
					}),
					registryEntry({
						id: "collision-one",
						name: "collision",
						scope: "user",
						path: "registry-skills/collision-one",
					}),
					registryEntry({
						id: "collision-two",
						name: "collision",
						scope: "user",
						path: "registry-skills/collision-two",
					}),
				],
			},
		});
		writeSkillRegistry({
			scope: "project",
			cwd,
			agentDir,
			projectTrusted: true,
			registry: {
				version: SKILL_REGISTRY_VERSION,
				entries: [
					registryEntry({
						id: "project-only",
						name: "project-only",
						scope: "project",
						path: "registry-skills/project-only",
					}),
				],
			},
		});
		const userRegistryPath = getSkillRegistryScopePaths({ scope: "user", cwd, agentDir }).registryPath;
		const projectRegistryPath = getSkillRegistryScopePaths({ scope: "project", cwd, agentDir }).registryPath;
		const userRegistryBefore = readFileSync(userRegistryPath, "utf-8");
		const projectRegistryBefore = readFileSync(projectRegistryPath, "utf-8");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
			skillPolicy: { allow: ["disabled", "different-name", "collision", "project-only"] },
		});
		await loader.reload();

		expect(loader.getSkills().skills.filter((skill) => skill.name === "collision")).toHaveLength(1);
		expect(loader.getSkills().skills.some((skill) => skill.name === "disabled")).toBe(false);
		expect(loader.getSkills().skills.some((skill) => skill.name === "different-name")).toBe(false);
		expect(loader.getSkills().skills.some((skill) => skill.name === "project-only")).toBe(false);
		expect(loader.getSkills().diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "skill_policy_filtered",
					name: "disabled",
					reason: "disabled",
				}),
				expect.objectContaining({
					code: "skill_policy_filtered",
					name: "different-name",
					reason: "invalid",
				}),
				expect.objectContaining({ type: "collision", name: "collision" }),
				expect.objectContaining({ code: "project_untrusted" }),
				expect.objectContaining({ code: "skill_allowlist_missing", name: "project-only" }),
			]),
		);
		expect(loader.getSkillProjection().raw.registryProjection?.records.map((record) => record.entry.name)).toEqual(
			expect.arrayContaining(["disabled", "invalid", "collision"]),
		);
		expect(readFileSync(userRegistryPath, "utf-8")).toBe(userRegistryBefore);
		expect(readFileSync(projectRegistryPath, "utf-8")).toBe(projectRegistryBefore);
	});

	it("keeps the instance policy active across reloads", async () => {
		const allowedRoot = join(agentDir, "skills", "allowed");
		createSkill(allowedRoot, "allowed");
		createSkill(join(agentDir, "skills", "blocked"), "blocked");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
			skillPolicy: { allow: ["allowed"] },
		});
		await loader.reload();
		expect(loader.getSkills().skills.map((skill) => skill.name)).toContain("allowed");
		expect(loader.getSkills().skills.map((skill) => skill.name)).not.toContain("blocked");

		rmSync(allowedRoot, { recursive: true, force: true });
		createSkill(join(agentDir, "skills", "blocked-two"), "blocked-two");
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getSkills().diagnostics).toContainEqual(
			expect.objectContaining({ code: "skill_allowlist_missing", name: "allowed" }),
		);
	});

	it("keeps filtered Skills out of the System Prompt and /skill:name expansion", async () => {
		createSkill(join(agentDir, "skills", "allowed"), "allowed", "Allowed skill", "Allowed instructions");
		createSkill(join(agentDir, "skills", "blocked"), "blocked", "Blocked skill", "Blocked instructions");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
			skillPolicy: { allow: ["allowed"] },
		});
		await loader.reload();
		const harness = await createHarness({ resourceLoader: loader });
		try {
			expect(harness.session.systemPrompt).toContain("<name>allowed</name>");
			expect(harness.session.systemPrompt).not.toContain("<name>blocked</name>");
			const providerInputs: string[] = [];
			harness.setResponses([
				(context) => {
					const user = context.messages.find((message) => message.role === "user");
					providerInputs.push(user ? getMessageText(user) : "");
					return fauxAssistantMessage("allowed");
				},
				(context) => {
					const users = context.messages.filter((message) => message.role === "user");
					providerInputs.push(users.length > 0 ? getMessageText(users[users.length - 1]) : "");
					return fauxAssistantMessage("blocked");
				},
			]);

			await harness.session.prompt("/skill:allowed");
			await harness.session.prompt("/skill:blocked");

			expect(providerInputs[0]).toContain('<skill name="allowed"');
			expect(providerInputs[0]).toContain("Allowed instructions");
			expect(providerInputs[1]).toBe("/skill:blocked");
			expect(providerInputs[1]).not.toContain("Blocked instructions");
		} finally {
			harness.cleanup();
		}
	});
});
