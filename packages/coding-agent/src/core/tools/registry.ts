// Tool Registry: definition-first single source for built-in tool names.
//
// A registry entry maps a tool name to its definition factory and a
// diagnostic manifest (schema, side-effect class, result shape, cancellation,
// timeout metadata). The manifest describes execution facts for composition,
// documentation, diagnostics, and tests — it never authorizes, blocks, or
// replaces tool execution.

import type { DocumentRuntime } from "../documents/document-runtime.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { PlaywrightRuntime as PlaywrightRuntimeType } from "../playwright/index.ts";
import { createPlaywrightToolDefinition, PlaywrightRuntime } from "../playwright/index.ts";
import type { QuestionRuntime } from "../question.ts";
import { createAskUserQuestionToolDefinition } from "../question.ts";
import { type BashToolOptions, createBashToolDefinition } from "./bash.ts";
import {
	createDocsReadToolDefinition,
	createDocsResolveTaskToolDefinition,
	createDocsSearchToolDefinition,
} from "./documents.ts";
import { createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type ToolSource = "core" | "runtime" | "custom" | "extension";

export type ToolSideEffect = "none" | "workspace" | "network" | "process" | "unknown";

export interface ToolManifest {
	name: string;
	source: ToolSource;
	/** Execution side-effect class; a diagnostic fact, not an authorization decision. */
	sideEffect: ToolSideEffect;
	/** Human-readable result details shape, e.g. "BashToolDetails". */
	resultShape: string;
	supportsCancellation: boolean;
	timeoutMetadata?: { parameter: string; unit: "seconds" };
	schema: unknown;
}

export interface ToolRegistryEntry {
	name: string;
	source: ToolSource;
	createDefinition: (cwd: string, options: ToolsRegistryOptions) => ToolDefinition<any, any>;
}

export interface ToolsRegistryOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	documentRuntime?: DocumentRuntime;
	questionRuntime?: QuestionRuntime;
	playwrightRuntime?: PlaywrightRuntimeType;
}

export class ToolRegistryError extends Error {
	readonly code: "duplicate_name" | "missing_constructor" | "name_mismatch";

	constructor(code: "duplicate_name" | "missing_constructor" | "name_mismatch", message: string) {
		super(message);
		this.name = "ToolRegistryError";
		this.code = code;
	}
}

const CORE_MANIFESTS: Record<string, Omit<ToolManifest, "name" | "source" | "schema">> = {
	read: { sideEffect: "none", resultShape: "ReadToolDetails", supportsCancellation: true },
	bash: {
		sideEffect: "process",
		resultShape: "BashToolDetails",
		supportsCancellation: true,
		timeoutMetadata: { parameter: "timeout", unit: "seconds" },
	},
	edit: { sideEffect: "workspace", resultShape: "EditToolDetails", supportsCancellation: false },
	write: { sideEffect: "workspace", resultShape: "WriteToolDetails", supportsCancellation: false },
	grep: { sideEffect: "none", resultShape: "GrepToolDetails", supportsCancellation: true },
	find: { sideEffect: "none", resultShape: "FindToolDetails", supportsCancellation: true },
	ls: { sideEffect: "none", resultShape: "LsToolDetails", supportsCancellation: true },
	docs_search: { sideEffect: "none", resultShape: "unknown", supportsCancellation: false },
	docs_read: { sideEffect: "none", resultShape: "unknown", supportsCancellation: false },
	docs_resolve_task: { sideEffect: "none", resultShape: "unknown", supportsCancellation: false },
	ask_user_question: { sideEffect: "none", resultShape: "QuestionResult", supportsCancellation: false },
	playwright: { sideEffect: "process", resultShape: "PlaywrightToolDetails", supportsCancellation: true },
};

/**
 * Runtime-owned tools: their definitions are created by the runtime hosts
 * (search, background, workflow, monitor, remote, tasks) rather than by the
 * core registry factories.
 */
