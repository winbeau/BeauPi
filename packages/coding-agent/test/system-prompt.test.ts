import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test("instructs models to resolve pi docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
			expect(prompt).toContain("environment variables (docs/environment-variables.md)");
		});
	});

	describe("actionable response style", () => {
		test("includes ADHD-friendly guidance adapted for autonomous coding agents", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Actionable response style:");
			expect(prompt).toContain("- Start with the answer, result, or next action");
			expect(prompt).toContain("- Do work the agent can perform instead of delegating it back to the user.");
			expect(prompt).toContain("Treat simple tasks as simple: use the obvious short path");
			expect(prompt).toContain("keep it as a short TODO list and complete one item at a time");
			expect(prompt).toContain("prioritize the shortest path to a runnable end-to-end result");
			expect(prompt).toContain(
				"When a brief user request implies substantial work, first privately plan the execution steps, key difficulties, and approach",
			);
			expect(prompt).toContain("present a concise bulleted execution outline before using tools or making changes");
			expect(prompt).toContain(
				"When the user asks for a plan for a large project whose implementation is expected to be roughly 500 lines or more",
			);
			expect(prompt).toContain(
				"a main plan file containing phase overviews, milestone implementation summaries, and an index linking to separate detailed sub-plan files for each module",
			);
			expect(prompt).toContain("do not place the entire plan in one monolithic file");
			expect(prompt).toContain(
				"When any Bash-like Tool result—including bash, remote_bash, terminal_bash, privileged_exec/Sudo Bash, or an equivalent extension Tool—includes a review from a fast model such as gpt-5.6-luna",
			);
			expect(prompt).toContain(
				"trust that reviewed conclusion on the first pass instead of immediately reading the full log",
			);
			expect(prompt).toContain(
				"If a reviewed result reports success, do not read the full log; if it reports failure, read the full log only after that first execution has failed and before diagnosing or attempting a fix",
			);
			expect(prompt).toContain("a reviewed Bash failure caused by a missing tool or a command absent from PATH");
			expect(prompt).toContain("do not fall back to a user-local install, downloaded binary, or PATH workaround");
			expect(prompt).toContain(
				"give the user one complete Bash installation command containing sudo to run; do not execute it yourself",
			);
			expect(prompt).toContain("- State failures matter-of-factly with the location, cause, and fix.");
			expect(prompt).toContain("Safety confirmations, genuine ambiguity, and higher-priority instructions override");
		});
	});

	describe("coding style", () => {
		test("prefers compact implementations without arbitrary size limits", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Coding style:");
			expect(prompt).toContain("- Prioritize the shortest reliable implementation");
			expect(prompt).toContain("Fix bugs in the owning layer and address the root cause");
			expect(prompt).toContain("do not generate a large multi-line script");
			expect(prompt).toContain("Use risk-based verification: run the smallest targeted check");
			expect(prompt).toContain("do not rerun unchanged passing checks");
			expect(prompt).toContain("stop when the changed path works and required checks pass");
			expect(prompt).toContain("Keep explicit safety boundaries and repository stop conditions mandatory");
			expect(prompt).toContain("- Do not impose arbitrary line-count or file-size limits.");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});
});
