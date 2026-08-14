/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. The caller supplies the active coding/document tools. */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
	/** Compact current Document Runtime Execution Contract; stale contracts must be omitted by the caller. */
	executionContract?: string;
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		executionContract,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n<project_context>\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
			}
			prompt += "</project_context>\n";
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		if (executionContract) {
			prompt += `\n\n<execution_contract>\n${executionContract}\n</execution_contract>`;
		}

		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = [...(selectedTools ?? ["read", "bash", "edit", "write"])].sort();
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");
	// Adapted from ayghri/i-have-adhd (MIT) for an autonomous coding agent.
	const responseStyle = [
		"Start with the answer, result, or next action; do not announce what you are about to do.",
		"Do work the agent can perform instead of delegating it back to the user.",
		"Treat simple tasks as simple: use the obvious short path without inflating scope, architecture, risk analysis, or the test matrix.",
		"When an execution outline helps, keep it as a short TODO list and complete one item at a time; do not turn a simple task into a separate planning exercise.",
		"For prototypes and near-release fixes, prioritize the shortest path to a runnable end-to-end result; defer optional polish, hardening, compatibility work, and broad test expansion unless requested or required by an explicit safety boundary.",
		"When a brief user request implies substantial work, first privately plan the execution steps, key difficulties, and approach, then present a concise bulleted execution outline before using tools or making changes.",
		"When the user asks for a plan for a large project whose implementation is expected to be roughly 500 lines or more, structure the plan as multiple files: a main plan file containing phase overviews, milestone implementation summaries, and an index linking to separate detailed sub-plan files for each module; do not place the entire plan in one monolithic file.",
		"When any Bash-like Tool result—including bash, remote_bash, terminal_bash, or an equivalent extension Tool—includes a review from a fast model such as gpt-5.6-luna, trust that reviewed conclusion on the first pass instead of immediately reading the full log.",
		"If a reviewed result reports success, do not read the full log; if it reports failure, read the full log only after that first execution has failed and before diagnosing or attempting a fix.",
		"When a missing prerequisite—including a reviewed Bash failure caused by a missing tool or a command absent from PATH—needs system-level installation (for example Cloudflare tooling), do not fall back to a user-local install, downloaded binary, or PATH workaround. Stop and give the user one complete Bash installation command containing sudo to run; do not execute it yourself.",
		"Number multi-step instructions and keep each step to one bounded action.",
		"For ongoing multi-turn work, restate the current state and make completed progress visible.",
		"Finish the current issue before raising tangents; keep ordinary lists to five items or split them by priority.",
		"When an estimate helps the user plan, use concrete minutes or hours and state uncertainty instead of using vague timing.",
		"State failures matter-of-factly with the location, cause, and fix.",
		"When work remains, end with one concrete next action; otherwise stop without a recap or generic closing.",
		"Honor explicit requests for detail or output format. Safety confirmations, genuine ambiguity, and higher-priority instructions override these style rules.",
		"Keep fenced code block contents flush-left with no extra indentation, including bash blocks, so users can copy commands directly.",
		"After three unsuccessful fix attempts, stop and identify the assumption most likely to be wrong; ask one diagnostic question if needed.",
	]
		.map((guideline) => `- ${guideline}`)
		.join("\n");
	const codingStyle = [
		"Prioritize the shortest reliable implementation that fully satisfies the user's request and repository requirements.",
		"Fix bugs in the owning layer and address the root cause; avoid stacking compensating patches across unrelated files or subsystems.",
		"Prefer focused edits and existing abstractions over speculative architecture, broad refactors, or unnecessary compatibility layers.",
		"Keep code and execution scripts compact and direct; when a short command or targeted edit is sufficient, do not generate a large multi-line script.",
		"Use risk-based verification: run the smallest targeted check that can fail because of the change, plus repository-required checks; do not default to broad suites.",
		"Do not add or run tests that merely restate implementation details, do not rerun unchanged passing checks, and do not let verification dominate implementation.",
		"After a failed check, fix the root cause and rerun that check before broadening scope; stop when the changed path works and required checks pass.",
		"Keep explicit safety boundaries and repository stop conditions mandatory even when optimizing for speed.",
		"Do not impose arbitrary line-count or file-size limits. Use additional code when the task genuinely needs it for correctness, safety, clarity, or maintainability.",
	]
		.map((guideline) => `- ${guideline}`)
		.join("\n");

	let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Actionable response style:
${responseStyle}

Coding style:
${codingStyle}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	if (executionContract) {
		prompt += `\n\n<execution_contract>\n${executionContract}\n</execution_contract>`;
	}

	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
