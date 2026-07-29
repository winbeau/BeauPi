import { describe, expect, it } from "vitest";
import { parseSkillRegistryCommand } from "../src/core/skill-registry-commands.ts";

describe("skill registry command parsing", () => {
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

	it("defaults imports to user scope and rejects remote sources", () => {
		expect(parseSkillRegistryCommand("/skill-import ~/.claude/skills/review")).toEqual({
			type: "import",
			source: "~/.claude/skills/review",
			scope: "user",
		});
		expect(parseSkillRegistryCommand("/skill-import https://example.com/SKILL.md")).toEqual({
			type: "error",
			message: "Stage 2a only supports existing local or Claude/Codex directories",
		});
		expect(parseSkillRegistryCommand("/skill-import ssh://example.com/skills/review")).toEqual({
			type: "error",
			message: "Stage 2a only supports existing local or Claude/Codex directories",
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
		expect(parseSkillRegistryCommand("/skill:review-pr")).toBeUndefined();
		expect(parseSkillRegistryCommand("/model")).toBeUndefined();
	});
});
