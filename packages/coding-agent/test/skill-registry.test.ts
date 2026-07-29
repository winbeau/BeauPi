import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	getSkillRegistryScopePaths,
	loadSkillRegistry,
	resolveSkillRegistryProjection,
	SKILL_REGISTRY_VERSION,
	type SkillRegistryEntry,
	validateSkillRegistryEntry,
	writeSkillRegistry,
} from "../src/core/skill-registry.ts";
import { hasTrustRequiringProjectResources } from "../src/core/trust-manager.ts";

describe("BeauPi skill registry", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `beaupi-skill-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createSkill(root: string, name: string, description: string, body = "Instructions"): string {
		mkdirSync(root, { recursive: true });
		const skillPath = join(root, "SKILL.md");
		writeFileSync(skillPath, `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
		return skillPath;
	}

	function entry(options: {
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

	it("persists deterministic scoped JSON with atomic cleanup", () => {
		const alpha = entry({ id: "2", name: "alpha", scope: "user", path: "skills/alpha" });
		alpha.diagnostics = [
			{ code: "source_update_unavailable", severity: "info", message: "z" },
			{ code: "source_missing", severity: "warning", message: "a" },
		];
		const zeta = entry({ id: "1", name: "zeta", scope: "user", path: "skills/zeta" });

		writeSkillRegistry({
			scope: "user",
			cwd,
			agentDir,
			registry: { version: SKILL_REGISTRY_VERSION, entries: [zeta, alpha] },
		});
		const paths = getSkillRegistryScopePaths({ scope: "user", cwd, agentDir });
		const first = readFileSync(paths.registryPath, "utf-8");
		expect(first.endsWith("\n")).toBe(true);
		expect(first.indexOf('"name": "alpha"')).toBeLessThan(first.indexOf('"name": "zeta"'));
		expect(first.indexOf('"message": "z"')).toBeLessThan(first.indexOf('"message": "a"'));

		writeSkillRegistry({
			scope: "user",
			cwd,
			agentDir,
			registry: { version: SKILL_REGISTRY_VERSION, entries: [alpha, zeta] },
		});
		expect(readFileSync(paths.registryPath, "utf-8")).toBe(first);
		expect(readdirSync(agentDir).filter((name) => name.includes(".tmp") || name.endsWith(".lock"))).toEqual([]);
		expect(loadSkillRegistry({ scope: "user", cwd, agentDir }).registry.entries.map((item) => item.name)).toEqual([
			"alpha",
			"zeta",
		]);
	});

	it("reports malformed registries without overwriting them and gates project writes", () => {
		const userPaths = getSkillRegistryScopePaths({ scope: "user", cwd, agentDir });
		writeFileSync(userPaths.registryPath, "{not-json\n");
		const loaded = loadSkillRegistry({ scope: "user", cwd, agentDir });
		expect(loaded.registry.entries).toEqual([]);
		expect(loaded.diagnostics.map((item) => item.code)).toEqual(["registry_malformed"]);
		expect(readFileSync(userPaths.registryPath, "utf-8")).toBe("{not-json\n");

		expect(() =>
			writeSkillRegistry({
				scope: "project",
				cwd,
				agentDir,
				registry: { version: SKILL_REGISTRY_VERSION, entries: [] },
			}),
		).toThrow("Project is not trusted");
		writeSkillRegistry({
			scope: "project",
			cwd,
			agentDir,
			projectTrusted: true,
			registry: { version: SKILL_REGISTRY_VERSION, entries: [] },
		});
		expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
	});

	it("validates frontmatter, relative references, scripts, and executables without running them", () => {
		const skillDir = join(agentDir, "skills", "review");
		createSkill(skillDir, "review", "Review changes", "See [guide](references/guide.md) and [missing](missing.md).");
		mkdirSync(join(skillDir, "references"), { recursive: true });
		writeFileSync(join(skillDir, "references", "guide.md"), "Guide\n");
		mkdirSync(join(skillDir, "scripts"), { recursive: true });
		const scriptPath = join(skillDir, "scripts", "review.sh");
		writeFileSync(scriptPath, "#!/bin/sh\nexit 99\n");
		chmodSync(scriptPath, 0o755);
		const registryEntry = entry({ id: "review", name: "review", scope: "user", path: "skills/review" });
		const paths = getSkillRegistryScopePaths({ scope: "user", cwd, agentDir });

		const invalid = validateSkillRegistryEntry({ entry: registryEntry, paths, projectTrusted: true });
		expect(invalid.valid).toBe(false);
		expect(invalid.references).toEqual(["missing.md", "references/guide.md"]);
		expect(invalid.diagnostics.some((item) => item.code === "relative_reference_missing")).toBe(true);
		expect(invalid.inventory.scripts).toEqual(["scripts/review.sh"]);
		expect(invalid.inventory.executables).toEqual(["scripts/review.sh"]);

		writeFileSync(join(skillDir, "missing.md"), "Present\n");
		const valid = validateSkillRegistryEntry({ entry: registryEntry, paths, projectTrusted: true });
		expect(valid.valid).toBe(true);
		expect(valid.diagnostics.some((item) => item.code === "script_inventory")).toBe(true);
		expect(valid.diagnostics.some((item) => item.code === "executable_inventory")).toBe(true);

		createSkill(join(agentDir, "skills", "bad"), "Bad Name", "");
		const bad = validateSkillRegistryEntry({
			entry: entry({ id: "bad", name: "Bad Name", scope: "user", path: "skills/bad" }),
			paths,
			projectTrusted: true,
		});
		expect(bad.valid).toBe(false);
		expect(bad.diagnostics.some((item) => item.code === "name_invalid")).toBe(true);
		expect(bad.diagnostics.some((item) => item.code === "description_required")).toBe(true);
	});

	it("projects enabled entries, preserves disabled records, and gates untrusted project registries", () => {
		createSkill(join(agentDir, "skills", "enabled"), "enabled", "Enabled skill");
		createSkill(join(agentDir, "skills", "disabled"), "disabled", "Disabled skill");
		createSkill(join(cwd, CONFIG_DIR_NAME, "skills", "project"), "project", "Project skill");
		writeSkillRegistry({
			scope: "user",
			cwd,
			agentDir,
			registry: {
				version: SKILL_REGISTRY_VERSION,
				entries: [
					entry({ id: "enabled", name: "enabled", scope: "user", path: "skills/enabled" }),
					entry({ id: "disabled", name: "disabled", scope: "user", path: "skills/disabled", enabled: false }),
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
				entries: [entry({ id: "project", name: "project", scope: "project", path: "skills/project" })],
			},
		});

		const projection = resolveSkillRegistryProjection({ cwd, agentDir, projectTrusted: false });
		expect(projection.records.map((record) => record.entry.name)).toEqual(["disabled", "enabled"]);
		expect(projection.enabledRecords.map((record) => record.entry.name)).toEqual(["enabled"]);
		expect(projection.diagnostics.some((item) => item.code === "project_untrusted")).toBe(true);
		expect(projection.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "source_update_unavailable",
				message: "Local and external-directory Skill sources cannot be updated automatically",
			}),
		);
	});

	it("applies registry precedence, suppresses disabled managed skills, and reports both conflict sources", async () => {
		const projectRegistryPath = join(cwd, CONFIG_DIR_NAME, "registry-skills", "deploy");
		const projectRegistrySkill = createSkill(projectRegistryPath, "deploy", "Project registry");
		createSkill(join(cwd, CONFIG_DIR_NAME, "skills", "native-deploy"), "deploy", "Project native");
		const userRegistryPath = join(agentDir, "registry-skills", "deploy");
		createSkill(userRegistryPath, "deploy", "User registry");
		createSkill(join(agentDir, "skills", "disabled"), "disabled", "Must stay disabled");
		writeSkillRegistry({
			scope: "project",
			cwd,
			agentDir,
			projectTrusted: true,
			registry: {
				version: SKILL_REGISTRY_VERSION,
				entries: [
					entry({ id: "project-deploy", name: "deploy", scope: "project", path: "registry-skills/deploy" }),
				],
			},
		});
		writeSkillRegistry({
			scope: "user",
			cwd,
			agentDir,
			registry: {
				version: SKILL_REGISTRY_VERSION,
				entries: [
					entry({ id: "user-deploy", name: "deploy", scope: "user", path: "registry-skills/deploy" }),
					entry({ id: "disabled", name: "disabled", scope: "user", path: "skills/disabled", enabled: false }),
				],
			},
		});

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();
		expect(loader.getSkills().skills.find((skill) => skill.name === "deploy")?.filePath).toBe(projectRegistrySkill);
		expect(loader.getSkills().skills.some((skill) => skill.name === "disabled")).toBe(false);
		const collision = loader
			.getSkills()
			.diagnostics.find((item) => item.type === "collision" && item.collision?.name === "deploy");
		expect(collision?.collision?.winnerPath).toBe(projectRegistrySkill);
		expect(collision?.collision?.winnerSource).toContain("registry:local:");
		expect(collision?.collision?.loserPath).toBeDefined();
		expect(collision?.collision?.loserSource).toBeDefined();

		const explicitPath = createSkill(join(tempDir, "explicit", "deploy"), "deploy", "Explicit temporary");
		const explicitLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			additionalSkillPaths: [explicitPath],
		});
		await explicitLoader.reload();
		expect(explicitLoader.getSkills().skills.find((skill) => skill.name === "deploy")?.filePath).toBe(explicitPath);
	});

	it("keeps resources_discover extensions conflict-aware across registry reloads", async () => {
		const registrySkill = createSkill(join(agentDir, "registry-skills", "shared"), "shared", "Registry skill");
		const extensionSkill = createSkill(join(tempDir, "extension-skills", "shared"), "shared", "Extension skill");
		const registryEntry = entry({ id: "shared", name: "shared", scope: "user", path: "registry-skills/shared" });
		writeSkillRegistry({
			scope: "user",
			cwd,
			agentDir,
			registry: { version: SKILL_REGISTRY_VERSION, entries: [registryEntry] },
		});
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();
		const extendFromDiscovery = () =>
			loader.extendResources({
				skillPaths: [
					{
						path: extensionSkill,
						metadata: {
							source: "extension:registry-test",
							scope: "temporary",
							origin: "top-level",
						},
					},
				],
			});
		extendFromDiscovery();
		expect(loader.getSkills().skills.find((skill) => skill.name === "shared")?.filePath).toBe(registrySkill);
		expect(
			loader
				.getSkills()
				.diagnostics.some(
					(item) =>
						item.collision?.winnerSource?.startsWith("registry:") === true &&
						item.collision?.loserSource === "extension:registry-test",
				),
		).toBe(true);

		writeSkillRegistry({
			scope: "user",
			cwd,
			agentDir,
			registry: {
				version: SKILL_REGISTRY_VERSION,
				entries: [{ ...registryEntry, enabled: false }],
			},
		});
		await loader.reload();
		extendFromDiscovery();
		expect(loader.getSkills().skills.find((skill) => skill.name === "shared")?.filePath).toBe(extensionSkill);
	});

	it("keeps native discovery working when a registry is malformed", async () => {
		const nativePath = createSkill(join(agentDir, "skills", "native"), "native", "Native skill");
		const paths = getSkillRegistryScopePaths({ scope: "user", cwd, agentDir });
		writeFileSync(paths.registryPath, "[]\n");
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();
		expect(loader.getSkills().skills.find((skill) => skill.name === "native")?.filePath).toBe(nativePath);
		expect(loader.getSkills().diagnostics.some((item) => item.message.includes("registry_malformed"))).toBe(true);
	});

	it("rebuilds registry discovery on reload and honors project trust", async () => {
		createSkill(join(agentDir, "registry-skills", "one"), "one", "First skill");
		createSkill(join(agentDir, "registry-skills", "two"), "two", "Second skill");
		createSkill(join(cwd, CONFIG_DIR_NAME, "registry-skills", "project"), "project", "Project skill");
		writeSkillRegistry({
			scope: "user",
			cwd,
			agentDir,
			registry: {
				version: SKILL_REGISTRY_VERSION,
				entries: [entry({ id: "current", name: "one", scope: "user", path: "registry-skills/one" })],
			},
		});
		writeSkillRegistry({
			scope: "project",
			cwd,
			agentDir,
			projectTrusted: true,
			registry: {
				version: SKILL_REGISTRY_VERSION,
				entries: [entry({ id: "project", name: "project", scope: "project", path: "registry-skills/project" })],
			},
		});

		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();
		expect(loader.getSkills().skills.map((skill) => skill.name)).toContain("one");
		expect(loader.getSkills().skills.map((skill) => skill.name)).not.toContain("project");
		expect(loader.getSkills().diagnostics.some((item) => item.message.includes("project_untrusted"))).toBe(true);

		writeSkillRegistry({
			scope: "user",
			cwd,
			agentDir,
			registry: {
				version: SKILL_REGISTRY_VERSION,
				entries: [entry({ id: "current", name: "two", scope: "user", path: "registry-skills/two" })],
			},
		});
		await loader.reload();
		expect(loader.getSkills().skills.map((skill) => skill.name)).not.toContain("one");
		expect(loader.getSkills().skills.map((skill) => skill.name)).toContain("two");
		expect(existsSync(join(agentDir, "skills-registry.json"))).toBe(true);
	});
});
