import { describe, expect, it } from "vitest";
import { parseSkillRegistryCommand } from "../src/core/skill-registry-commands.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("skill registry command parsing", () => {
	it("registers every management command as a built-in slash command", () => {
		const names = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		expect([...names]).toEqual(
			expect.arrayContaining([
				"skills",
				"skill-import",
				"skill-enable",
				"skill-disable",
				"skill-validate",
				"skill-remove",
				"skill-update",
			]),
		);
	});

	it("parses list search and scoped mutation commands", () => {
		expect(parseSkillRegistryCommand("/skills")).toEqual({ type: "list" });
		expect(parseSkillRegistryCommand("/skills collision warning")).toEqual({
			type: "list",
			search: "collision warning",
		});
		expect(parseSkillRegistryCommand("/skill-enable review-pr")).toEqual({
			type: "enable",
			name: "review-pr",
		});
		expect(parseSkillRegistryCommand("/skill-disable review-pr")).toEqual({
			type: "disable",
			name: "review-pr",
		});
		expect(parseSkillRegistryCommand("/skill-validate")).toEqual({ type: "validate" });
		expect(parseSkillRegistryCommand("/skill-validate review-pr")).toEqual({
			type: "validate",
			name: "review-pr",
		});
		expect(parseSkillRegistryCommand("/skill-update review-pr")).toEqual({
			type: "update",
			name: "review-pr",
		});
		expect(parseSkillRegistryCommand("/skill-remove review-pr")).toEqual({
			type: "remove",
			name: "review-pr",
		});
		expect(parseSkillRegistryCommand("/skill-import '/tmp/review skill' project")).toEqual({
			type: "import",
			source: "/tmp/review skill",
			scope: "project",
		});
		expect(parseSkillRegistryCommand(String.raw`/skill-import C:\Users\me\skills\review`)).toEqual({
			type: "import",
			source: String.raw`C:\Users\me\skills\review`,
			scope: "user",
		});
	});

	it("defaults imports to user scope and accepts documented remote source forms", () => {
		expect(parseSkillRegistryCommand("/skill-import ~/.claude/skills/review")).toEqual({
			type: "import",
			source: "~/.claude/skills/review",
			scope: "user",
		});
		expect(parseSkillRegistryCommand("/skill-import git:github.com/user/repo@v1#skills/review project")).toEqual({
			type: "import",
			source: "git:github.com/user/repo@v1#skills/review",
			scope: "project",
		});
		expect(parseSkillRegistryCommand("/skill-import npm:@team/beaupi-skills@1.2.0#review")).toEqual({
			type: "import",
			source: "npm:@team/beaupi-skills@1.2.0#review",
			scope: "user",
		});
		expect(parseSkillRegistryCommand("/skill-import https://example.com/SKILL.md")).toEqual({
			type: "import",
			source: "https://example.com/SKILL.md",
			scope: "user",
		});
	});

	it("reports command usage errors without claiming unrelated slash commands", () => {
		expect(parseSkillRegistryCommand("/skill-enable")).toEqual({
			type: "error",
			message: "Usage: /skill-enable <name>",
		});
		expect(parseSkillRegistryCommand("/skill-validate one two")).toEqual({
			type: "error",
			message: "Usage: /skill-validate [name]",
		});
		expect(parseSkillRegistryCommand("/skill-import ./review nope")).toEqual({
			type: "error",
			message: "Skill import scope must be user or project",
		});
		expect(parseSkillRegistryCommand("/skill-update")).toEqual({
			type: "error",
			message: "Usage: /skill-update <name>",
		});
		expect(parseSkillRegistryCommand("/skill:review-pr")).toBeUndefined();
		expect(parseSkillRegistryCommand("/model")).toBeUndefined();
	});
});
