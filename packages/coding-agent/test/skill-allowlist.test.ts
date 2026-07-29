import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSkillAllowlistOverride } from "../src/core/skill-registry.ts";

function createSkill(root: string, name: string): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\nInstructions\n`);
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

	it("filters a ResourceLoader projection by allow and deny, with deny taking precedence", async () => {
		createSkill(join(agentDir, "skills", "docs-research"), "docs-research");
		createSkill(join(agentDir, "skills", "code-review"), "code-review");
		createSkill(join(agentDir, "skills", "deploy-production"), "deploy-production");

		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
			skillsOverride: createSkillAllowlistOverride({
				allow: ["docs-research", "code-review", "deploy-production"],
				deny: ["deploy-production"],
			}),
		});
		await loader.reload();

		expect(
			loader
				.getSkills()
				.skills.map((skill) => skill.name)
				.sort(),
		).toEqual(["code-review", "docs-research"]);
		expect(loader.getSkills().diagnostics).toEqual([]);
	});

	it("treats an empty allowlist as no Skills and diagnoses unknown allowed names", async () => {
		createSkill(join(agentDir, "skills", "docs-research"), "docs-research");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
			skillsOverride: createSkillAllowlistOverride({ allow: ["missing-skill"] }),
		});
		await loader.reload();

		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getSkills().diagnostics).toContainEqual({
			type: "error",
			message: 'Skill allowlist entry "missing-skill" was not discovered',
		});

		const emptyLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
			skillsOverride: createSkillAllowlistOverride({ allow: [] }),
		});
		await emptyLoader.reload();
		expect(emptyLoader.getSkills().skills).toEqual([]);
	});
});