export const RUNTIME_TOOL_NAMES: readonly string[] = [
	"web_search",
	"web_fetch",
	"background_start",
	"background_attach",
	"background_status",
	"background_logs",
	"background_wait",
	"background_cancel",
	"tasks_update",
	"privileged_exec",
];

export class ToolRegistry {
	private readonly entries = new Map<string, ToolRegistryEntry>();

	register(entry: ToolRegistryEntry): void {
		if (this.entries.has(entry.name)) {
			throw new ToolRegistryError(
				"duplicate_name",
				`Tool name "${entry.name}" is registered twice (${this.entries.get(entry.name)?.source} and ${entry.source})`,
			);
		}
		this.entries.set(entry.name, entry);
	}

	get(name: string): ToolRegistryEntry | undefined {
		return this.entries.get(name);
	}

	has(name: string): boolean {
		return this.entries.has(name);
	}

	names(): string[] {
		return [...this.entries.keys()];
	}

	manifests(): ToolManifest[] {
		return [...this.entries.values()].map((entry) => {
			const core = CORE_MANIFESTS[entry.name];
			const definition = entry.createDefinition("/", {});
			return {
				name: entry.name,
				source: entry.source,
				sideEffect: core?.sideEffect ?? "unknown",
				resultShape: core?.resultShape ?? "unknown",
				supportsCancellation: core?.supportsCancellation ?? false,
				timeoutMetadata: core?.timeoutMetadata,
				schema: definition.parameters,
			};
		});
	}

	/**
	 * Validate registry consistency: every entry has a constructor and the
	 * produced definition name matches the registered name.
	 */
	validate(): string[] {
		const diagnostics: string[] = [];
		for (const entry of this.entries.values()) {
			let definition: ToolDefinition<any, any>;
			try {
				definition = entry.createDefinition("/", {});
			} catch (error) {
				diagnostics.push(
					`Tool "${entry.name}" (${entry.source}): definition factory threw: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}
			if (definition.name !== entry.name) {
				diagnostics.push(
					`Tool "${entry.name}" (${entry.source}): definition name mismatch (factory produced "${definition.name}")`,
				);
			}
		}
		return diagnostics;
	}
}

/** Registry of the core (definition-first) tool factories. */
export function createCoreToolRegistry(): ToolRegistry {
	const registry = new ToolRegistry();
	const core = (name: string, createDefinition: ToolRegistryEntry["createDefinition"]): void => {
		registry.register({ name, source: "core", createDefinition });
	};
	core("read", (cwd, options) => createReadToolDefinition(cwd, options?.read));
	core("bash", (cwd, options) => createBashToolDefinition(cwd, options?.bash));
	core("edit", (cwd, options) => createEditToolDefinition(cwd, options?.edit));
	core("write", (cwd, options) => createWriteToolDefinition(cwd, options?.write));
	core("grep", (cwd, options) => createGrepToolDefinition(cwd, options?.grep));
	core("find", (cwd, options) => createFindToolDefinition(cwd, options?.find));
	core("ls", (cwd, options) => createLsToolDefinition(cwd, options?.ls));
	core("docs_search", (_cwd, options) => createDocsSearchToolDefinition(options?.documentRuntime));
	core("docs_read", (_cwd, options) => createDocsReadToolDefinition(options?.documentRuntime));
	core("docs_resolve_task", (_cwd, options) => createDocsResolveTaskToolDefinition(options?.documentRuntime));
	core("ask_user_question", (_cwd, options) => createAskUserQuestionToolDefinition(options?.questionRuntime));
	core("playwright", (cwd, options) =>
		createPlaywrightToolDefinition(options?.playwrightRuntime ?? new PlaywrightRuntime({ cwd })),
	);
	return registry;
}

/** Core tool names derived from the registry (single source, no second list). */
export function coreToolNames(): string[] {
	return createCoreToolRegistry().names();
}
