import { createHash } from "node:crypto";
import type { TruncationResult } from "../tools/truncate.ts";

export const EXECUTION_CONTRACT_VERSION = 1;
export const DOCUMENT_RUNTIME_DETAILS_KEY = "documentRuntime";
export const DOCUMENT_RUNTIME_DETAILS_VERSION = 1;
export const DOCUMENT_CONTRACT_ENTRY_TYPE = "beaupi.document-contract";

export type DocumentSource = "global" | "ancestor" | "project" | "nearby" | "explicit" | "package";
export type DocumentKind = "agents" | "claude" | "readme" | "contributing" | "markdown" | "package-json";

export type DocumentDiagnosticSeverity = "info" | "warning" | "error";

export interface DocumentDiagnostic {
	code:
		| "unsupported_url"
		| "unsupported_type"
		| "outside_scope"
		| "not_found"
		| "unreadable"
		| "file_too_large"
		| "file_budget_exceeded"
		| "byte_budget_exceeded"
		| "invalid_markdown_range"
		| "heading_not_found"
		| "ambiguous_heading"
		| "conflict"
		| "invalid_document_details";
	severity: DocumentDiagnosticSeverity;
	message: string;
	path?: string;
	citations?: DocumentCitation[];
}

export interface DocumentReference {
	id: string;
	path: string;
	displayPath: string;
	kind: DocumentKind;
	source: DocumentSource;
	sources: DocumentSource[];
	directoryDistance: number;
	hash: string;
	size: number;
	mtimeMs?: number;
	critical: boolean;
}

export interface DocumentCitation {
	id: string;
	documentId: string;
	path: string;
	displayPath: string;
	headingPath?: string[];
	startLine: number;
	endLine: number;
	documentHash: string;
}

export interface MarkdownHeading {
	id: string;
	level: number;
	title: string;
	path: string[];
	startLine: number;
	contentStartLine: number;
	endLine: number;
}

export interface MarkdownCodeBlock {
	language?: string;
	startLine: number;
	contentStartLine: number;
	endLine: number;
	lines: string[];
	headingPath?: string[];
}

export interface PackageScript {
	name: string;
	command: string;
	line: number;
}

export interface IndexedDocument {
	reference: DocumentReference;
	content: string;
	lines: string[];
	headings: MarkdownHeading[];
	codeBlocks: MarkdownCodeBlock[];
	packageScripts: PackageScript[];
}

export interface DocumentSearchScope {
	sources?: DocumentSource[];
	documentIds?: string[];
	paths?: string[];
}

export interface DocumentSearchMatch {
	id: string;
	document: DocumentReference;
	citation: DocumentCitation;
	heading?: MarkdownHeading;
	snippet: string;
	score: number;
	reasons: string[];
}

export interface DocumentSearchResult {
	query: string;
	matches: DocumentSearchMatch[];
	diagnostics: DocumentDiagnostic[];
	truncated: boolean;
	indexedDocuments: number;
	indexedBytes: number;
}

export interface DocumentReadResult {
	content: string;
	document: DocumentReference;
	citation: DocumentCitation;
	heading?: MarkdownHeading;
	diagnostics: DocumentDiagnostic[];
}

export interface Requirement {
	id: string;
	text: string;
	level: "required" | "recommended";
	polarity: "positive" | "negative";
	citations: DocumentCitation[];
	requiredCheckIds: string[];
}

export interface DocumentedCommand {
	id: string;
	command: string;
	kind: "allowed" | "recommended";
	scriptName?: string;
	citations: DocumentCitation[];
}

export interface RequiredCheck {
	id: string;
	label: string;
	commands: string[];
	citations: DocumentCitation[];
}

export interface StopCondition {
	id: string;
	text: string;
	citations: DocumentCitation[];
}

export interface CompletionCriterion {
	id: string;
	text: string;
	requiredCheckIds: string[];
	citations: DocumentCitation[];
}

