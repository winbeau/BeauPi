import { describe, expect, it } from "vitest";
import { classifyUserPrompt, isExecutableDynamicTaskPrompt } from "../src/core/tasks/prompt-trigger.ts";

describe("classifyUserPrompt", () => {
	it("classifies executable requests as new_work", () => {
		for (const text of [
			"修复 src/index.ts 的 bug",
			"实现支付功能",
			"发布 npm 新版本",
			"Implement the payment feature",
			"Review this code: src/index.ts",
			"帮我修复 src/index.ts 的 bug 可以吗", // question tail but names a concrete target
		]) {
			expect(classifyUserPrompt(text)).toBe("new_work");
		}
	});

	it("classifies questions and status checks as clarification", () => {
		for (const text of [
			"为什么这样做",
			"进度如何",
			"修复的进度如何",
			"修好了吗",
			"What is this about?",
			"这个方案行不行",
		]) {
			expect(classifyUserPrompt(text)).toBe("clarification");
		}
	});

	it("classifies preferences and background supplements as background", () => {
		for (const text of ["以后请修复时先问我", "请记住不要自动追加 goal", "我偏好简洁的回复", "以后不用每次确认"]) {
			expect(classifyUserPrompt(text)).toBe("background");
		}
	});

	it("classifies commands and plain chat as other", () => {
		for (const text of ["/review src/index.ts", "/skill:foo bar", "好的", "谢谢", ""]) {
			expect(classifyUserPrompt(text)).toBe("other");
		}
	});

	it("keeps isExecutableDynamicTaskPrompt equivalent to the old boolean contract", () => {
		// Existing behavior: action verb and not a targetless question -> executable.
		const cases: Array<[string, boolean]> = [
			["修复 src/index.ts 的 bug", true],
			["Implement the payment feature", true],
			["What is this about?", false],
			["好的", false],
			["/review src/index.ts", false],
			["How should we fix the bug in src/index.ts?", true],
		];
		for (const [text, expected] of cases) {
			expect(isExecutableDynamicTaskPrompt(text)).toBe(expected);
		}
		expect(isExecutableDynamicTaskPrompt("progress check")).toBe(false);
	});
});
