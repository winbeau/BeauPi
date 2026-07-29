import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type {
	DocumentRuntimeToolDetails,
	DocumentSearchScope,
	DocumentSource,
	ExecutionContract,
} from "../documents/index.ts";
import {
	attachDocumentRuntimeToolDetails,
	type DocumentRuntime,
	getDocumentRuntimeToolDetails,
	writeDocumentToolOutput,
} from "../documents/index.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { truncateHead } from "./truncate.ts";

const documentSourceSchema = Type.Union([
	Type.Literal("global"),
	Type.Literal("ancestor"),
	Type.Literal("project"),
	Type.Literal("nearby"),
	Type.Literal("explicit"),
	Type.Literal("package"),
]);

const scopeSchema = Type.Optional(
	Type.Object({
		sources: Type.Optional(Type.Array(documentSourceSchema)),
		documentIds: Type.Optional(Type.Array(Type.String())),
		paths: Type.Optional(Type.Array(Type.String())),
	}),
);

const docsSearchSchema = Type.Object({
	query: Type.String({ description: "Task or document search query" }),
	scope: scopeSchema,
	limit: Type.Optional(Type.Number({ description: "Maximum number of matching headings/documents" })),
});

const docsReadSchema = Type.Object({
	document: Type.String({ description: "Local Markdown document path or stable document id" }),
	heading: Type.Optional(Type.String({ description: "Full heading path or heading title" })),
	startLine: Type.Optional(Type.Number({ description: "1-based first line to read" })),
	endLine: Type.Optional(Type.Number({ description: "1-based last line to read" })),
	offset: Type.Optional(Type.Number({ description: "1-based line offset" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines" })),
});

const docsResolveTaskSchema = Type.Object({
	task: Type.String({ description: "Current task text" }),
	explicitDocuments: Type.Optional(Type.Array(Type.String({ description: "Local Markdown path or unsupported URL" }))),
	refresh: Type.Optional(Type.Boolean({ description: "Re-discover and rebuild the contract" })),
});

export type DocsSearchInput = Static<typeof docsSearchSchema>;
export type DocsReadInput = Static<typeof docsReadSchema>;
export type DocsResolveTaskInput = Static<typeof docsResolveTaskSchema>;

export interface DocsSearchToolDetails {
	query: string;
	matches: number;
	indexedDocuments: number;
	indexedBytes: number;
	truncated: boolean;
	diagnostics: DocumentRuntimeToolDetails["diagnostics"];
	documentRuntime: DocumentRuntimeToolDetails;
}

export interface DocsReadToolDetails {
	path: string;
	hash: string;
	heading?: string[];
	startLine: number;
	endLine: number;
	fullOutputPath?: string;
	truncation?: ReturnType<typeof truncateHead>;
	documentRuntime: DocumentRuntimeToolDetails;
}

export interface DocsResolveTaskToolDetails {
	contract: ExecutionContract;
	indexedDocuments: number;
	indexedBytes: number;
	truncated: boolean;
	diagnostics: DocumentRuntimeToolDetails["diagnostics"];
	documentRuntime: DocumentRuntimeToolDetails;
}

function textOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

function firstLine(value: string): string {
	return value.replace(/[\r\n]+/g, " ").trim();
}

function isUrl(value: string): boolean {
	return /^[a-z][a-z\d+.-]*:\/\//i.test(value);
}

function formatCitation(citation: {
	displayPath: string;
	startLine: number;
	endLine: number;
	headingPath?: string[];
}): string {
	const heading = citation.headingPath && citation.headingPath.length > 0 ? `#${citation.headingPath.join("/")}` : "";
	const range =
		citation.startLine === citation.endLine
			? String(citation.startLine)
			: `${citation.startLine}-${citation.endLine}`;
	return `${citation.displayPath}:${range}${heading}`;
}

function formatSearchCall(args: DocsSearchInput | undefined, theme: Theme): string {
	const query = firstLine(args?.query ?? "");
	return `${theme.fg("toolTitle", theme.bold("Docs Search"))}(${theme.fg("accent", query || "…")})`;
}

function formatSearchResult(
	result: { content: Array<{ type: string; text?: string }>; details?: DocsSearchToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
): string {
	const details = result.details;
	if (!details) return theme.fg("error", textOutput(result));
	if (!options.expanded) {
		const suffix = details.truncated ? " · budget truncated" : "";
		return theme.fg("muted", `${details.matches} document match${details.matches === 1 ? "" : "es"}${suffix}`);
	}
	return textOutput(result)
		.split("\n")
		.map((line) => theme.fg("toolOutput", line))
		.join("\n");
}

function formatReadCall(args: DocsReadInput | undefined, theme: Theme): string {
	const document = firstLine(args?.document ?? "");
	const heading = args?.heading ? `#${firstLine(args.heading)}` : "";
	const range =
		args?.startLine !== undefined ? `:${args.startLine}${args.endLine !== undefined ? `-${args.endLine}` : ""}` : "";
	return `${theme.fg("toolTitle", theme.bold("Docs Read"))}(${theme.fg("accent", `${document}${heading}${range}`)})`;
}

function formatReadResult(
	result: { content: Array<{ type: string; text?: string }>; details?: DocsReadToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
): string {
	const details = result.details;
	if (!details) return theme.fg("error", textOutput(result));
	const output = textOutput(result);
	if (!options.expanded) {
		return theme.fg("muted", `${details.path}:${details.startLine}-${details.endLine}`);
	}
	return output
		.split("\n")
		.map((line) => theme.fg("toolOutput", line))
		.join("\n");
}

function formatResolveCall(args: DocsResolveTaskInput | undefined, theme: Theme): string {
	return `${theme.fg("toolTitle", theme.bold("Docs Resolve"))}(${theme.fg("accent", firstLine(args?.task ?? "") || "…")})`;
}

function formatResolveResult(
	result: { content: Array<{ type: string; text?: string }>; details?: DocsResolveTaskToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
): string {
	const details = result.details;
	if (!details) return theme.fg("error", textOutput(result));
	if (!options.expanded) {
		const status = details.contract.status === "active" ? "active" : "stale";
		return theme.fg(
			"muted",
			`${status} · ${details.contract.documents.length} docs · ${details.contract.requirements.length} requirements · ${details.contract.requiredChecks.length} checks`,
		);
	}
	return textOutput(result)
		.split("\n")
		.map((line) => theme.fg("toolOutput", line))
		.join("\n");
}

function requireDocumentRuntime(runtime: DocumentRuntime | undefined): DocumentRuntime {
	if (!runtime) throw new Error("Document Runtime is unavailable for this tool instance");
	return runtime;
}

function createRuntimeDetails(
	kind: DocumentRuntimeToolDetails["kind"],
	citations: DocumentRuntimeToolDetails["citations"],
	diagnostics: DocumentRuntimeToolDetails["diagnostics"],
	extra: Partial<DocumentRuntimeToolDetails> = {},
): DocumentRuntimeToolDetails {
	return {
		version: 1,
		kind,
		citations,
		diagnostics,
		...extra,
	};
}

export function createDocsSearchToolDefinition(
	runtime?: DocumentRuntime,
): ToolDefinition<typeof docsSearchSchema, DocsSearchToolDetails> {
	return {
		name: "docs_search",
		label: "docs_search",
		description: "Search relevant local project documents and headings without injecting full document contents.",
		promptSnippet: "Search relevant local project documents",
		promptGuidelines: [
			"Use docs_search or docs_resolve_task to locate local document requirements before broad reading.",
		],
		parameters: docsSearchSchema,
		execute: async (_toolCallId, params) => {
			const activeRuntime = requireDocumentRuntime(runtime);
			const scope = params.scope as DocumentSearchScope | undefined;
			const result = await activeRuntime.search(params.query, scope);
			const limit = params.limit === undefined ? result.matches.length : Math.max(0, Math.floor(params.limit));
			const matches = result.matches.slice(0, limit);
			const content = matches.length
				? matches
						.map(
							(match) =>
								`${match.score.toFixed(1)} ${formatCitation(match.citation)}\n  ${firstLine(match.snippet)}`,
						)
						.join("\n")
				: "No matching documents found.";
			const citations = matches.map((match) => match.citation);
			const documentRuntime = createRuntimeDetails("search", citations, result.diagnostics, {
				truncated: result.truncated || limit < result.matches.length,
			});
			return {
				content: [{ type: "text", text: content }],
				details: {
					query: params.query,
					matches: matches.length,
					indexedDocuments: result.indexedDocuments,
					indexedBytes: result.indexedBytes,
					truncated: documentRuntime.truncated ?? false,
					diagnostics: result.diagnostics,
					documentRuntime,
				},
			};
		},
		renderCall(args, theme) {
			return new Text(formatSearchCall(args, theme), 0, 0);
		},
		renderResult(result, options, theme) {
			return new Text(
				formatSearchResult(
					result as { content: Array<{ type: string; text?: string }>; details?: DocsSearchToolDetails },
					options,
					theme,
				),
				0,
				0,
			);
		},
	};
}

export function createDocsReadToolDefinition(
	runtime?: DocumentRuntime,
): ToolDefinition<typeof docsReadSchema, DocsReadToolDetails> {
	return {
		name: "docs_read",
		label: "docs_read",
		description:
			"Read a local Markdown document by stable id/path, heading, or 1-based line range with structured citation details.",
		promptSnippet: "Read a local document by heading or line range",
		parameters: docsReadSchema,
		execute: async (_toolCallId, params) => {
			const activeRuntime = requireDocumentRuntime(runtime);
			if (isUrl(params.document)) {
				const discovered = await activeRuntime.discover([params.document]);
				const documentRuntime = createRuntimeDetails("read", [], discovered.diagnostics);
				return {
					content: [
						{ type: "text", text: discovered.diagnostics.map((diagnostic) => diagnostic.message).join("\n") },
					],
					details: {
						path: params.document,
						hash: "",
						startLine: 0,
						endLine: 0,
						documentRuntime,
					},
				};
			}
			const result = await activeRuntime.read(params);
			const truncation = truncateHead(result.content);
			let output = truncation.content;
			let fullOutputPath: string | undefined;
			if (truncation.truncated) {
				const persisted = await writeDocumentToolOutput(result.content);
				fullOutputPath = persisted.path;
				output += `\n\n[Document output truncated. Full output: ${fullOutputPath}]`;
			}
			const documentRuntime = createRuntimeDetails("read", [result.citation], result.diagnostics, {
				filesRead: [result.document.path],
				truncated: truncation.truncated,
				fullOutputPath,
				truncation: truncation.truncated ? truncation : undefined,
			});
			return {
				content: [{ type: "text", text: output }],
				details: {
					path: result.document.path,
					hash: result.document.hash,
					heading: result.citation.headingPath,
					startLine: result.citation.startLine,
					endLine: result.citation.endLine,
					fullOutputPath,
					truncation: truncation.truncated ? truncation : undefined,
					documentRuntime,
				},
			};
		},
		renderCall(args, theme) {
			return new Text(formatReadCall(args, theme), 0, 0);
		},
		renderResult(result, options, theme) {
			return new Text(
				formatReadResult(
					result as { content: Array<{ type: string; text?: string }>; details?: DocsReadToolDetails },
					options,
					theme,
				),
				0,
				0,
			);
		},
	};
}

export function createDocsResolveTaskToolDefinition(
	runtime?: DocumentRuntime,
): ToolDefinition<typeof docsResolveTaskSchema, DocsResolveTaskToolDetails> {
	return {
		name: "docs_resolve_task",
		label: "docs_resolve_task",
		description:
			"Discover local task documents and resolve conservative requirements, commands, checks, stop conditions, and completion criteria into an Execution Contract.",
		promptSnippet: "Resolve local documents into an execution contract",
		promptGuidelines: [
			"Treat unresolved or conflicting document facts as pending/blocked; do not infer completion from log text.",
		],
		parameters: docsResolveTaskSchema,
		execute: async (_toolCallId, params) => {
			const activeRuntime = requireDocumentRuntime(runtime);
			const result = await activeRuntime.resolveTask({
				task: params.task,
				explicitPaths: params.explicitDocuments,
				refresh: params.refresh,
			});
			const contractCitations = result.contract.documents.flatMap((document) =>
				result.contract.requirements.flatMap((requirement) =>
					requirement.citations.filter((citation) => citation.documentId === document.id),
				),
			);
			const citations =
				contractCitations.length > 0
					? contractCitations
					: result.contract.documents.map((document) => ({
							id: `${document.id}:document`,
							documentId: document.id,
							path: document.path,
							displayPath: document.displayPath,
							startLine: 1,
							endLine: 1,
							documentHash: document.hash,
						}));
			const documentRuntime = createRuntimeDetails("resolve_task", citations, result.diagnostics, {
				contract: result.contract,
			});
			const content = [
				`Execution Contract ${result.contract.id}`,
				`Documents: ${result.contract.documents.length} · Requirements: ${result.contract.requirements.length} · Checks: ${result.contract.requiredChecks.length} · Completion: ${result.contract.completionCriteria.length}`,
				`Status: ${result.contract.status}`,
				...result.contract.requirements
					.slice(0, 8)
					.map((item) => `- ${item.text} [${item.citations.map(formatCitation).join(", ")}]`),
				...result.diagnostics
					.filter((diagnostic) => diagnostic.code === "conflict" || diagnostic.code === "unsupported_url")
					.map((diagnostic) => `Diagnostic: ${diagnostic.message}`),
			];
			return {
				content: [{ type: "text", text: content.join("\n") }],
				details: {
					contract: result.contract,
					indexedDocuments: result.indexedDocuments,
					indexedBytes: result.indexedBytes,
					truncated: result.truncated,
					diagnostics: result.diagnostics,
					documentRuntime,
				},
			};
		},
		renderCall(args, theme) {
			return new Text(formatResolveCall(args, theme), 0, 0);
		},
		renderResult(result, options, theme) {
			return new Text(
				formatResolveResult(
					result as { content: Array<{ type: string; text?: string }>; details?: DocsResolveTaskToolDetails },
					options,
					theme,
				),
				0,
				0,
			);
		},
	};
}

export function createDocumentTools(runtime: DocumentRuntime): AgentTool[] {
	return [
		wrapToolDefinition(createDocsSearchToolDefinition(runtime)),
		wrapToolDefinition(createDocsReadToolDefinition(runtime)),
		wrapToolDefinition(createDocsResolveTaskToolDefinition(runtime)),
	];
}

export { attachDocumentRuntimeToolDetails, getDocumentRuntimeToolDetails };
export type { DocumentSource };