export interface ExecutionContract {
	version: typeof EXECUTION_CONTRACT_VERSION;
	id: string;
	task: string;
	taskSignature: string;
	documents: DocumentReference[];
	requirements: Requirement[];
	allowedCommands: DocumentedCommand[];
	requiredChecks: RequiredCheck[];
	stopConditions: StopCondition[];
	completionCriteria: CompletionCriterion[];
	documentHashes: Record<string, string>;
	createdAt: string;
	updatedAt: string;
	status: "active" | "stale";
	staleReasons: string[];
	diagnostics: DocumentDiagnostic[];
}

export interface DocumentRuntimeBudgets {
	maxFiles: number;
	maxFileBytes: number;
	maxTotalBytes: number;
	maxCachedDocuments: number;
	maxContractDocuments: number;
	maxSearchResults: number;
}

export interface DocumentRuntimeToolDetails {
	version: typeof DOCUMENT_RUNTIME_DETAILS_VERSION;
	kind: "search" | "read" | "resolve_task";
	citations: DocumentCitation[];
	diagnostics: DocumentDiagnostic[];
	filesRead?: string[];
	contract?: ExecutionContract;
	truncated?: boolean;
	fullOutputPath?: string;
	truncation?: TruncationResult;
}

export interface DocumentRuntimeSnapshot {
	contract?: ExecutionContract;
}

export function stableDocumentId(prefix: string, ...parts: string[]): string {
	const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
	return `${prefix}_${digest}`;
}

export function hashDocumentContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isDocumentSource(value: unknown): value is DocumentSource {
	return (
		value === "global" ||
		value === "ancestor" ||
		value === "project" ||
		value === "nearby" ||
		value === "explicit" ||
		value === "package"
	);
}

function isDocumentKind(value: unknown): value is DocumentKind {
	return (
		value === "agents" ||
		value === "claude" ||
		value === "readme" ||
		value === "contributing" ||
		value === "markdown" ||
		value === "package-json"
	);
}

function parseDocumentReference(value: unknown): DocumentReference | undefined {
	const record = asRecord(value);
	if (
		!record ||
		typeof record.id !== "string" ||
		typeof record.path !== "string" ||
		typeof record.displayPath !== "string" ||
		!isDocumentKind(record.kind) ||
		!isDocumentSource(record.source) ||
		!Array.isArray(record.sources) ||
		!record.sources.every(isDocumentSource) ||
		typeof record.directoryDistance !== "number" ||
		!Number.isFinite(record.directoryDistance) ||
		typeof record.hash !== "string" ||
		typeof record.size !== "number" ||
		!Number.isFinite(record.size) ||
		typeof record.critical !== "boolean"
	) {
		return undefined;
	}
	if (record.mtimeMs !== undefined && (typeof record.mtimeMs !== "number" || !Number.isFinite(record.mtimeMs))) {
		return undefined;
	}
	return {
		id: record.id,
		path: record.path,
		displayPath: record.displayPath,
		kind: record.kind,
		source: record.source,
		sources: [...record.sources],
		directoryDistance: record.directoryDistance,
		hash: record.hash,
		size: record.size,
		mtimeMs: record.mtimeMs,
		critical: record.critical,
	};
}

function parseCitation(value: unknown): DocumentCitation | undefined {
	const record = asRecord(value);
	if (
		!record ||
		typeof record.id !== "string" ||
		typeof record.documentId !== "string" ||
		typeof record.path !== "string" ||
		typeof record.displayPath !== "string" ||
		(record.headingPath !== undefined && !isStringArray(record.headingPath)) ||
		typeof record.startLine !== "number" ||
		!Number.isInteger(record.startLine) ||
		record.startLine < 1 ||
		typeof record.endLine !== "number" ||
		!Number.isInteger(record.endLine) ||
		record.endLine < record.startLine ||
		typeof record.documentHash !== "string"
	) {
		return undefined;
	}
	return {
		id: record.id,
		documentId: record.documentId,
		path: record.path,
		displayPath: record.displayPath,
		headingPath: record.headingPath ? [...record.headingPath] : undefined,
		startLine: record.startLine,
		endLine: record.endLine,
		documentHash: record.documentHash,
	};
}

