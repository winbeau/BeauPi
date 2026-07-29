import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	getSkillRegistryScopePaths,
	loadSkillRegistry,
	SKILL_REGISTRY_VERSION,
	writeSkillRegistry,
} from "../src/core/skill-registry.ts";
import { SkillRegistryService, SkillRegistryServiceError } from "../src/core/skill-registry-service.ts";

function createSkill(root: string, name: string, description = "A test skill."): string {
	mkdirSync(root, { recursive: true });
	const filePath = join(root, "SKILL.md");
	writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n---\nInstructions for ${name}.\n`);
	return filePath;
}

describe("SkillRegistryService", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `beaupi-skill-service-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createService(
		projectTrusted: boolean,
		getCurrentSkillNames: () => ReadonlySet<string> = () => new Set<string>(),
	): SkillRegistryService {
		let nextId = 0;
		return new SkillRegistryService({
			cwd,
			agentDir,
			projectTrusted,
			getCurrentSkillNames,
			now: () => 100,
			createId: () => `test-entry-${++nextId}`,
		});
	}

	it("imports a local directory into the managed path and records validation diagnostics", async () => {
		const sourceDir = join(tempDir, "source", "review");
		createSkill(sourceDir, "review");

		const result = await createService(true).importLocal(sourceDir);
		const managedPath = join(agentDir, "skills", "review");
		expect(result.entry.source).toEqual({ type: "local", path: sourceDir });
		expect(result.entry.path).toBe("skills/review");
		expect(result.managedPath).toBe(managedPath);
		expect(result.validation.valid).toBe(true);
		expect(readFileSync(join(managedPath, "SKILL.md"), "utf8")).toContain("name: review");
		expect(loadSkillRegistry({ scope: "user", cwd, agentDir }).registry.entries[0]?.diagnostics).toEqual(
			result.validation.diagnostics,
		);
	});

	it("imports Claude and Codex directories as external-directory sources without executing contents", async () => {
		const originalHome = process.env.HOME;
		process.env.HOME = tempDir;
		try {
			const claudeDir = join(tempDir, ".claude", "skills", "review");
			createSkill(claudeDir, "review");
			mkdirSync(join(claudeDir, "scripts"), { recursive: true });
			writeFileSync(join(claudeDir, "scripts", "review.sh"), "echo should-not-run\n");
			const service = createService(true);
			const result = await service.importLocal("~/.claude/skills/review");
			expect(result.entry.source).toEqual({ type: "external-directory", path: claudeDir, harness: "claude" });
			expect(result.entry.path).toBe("skills/review");
			expect(result.validation.diagnostics.some((item) => item.code === "script_inventory")).toBe(true);

			const codexDir = join(tempDir, ".codex", "skills", "lint");
			createSkill(codexDir, "lint");
			const codexResult = await service.importLocal("~/.codex/skills/lint");
			expect(codexResult.entry.source).toEqual({ type: "external-directory", path: codexDir, harness: "codex" });
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
		}
	});

	it("opens SKILL.md without mutating Registry state and reports structured file errors", async () => {
		const sourceDir = join(tempDir, "source", "review");
		createSkill(sourceDir, "review");
		const service = createService(true);
		await service.importLocal(sourceDir);
		const before = loadSkillRegistry({ scope: "user", cwd, agentDir }).registry;
		const opened = service.readSkillFile("review");
		expect(opened.path).toBe(join(agentDir, "skills", "review", "SKILL.md"));
		expect(opened.content).toContain("name: review");
		expect(loadSkillRegistry({ scope: "user", cwd, agentDir }).registry).toEqual(before);
		writeSkillRegistry({
			scope: "project",
			cwd,
			agentDir,
			projectTrusted: true,
			registry: { version: SKILL_REGISTRY_VERSION, entries: [] },
		});
		expect(createService(false).readSkillFile("review").content).toContain("name: review");

		rmSync(opened.path);
		expect(() => service.readSkillFile("review")).toThrowError(SkillRegistryServiceError);
		try {
			service.readSkillFile("review");
		} catch (error) {
			expect(error).toMatchObject({ diagnostics: [expect.objectContaining({ code: "skill_file_missing" })] });
		}

		const escapedDir = join(agentDir, "skills", "escaped");
		const outsideSkill = join(tempDir, "outside-SKILL.md");
		mkdirSync(escapedDir, { recursive: true });
		writeFileSync(outsideSkill, "---\nname: escaped\ndescription: escaped\n---\n");
		symlinkSync(outsideSkill, join(escapedDir, "SKILL.md"));
		const brokenRegistry = loadSkillRegistry({ scope: "user", cwd, agentDir }).registry;
		brokenRegistry.entries.push({
			id: "escaped-entry",
			name: "escaped",
			source: { type: "local", path: escapedDir },
			scope: "user",
			path: "skills/escaped",
			enabled: true,
			importedAt: 100,
			diagnostics: [],
		});
		writeSkillRegistry({ scope: "user", cwd, agentDir, registry: brokenRegistry });
		expect(() => service.readSkillFile("escaped")).toThrowError(SkillRegistryServiceError);
		try {
			service.readSkillFile("escaped");
		} catch (error) {
			expect(error).toMatchObject({ diagnostics: [expect.objectContaining({ code: "skill_path_invalid" })] });
		}

		const brokenDir = join(agentDir, "skills", "broken");
		mkdirSync(join(brokenDir, "SKILL.md"), { recursive: true });
		brokenRegistry.entries.push({
			id: "broken-entry",
			name: "broken",
			source: { type: "local", path: brokenDir },
			scope: "user",
			path: "skills/broken",
			enabled: true,
			importedAt: 100,
			diagnostics: [],
		});
		writeSkillRegistry({ scope: "user", cwd, agentDir, registry: brokenRegistry });
		expect(() => service.readSkillFile("broken")).toThrowError(SkillRegistryServiceError);
		try {
			service.readSkillFile("broken");
		} catch (error) {
			expect(error).toMatchObject({ diagnostics: [expect.objectContaining({ code: "skill_file_read_failed" })] });
		}
	});

	it("supports enable, disable, and validation mutations", async () => {
		const sourceDir = join(tempDir, "source", "review");
		createSkill(sourceDir, "review");
		const service = createService(true);
		await service.importLocal(sourceDir);

		expect(service.setEnabled("review", false).changed).toBe(true);
		expect(service.getSnapshot().records[0]?.entry.enabled).toBe(false);
		expect(service.setEnabled("review", true).changed).toBe(true);
		expect(service.setEnabled("review", true).changed).toBe(false);

		writeFileSync(join(agentDir, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: [bad\n---\n");
		const validation = service.validate("review")[0];
		expect(validation?.validation?.valid).toBe(false);
		expect(validation?.validation?.diagnostics.some((item) => item.code === "frontmatter_invalid")).toBe(true);
	});

	it("removes only the Registry reference until managed files are explicitly deleted", async () => {
		const sourceDir = join(tempDir, "source", "review");
		createSkill(sourceDir, "review");
		const service = createService(true);
		await service.importLocal(sourceDir);

		const result = service.remove("review");
		expect(result.managedPath).toBe(join(agentDir, "skills", "review"));
		expect(existsSync(result.managedPath!)).toBe(true);
		expect(loadSkillRegistry({ scope: "user", cwd, agentDir }).registry.entries).toEqual([]);

		service.deleteManagedFiles(result);
		expect(existsSync(result.managedPath!)).toBe(false);
	});

	it("gates project mutation and rejects Registry or discovered name collisions", async () => {
		const sourceDir = join(tempDir, "source", "review");
		createSkill(sourceDir, "review");
		await expect(createService(false).importLocal(sourceDir, "project")).rejects.toThrow("not trusted");

		const trustedService = createService(true);
		const projectResult = await trustedService.importLocal(sourceDir, "project");
		expect(projectResult.managedPath).toBe(join(cwd, CONFIG_DIR_NAME, "skills", "review"));
		expect(() => createService(false).setEnabled("review", false)).toThrow(SkillRegistryServiceError);
		await expect(trustedService.importLocal(sourceDir, "project")).rejects.toThrow("already registered");
		expect(loadSkillRegistry({ scope: "project", cwd, agentDir }).registry.entries).toHaveLength(1);

		const collisionSource = join(tempDir, "source", "collision");
		createSkill(collisionSource, "collision");
		await expect(createService(true, () => new Set(["collision"])).importLocal(collisionSource)).rejects.toThrow(
			"collides",
		);
	});

	it("never overwrites a malformed Registry during mutation", async () => {
		const paths = getSkillRegistryScopePaths({ scope: "user", cwd, agentDir });
		mkdirSync(join(agentDir, "skills"), { recursive: true });
		writeFileSync(paths.registryPath, "{not-json\n");
		const sourceDir = join(tempDir, "source", "review");
		createSkill(sourceDir, "review");

		await expect(createService(true).importLocal(sourceDir)).rejects.toThrow("malformed");
		expect(readFileSync(paths.registryPath, "utf8")).toBe("{not-json\n");
	});

	it("projects mutations through ResourceLoader reload without restarting", async () => {
		const sourceDir = join(tempDir, "source", "review");
		createSkill(sourceDir, "review");
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		const service = createService(true, () => new Set(loader.getSkills().skills.map((skill) => skill.name)));

		await loader.reload();
		await service.importLocal(sourceDir);
		await loader.reload();
		expect(loader.getSkills().skills.map((skill) => skill.name)).toContain("review");

		service.setEnabled("review", false);
		await loader.reload();
		expect(loader.getSkills().skills.map((skill) => skill.name)).not.toContain("review");

		service.setEnabled("review", true);
		await loader.reload();
		expect(loader.getSkills().skills.map((skill) => skill.name)).toContain("review");

		expect(existsSync(join(cwd, CONFIG_DIR_NAME))).toBe(false);
	});
});
