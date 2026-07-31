export {
	ASK_USER_QUESTION_PARAMETERS,
	ASK_USER_QUESTION_TOOL_NAME,
	type AskUserQuestionInput,
	createAskUserQuestionToolDefinition,
	type PendingQuestionInteraction,
	QUESTION_ANSWER_SCHEMA,
	QUESTION_LIMITS,
	QUESTION_OPTION_SCHEMA,
	QUESTION_RESULT_SCHEMA,
	QUESTION_RESULT_VERSION,
	QUESTION_SCHEMA,
	type QuestionAnswer,
	type QuestionInteractionHandler,
	type QuestionInteractionRequest,
	type QuestionInteractionResponse,
	type QuestionOption,
	type QuestionResult,
	QuestionRuntime,
	type QuestionRuntimeOptions,
	type UserQuestion,
	validateQuestionAnswers,
} from "../question.ts";
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	BashToolExecutionError,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createDocsReadToolDefinition,
	createDocsResolveTaskToolDefinition,
	createDocsSearchToolDefinition,
	createDocumentTools,
	type DocsReadInput,
	type DocsReadToolDetails,
	type DocsResolveTaskInput,
	type DocsResolveTaskToolDetails,
	type DocsSearchInput,
	type DocsSearchToolDetails,
} from "./documents.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolDetails,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DocumentRuntime } from "../documents/document-runtime.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { createAskUserQuestionToolDefinition, type QuestionRuntime } from "../question.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import {
	createDocsReadToolDefinition,
	createDocsResolveTaskToolDefinition,
	createDocsSearchToolDefinition,
} from "./documents.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "grep"
	| "find"
	| "ls"
	| "docs_search"
	| "docs_read"
	| "docs_resolve_task"
	| "ask_user_question";
export const allToolNames: Set<string> = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"docs_search",
	"docs_read",
	"docs_resolve_task",
	"ask_user_question",
	"web_search",
	"web_fetch",
	"background_start",
	"background_attach",
	"background_status",
	"background_logs",
	"background_wait",
	"background_cancel",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	documentRuntime?: DocumentRuntime;
	questionRuntime?: QuestionRuntime;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "docs_search":
			return createDocsSearchToolDefinition(options?.documentRuntime);
		case "docs_read":
			return createDocsReadToolDefinition(options?.documentRuntime);
		case "docs_resolve_task":
			return createDocsResolveTaskToolDefinition(options?.documentRuntime);
		case "ask_user_question":
			return createAskUserQuestionToolDefinition(options?.questionRuntime);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "docs_search":
		case "docs_read":
		case "docs_resolve_task":
		case "ask_user_question":
			return wrapToolDefinition(createToolDefinition(toolName, cwd, options));
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
		createDocsSearchToolDefinition(options?.documentRuntime),
		createDocsReadToolDefinition(options?.documentRuntime),
		createDocsResolveTaskToolDefinition(options?.documentRuntime),
		createAskUserQuestionToolDefinition(options?.questionRuntime),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
		createDocsSearchToolDefinition(options?.documentRuntime),
		createDocsReadToolDefinition(options?.documentRuntime),
		createDocsResolveTaskToolDefinition(options?.documentRuntime),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
		docs_search: createDocsSearchToolDefinition(options?.documentRuntime),
		docs_read: createDocsReadToolDefinition(options?.documentRuntime),
		docs_resolve_task: createDocsResolveTaskToolDefinition(options?.documentRuntime),
		ask_user_question: createAskUserQuestionToolDefinition(options?.questionRuntime),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
		wrapToolDefinition(createAskUserQuestionToolDefinition(options?.questionRuntime)),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
		docs_search: wrapToolDefinition(createDocsSearchToolDefinition(options?.documentRuntime)),
		docs_read: wrapToolDefinition(createDocsReadToolDefinition(options?.documentRuntime)),
		docs_resolve_task: wrapToolDefinition(createDocsResolveTaskToolDefinition(options?.documentRuntime)),
		ask_user_question: wrapToolDefinition(createAskUserQuestionToolDefinition(options?.questionRuntime)),
	};
}