function parseCitations(value: unknown): DocumentCitation[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const citations: DocumentCitation[] = [];
	for (const item of value) {
		const citation = parseCitation(item);
		if (!citation) return undefined;
		citations.push(citation);
	}
	return citations;
}

function parseDiagnostic(value: unknown): DocumentDiagnostic | undefined {
	const record = asRecord(value);
	const validCodes = new Set<DocumentDiagnostic["code"]>([
		"unsupported_url",
		"unsupported_type",
		"outside_scope",
		"not_found",
		"unreadable",
		"file_too_large",
		"file_budget_exceeded",
		"byte_budget_exceeded",
		"invalid_markdown_range",
		"heading_not_found",
		"ambiguous_heading",
		"conflict",
		"invalid_document_details",
	]);
	if (
		!record ||
		typeof record.code !== "string" ||
		!validCodes.has(record.code as DocumentDiagnostic["code"]) ||
		(record.severity !== "info" && record.severity !== "warning" && record.severity !== "error") ||
		typeof record.message !== "string" ||
		(record.path !== undefined && typeof record.path !== "string")
	) {
		return undefined;
	}
	const citations = record.citations === undefined ? undefined : parseCitations(record.citations);
	if (record.citations !== undefined && !citations) return undefined;
	return {
		code: record.code as DocumentDiagnostic["code"],
		severity: record.severity,
		message: record.message,
		path: record.path,
		citations,
	};
}

function parseDiagnostics(value: unknown): DocumentDiagnostic[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const diagnostics: DocumentDiagnostic[] = [];
	for (const item of value) {
		const diagnostic = parseDiagnostic(item);
		if (!diagnostic) return undefined;
		diagnostics.push(diagnostic);
	}
	return diagnostics;
}

function parseRequirement(value: unknown): Requirement | undefined {
	const record = asRecord(value);
	const citations = parseCitations(record?.citations);
	if (
		!record ||
		typeof record.id !== "string" ||
		typeof record.text !== "string" ||
		(record.level !== "required" && record.level !== "recommended") ||
		(record.polarity !== "positive" && record.polarity !== "negative") ||
		!citations ||
		!isStringArray(record.requiredCheckIds)
	) {
		return undefined;
	}
	return { ...record, citations, requiredCheckIds: [...record.requiredCheckIds] } as Requirement;
}

function parseDocumentedCommand(value: unknown): DocumentedCommand | undefined {
	const record = asRecord(value);
	const citations = parseCitations(record?.citations);
	if (
		!record ||
		typeof record.id !== "string" ||
		typeof record.command !== "string" ||
		(record.kind !== "allowed" && record.kind !== "recommended") ||
		(record.scriptName !== undefined && typeof record.scriptName !== "string") ||
		!citations
	) {
		return undefined;
	}
	return {
		id: record.id,
		command: record.command,
		kind: record.kind,
		scriptName: record.scriptName,
		citations,
	};
}

function parseRequiredCheck(value: unknown): RequiredCheck | undefined {
	const record = asRecord(value);
	const citations = parseCitations(record?.citations);
	if (
		!record ||
		typeof record.id !== "string" ||
		typeof record.label !== "string" ||
		!isStringArray(record.commands) ||
		!citations
	) {
		return undefined;
	}
	return { id: record.id, label: record.label, commands: [...record.commands], citations };
}

function parseStopCondition(value: unknown): StopCondition | undefined {
	const record = asRecord(value);
	const citations = parseCitations(record?.citations);
	return record && typeof record.id === "string" && typeof record.text === "string" && citations
		? { id: record.id, text: record.text, citations }
		: undefined;
}

function parseCompletionCriterion(value: unknown): CompletionCriterion | undefined {
	const record = asRecord(value);
	const citations = parseCitations(record?.citations);
	if (
		!record ||
		typeof record.id !== "string" ||
		typeof record.text !== "string" ||
		!isStringArray(record.requiredCheckIds) ||
		!citations
	) {
		return undefined;
	}
	return { id: record.id, text: record.text, requiredCheckIds: [...record.requiredCheckIds], citations };
}

