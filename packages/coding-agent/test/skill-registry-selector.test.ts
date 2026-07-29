import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
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
