import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { SKILL_REGISTRY_VERSION, writeSkillRegistry } from "../src/core/skill-registry.ts";
import { SkillRegistryService } from "../src/core/skill-registry-service.ts";
import { SkillRegistrySelectorComponent } from "../src/modes/interactive/components/skill-registry-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createSkill(root: string, name: string): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\nInstructions\n`);
}

describe("SkillRegistrySelectorComponent", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		initTheme("beaupi-dark", false);
		tempDir = join(tmpdir(), `beaupi-skill-selector-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("renders status, source, scope, paths, and diagnostics in the BeauPi list language", async () => {
		let id = 0;
		const service = new SkillRegistryService({
			cwd,
			agentDir,
			projectTrusted: true,
			createId: () => `entry-${++id}`,
		});
		const review = join(tempDir, "source", "review");
		const deploy = join(tempDir, "source", "deploy");
		createSkill(review, "review");
		createSkill(deploy, "deploy");
		await service.importLocal(review);
		await service.importLocal(deploy);
		service.setEnabled("review", false);
		writeFileSync(join(agentDir, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: [bad\n---\n");
		service.validate("deploy");

		const snapshot = service.getSnapshot();
		const component = new SkillRegistrySelectorComponent({
			snapshot,
			records: snapshot.records,
			formatPath: (path) => path.replace(tempDir, "$TEMP"),
			onAction: () => {},
			onCancel: () => {},
		});
		const output = component
			.render(180)
			.join("\n")
			.replace(/\u001b\[[0-9;]*m/g, "");

		expect(output).toContain("Skills");
		expect(output).toContain("review");
		expect(output).toContain("deploy");
		expect(output).toContain("user");
		expect(output).toContain("local:");
		expect(output).toContain("disabled");
		expect(output).toContain("invalid");
		expect(output).toContain("frontmatter_invalid");
	});

	it("shows an untrusted project Registry as ignored rather than active", () => {
		writeSkillRegistry({
			scope: "project",
			cwd,
			agentDir,
			projectTrusted: true,
			registry: { version: SKILL_REGISTRY_VERSION, entries: [] },
		});
		const snapshot = new SkillRegistryService({ cwd, agentDir, projectTrusted: false }).getSnapshot();
		const component = new SkillRegistrySelectorComponent({ snapshot, onAction: () => {}, onCancel: () => {} });
		const output = component.render(180).join("\n");
		expect(output).toContain("project_untrusted");
		expect(output).toContain("ignored until the project is trusted");
		expect(output).not.toContain("project · enabled");
	});

	it("renders full source, managed, pin, update, and open details", () => {
		const skillDir = join(agentDir, "skills", "review");
		createSkill(skillDir, "review");
		writeSkillRegistry({
			scope: "user",
			cwd,
			agentDir,
			registry: {
				version: SKILL_REGISTRY_VERSION,
				entries: [
					{
						id: "review-entry",
						name: "review",
						source: {
							type: "npm",
							package: "@team/skills",
							version: "1.2.3",
							subdirectory: "review",
						},
						scope: "user",
						path: "skills/review",
						enabled: true,
						pinnedRef: "sha-ref",
						sha256: "a".repeat(64),
						importedAt: 100,
						updatedAt: 200,
						diagnostics: [],
					},
				],
			},
		});
		const snapshot = new SkillRegistryService({ cwd, agentDir, projectTrusted: true }).getSnapshot();
		const component = new SkillRegistrySelectorComponent({
			snapshot,
			onAction: () => {},
			onCancel: () => {},
			formatPath: (path) => path.replace(tempDir, "$TEMP"),
		});
		component.handleInput("\n");
		const output = component
			.render(180)
			.join("\n")
			.replace(/\u001b\[[0-9;]*m/g, "");
		expect(output).toContain("package:");
		expect(output).toContain("@team/skills");
		expect(output).toContain("Managed path:");
		expect(output).toContain("sha-ref");
		expect(output).toContain("Update");
		expect(output).toContain("Open SKILL.md");
	});

	it("dispatches the open SKILL.md action without changing the selected record", async () => {
		const sourceDir = join(tempDir, "source", "open");
		createSkill(sourceDir, "open");
		const service = new SkillRegistryService({ cwd, agentDir, projectTrusted: true, createId: () => "open-entry" });
		await service.importLocal(sourceDir);
		const snapshot = service.getSnapshot();
		const actions: string[] = [];
		const component = new SkillRegistrySelectorComponent({
			snapshot,
			onAction: (_record, action) => {
				actions.push(action);
			},
			onCancel: () => {},
		});
		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		expect(actions).toEqual([]);
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		expect(actions).toEqual(["open"]);
		expect(service.getSnapshot().records[0]?.entry.enabled).toBe(true);
	});

	it("searches name, source, scope, path, and diagnostics", async () => {
		const sourceDir = join(tempDir, "source", "searchable");
		createSkill(sourceDir, "searchable");
		const service = new SkillRegistryService({ cwd, agentDir, projectTrusted: true, createId: () => "search-entry" });
		await service.importLocal(sourceDir);
		writeFileSync(
			join(agentDir, "skills", "searchable", "SKILL.md"),
			"---\nname: searchable\ndescription: [bad\n---\n",
		);
		service.validate("searchable");
		expect(service.list("searchable").map((record) => record.entry.name)).toEqual(["searchable"]);
		expect(service.list("local:").map((record) => record.entry.name)).toEqual(["searchable"]);
		expect(service.list("user").map((record) => record.entry.name)).toEqual(["searchable"]);
		expect(service.list("skills/searchable").map((record) => record.entry.name)).toEqual(["searchable"]);
		expect(service.list("frontmatter_invalid").map((record) => record.entry.name)).toEqual(["searchable"]);

		createSkill(join(agentDir, "skills", "remote-search"), "remote-search");
		const registry = service.getSnapshot().user.registry;
		writeSkillRegistry({
			scope: "user",
			cwd,
			agentDir,
			registry: {
				...registry,
				entries: [
					...registry.entries,
					{
						id: "remote-search-entry",
						name: "remote-search",
						source: { type: "npm", package: "@team/search-skills", version: "2.0.0" },
						scope: "user",
						path: "skills/remote-search",
						enabled: true,
						importedAt: 100,
						diagnostics: [],
					},
				],
			},
		});
		const snapshot = service.getSnapshot();
		const component = new SkillRegistrySelectorComponent({
			snapshot,
			initialSearch: "@team/search-skills",
			onAction: () => {},
			onCancel: () => {},
		});
		const output = component.render(180).join("\n");
		expect(component.getSearchQuery()).toBe("@team/search-skills");
		expect(output).toContain("remote-search");
		expect(output).not.toContain("✓ searchable");
	});

	it("shows both Registry sources for a same-name collision", () => {
		createSkill(join(agentDir, "skills", "first"), "same-name");
		createSkill(join(agentDir, "skills", "second"), "same-name");
		writeSkillRegistry({
			scope: "user",
			cwd,
			agentDir,
			registry: {
				version: SKILL_REGISTRY_VERSION,
				entries: [
					{
						id: "first-entry",
						name: "same-name",
						source: { type: "local", path: join(tempDir, "first-source") },
						scope: "user",
						path: "skills/first",
						enabled: true,
						importedAt: 1,
						diagnostics: [],
					},
					{
						id: "second-entry",
						name: "same-name",
						source: { type: "git", repository: "https://example.com/second", ref: "v2" },
						scope: "user",
						path: "skills/second",
						enabled: true,
						importedAt: 2,
						diagnostics: [],
					},
				],
			},
		});
		const snapshot = new SkillRegistryService({ cwd, agentDir, projectTrusted: true }).getSnapshot();
		const component = new SkillRegistrySelectorComponent({ snapshot, onAction: () => {}, onCancel: () => {} });
		const listOutput = component.render(180).join("\n");
		expect(listOutput.match(/same-name/g)?.length).toBeGreaterThanOrEqual(2);
		component.handleInput("\n");
		const detailsOutput = component.render(180).join("\n");
		expect(detailsOutput).toContain("collision sides");
		expect(detailsOutput).toContain("https://example.com/second");
		expect(detailsOutput).toContain("first-source");
	});

	it("dispatches an action from the selected skill details", async () => {
		const sourceDir = join(tempDir, "source", "review");
		createSkill(sourceDir, "review");
		const service = new SkillRegistryService({ cwd, agentDir, projectTrusted: true, createId: () => "entry" });
		await service.importLocal(sourceDir);
		const snapshot = service.getSnapshot();
		const actions: string[] = [];
		const component = new SkillRegistrySelectorComponent({
			snapshot,
			records: snapshot.records,
			formatPath: (path) => path,
			onAction: (_record, action) => {
				actions.push(action);
			},
			onCancel: () => {},
		});

		component.handleInput("\n");
		component.handleInput("\n");
		expect(actions).toEqual(["disable"]);
	});

	it("offers and dispatches update for remote Skill sources", () => {
		createSkill(join(agentDir, "skills", "remote"), "remote");
		writeSkillRegistry({
			scope: "user",
			cwd,
			agentDir,
			registry: {
				version: SKILL_REGISTRY_VERSION,
				entries: [
					{
						id: "remote-entry",
						name: "remote",
						source: { type: "git", repository: "https://example.com/team/skills", ref: "main" },
						scope: "user",
						path: "skills/remote",
						enabled: true,
						pinnedRef: "abc123",
						importedAt: 100,
						updatedAt: 100,
						diagnostics: [],
					},
				],
			},
		});
		const service = new SkillRegistryService({ cwd, agentDir, projectTrusted: true });
		const snapshot = service.getSnapshot();
		const actions: string[] = [];
		const component = new SkillRegistrySelectorComponent({
			snapshot,
			onAction: (_record, action) => {
				actions.push(action);
			},
			onCancel: () => {},
		});
		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		expect(actions).toEqual(["update"]);
	});

	it("uses the current ResourceLoader projection as its source of list records", async () => {
		const sourceDir = join(tempDir, "source", "review");
		createSkill(sourceDir, "review");
		const service = new SkillRegistryService({ cwd, agentDir, projectTrusted: true, createId: () => "entry" });
		await service.importLocal(sourceDir);
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();
		const snapshot = service.getSnapshot();
		const component = new SkillRegistrySelectorComponent({
			snapshot,
			records: snapshot.records,
			formatPath: (path) => path,
			onAction: () => {},
			onCancel: () => {},
		});
		expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["review"]);
		expect(component.render(140).join("\n")).toContain("review");
	});
});