function parseArray<T>(value: unknown, parser: (item: unknown) => T | undefined): T[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const parsed: T[] = [];
	for (const item of value) {
		const result = parser(item);
		if (!result) return undefined;
		parsed.push(result);
	}
	return parsed;
}

export function parseExecutionContract(value: unknown): ExecutionContract | undefined {
	const record = asRecord(value);
	if (!record || record.version !== EXECUTION_CONTRACT_VERSION) return undefined;
	const documents = parseArray(record.documents, parseDocumentReference);
	const requirements = parseArray(record.requirements, parseRequirement);
	const allowedCommands = parseArray(record.allowedCommands, parseDocumentedCommand);
	const requiredChecks = parseArray(record.requiredChecks, parseRequiredCheck);
	const stopConditions = parseArray(record.stopConditions, parseStopCondition);
	const completionCriteria = parseArray(record.completionCriteria, parseCompletionCriterion);
	const diagnostics = parseDiagnostics(record.diagnostics);
	const documentHashesRecord = asRecord(record.documentHashes);
	if (
		typeof record.id !== "string" ||
		typeof record.task !== "string" ||
		typeof record.taskSignature !== "string" ||
		!documents ||
		!requirements ||
		!allowedCommands ||
		!requiredChecks ||
		!stopConditions ||
		!completionCriteria ||
		!documentHashesRecord ||
		!Object.values(documentHashesRecord).every((item) => typeof item === "string") ||
		typeof record.createdAt !== "string" ||
		typeof record.updatedAt !== "string" ||
		(record.status !== "active" && record.status !== "stale") ||
		!isStringArray(record.staleReasons) ||
		!diagnostics
	) {
		return undefined;
	}
	return {
		version: EXECUTION_CONTRACT_VERSION,
		id: record.id,
		task: record.task,
		taskSignature: record.taskSignature,
		documents,
		requirements,
		allowedCommands,
		requiredChecks,
		stopConditions,
		completionCriteria,
		documentHashes: Object.fromEntries(
			Object.entries(documentHashesRecord).map(([key, item]) => [key, item as string]),
		),
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		status: record.status,
		staleReasons: [...record.staleReasons],
		diagnostics,
	};
}

export function getDocumentRuntimeToolDetails(details: unknown): DocumentRuntimeToolDetails | undefined {
	const detailsRecord = asRecord(details);
	const record = asRecord(detailsRecord?.[DOCUMENT_RUNTIME_DETAILS_KEY]);
	if (
		!record ||
		record.version !== DOCUMENT_RUNTIME_DETAILS_VERSION ||
		(record.kind !== "search" && record.kind !== "read" && record.kind !== "resolve_task")
	) {
		return undefined;
	}
	const citations = parseCitations(record.citations);
	const diagnostics = parseDiagnostics(record.diagnostics);
	const contract = record.contract === undefined ? undefined : parseExecutionContract(record.contract);
	if (!citations || !diagnostics || (record.contract !== undefined && !contract)) return undefined;
	if (record.filesRead !== undefined && !isStringArray(record.filesRead)) return undefined;
	if (record.truncated !== undefined && typeof record.truncated !== "boolean") return undefined;
	if (record.fullOutputPath !== undefined && typeof record.fullOutputPath !== "string") return undefined;
	return {
		version: DOCUMENT_RUNTIME_DETAILS_VERSION,
		kind: record.kind,
		citations,
		diagnostics,
		filesRead: record.filesRead ? [...record.filesRead] : undefined,
		contract,
		truncated: record.truncated,
		fullOutputPath: record.fullOutputPath,
		truncation: record.truncation as TruncationResult | undefined,
	};
}

export function attachDocumentRuntimeToolDetails(
	details: unknown,
	metadata: DocumentRuntimeToolDetails,
): Record<string, unknown> {
	const record = asRecord(details);
	return record
		? { ...record, [DOCUMENT_RUNTIME_DETAILS_KEY]: metadata }
		: { [DOCUMENT_RUNTIME_DETAILS_KEY]: metadata };
}
