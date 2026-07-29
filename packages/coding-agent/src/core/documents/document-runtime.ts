import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ResourceLoader } from "../resource-loader.ts";
import { isVerificationCommand } from "../state/task-ledger.ts";
import { type TruncationResult, truncateHead } from "../tools/truncate.ts";
import { DEFAULT_DOCUMENT_RUNTIME_BUDGETS, type DocumentDiscoveryFile, discoverDocuments } from "./discovery.ts";
import {
	createDocumentCitation,
	findHeading,
	getHeadingRange,
	getLineRange,
	headingForLine,
	indexMarkdownDocument,
} from "./markdown.ts";
import {
	type CompletionCriterion,
	type DocumentCitation,
	type DocumentDiagnostic,
	type DocumentedCommand,
	type DocumentReadResult,
	type DocumentReference,
	type DocumentRuntimeBudgets,
	type DocumentRuntimeSnapshot,
	type DocumentSearchMatch,
	type DocumentSearchResult,
	type DocumentSearchScope,
	type DocumentSource,
	type ExecutionContract,
	hashDocumentContent,
	type IndexedDocument,
	type RequiredCheck,
	type Requirement,
	type StopCondition,
	stableDocumentId,
} from "./types.ts";

const REQUIRED_HEADING_PATTERN =
	/requirements?|rules?|constraints?|guidelines?|testing|tests?|verification|verify|acceptance|completion|contributing/i;
const CHECK_HEADING_PATTERN = /testing|tests?|verification|verify|checks?|acceptance/i;
const COMPLETION_HEADING_PATTERN = /acceptance|completion|done|finish|verification/i;
const STOP_HEADING_PATTERN = /constraints?|rules?|stop|safety|guidelines?/i;
const CODE_LANGUAGE_PATTERN = /^(bash|sh|shell|zsh|console|shellscript|text)?$/i;
const COMMAND_PREFIX_PATTERN =
	/^(?:\$\s*)?(?:npm|pnpm|yarn|bun|node|npx|git|cargo|go|python(?:3)?|pytest|vitest|jest|tsc|eslint|prettier|make|\.\/|docker|deno|ruby|java|mvn)\b/i;
const NEGATIVE_PATTERN =
	/\b(?:must not|do not|don't|never|forbid|forbidden|prohibited|不得|禁止|不允许|不要|不可|不能)\b/i;
const POSITIVE_MODAL_PATTERN = /\b(?:must|required|shall|should|need to|run|check|ensure|遵循|必须|需要|应当|应该)\b/i;
const LIST_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/;
const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;

interface RuntimeCacheEntry {
	document: IndexedDocument;
	lastUsed: number;
}

interface ExtractedFacts {
	requirements: Requirement[];
	allowedCommands: DocumentedCommand[];
	requiredChecks: RequiredCheck[];
	stopConditions: StopCondition[];
	completionCriteria: CompletionCriterion[];
	diagnostics: DocumentDiagnostic[];
}

export interface ResolveTaskOptions {
	task: string;
	explicitPaths?: string[];
	refresh?: boolean;
}

export interface ResolveTaskResult {
	contract: ExecutionContract;
	diagnostics: DocumentDiagnostic[];
	truncated: boolean;
	indexedDocuments: number;
	indexedBytes: number;
}

export interface DocumentRuntimeOptions {
	cwd: string;
	agentDir: string;
	resourceLoader: ResourceLoader;
	budgets?: Partial<DocumentRuntimeBudgets>;
	now?: () => number;
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function normalizeText(value: string): string {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/[`*_>#]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function taskTokens(value: string): string[] {
	return uniqueStrings(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []);
}

function commandSignature(command: string): string {
	return command
		.trim()
		.replace(/^\$\s*/, "")
		.replace(/\s+/g, " ")
		.toLocaleLowerCase();
}

function isCommandLike(command: string): boolean {
	const normalized = command.trim().replace(/^\$\s*/, "");
	return (
		COMMAND_PREFIX_PATTERN.test(normalized) ||
		/\b(?:run|execute|invoke)\s+(?:npm|pnpm|yarn|bun|git|node)\b/i.test(normalized) ||
		/[;&|]/.test(normalized)
	);
}

function headingIsRelevant(title: string | undefined): boolean {
	return title !== undefined && REQUIRED_HEADING_PATTERN.test(title);
}

function headingIsCheck(title: string | undefined): boolean {
	return title !== undefined && CHECK_HEADING_PATTERN.test(title);
}

function headingIsCompletion(title: string | undefined): boolean {
	return title !== undefined && COMPLETION_HEADING_PATTERN.test(title);
}

function headingIsStop(title: string | undefined): boolean {
	return title !== undefined && STOP_HEADING_PATTERN.test(title);
}

function cleanFactText(value: string): string {
	return value
		.replace(/<!--.*?-->/g, "")
		.replace(/\[[ xX]\]\s*/, "")
		.replace(/\*\*/g, "")
		.replace(/__+/g, "")
		.trim();
}

function factPolarity(text: string): "positive" | "negative" {
	return NEGATIVE_PATTERN.test(text) ? "negative" : "positive";
}

function citationForLine(document: IndexedDocument, lineNumber: number): DocumentCitation {
	const heading = headingForLine(document, lineNumber);
	return createDocumentCitation(document.reference, lineNumber, lineNumber, heading?.path);
}

function citationForRange(document: IndexedDocument, startLine: number, endLine: number): DocumentCitation {
	const heading = headingForLine(document, startLine);
	return createDocumentCitation(document.reference, startLine, endLine, heading?.path);
}

function addCitation<T extends { citations: DocumentCitation[] }>(item: T, citation: DocumentCitation): void {
	if (!item.citations.some((existing) => existing.id === citation.id)) item.citations.push(citation);
}

function choosePrimarySource(sources: readonly DocumentSource[]): DocumentSource {
	const order: DocumentSource[] = ["global", "ancestor", "project", "nearby", "explicit", "package"];
	return (
		[...sources].sort((left, right) => order.indexOf(left) - order.indexOf(right) || left.localeCompare(right))[0] ??
		"project"
	);
}

function referenceFromFile(file: DocumentDiscoveryFile, critical: boolean): DocumentReference {
	const sources = [...file.sources];
	return {
		id: stableDocumentId("document", file.canonicalPath),
		path: file.canonicalPath,
		displayPath: file.displayPath,
		kind: file.kind,
		source: choosePrimarySource(sources),
		sources,
		directoryDistance: file.directoryDistance,
		hash: hashDocumentContent(file.content),
		size: file.size,
		mtimeMs: file.mtimeMs,
		critical,
	};
}

function scoreDocument(document: IndexedDocument, query: string, cwd: string): { score: number; reasons: string[] } {
	const normalizedQuery = normalizeText(query);
	const tokens = taskTokens(query);
	const reasons: string[] = [];
	let score = 0;
	if (document.reference.source === "global") {
		score += 42;
		reasons.push("global context");
	} else if (document.reference.source === "ancestor") {
		score += 34;
		reasons.push("ancestor context");
	}
	if (document.reference.kind === "contributing") score += 18;
	if (document.reference.kind === "readme") score += 10;
	if (document.reference.kind === "package-json") score += 8;
	if (document.reference.directoryDistance === 0) score += 16;
	else score += Math.max(0, 12 - document.reference.directoryDistance * 2);
	const headingText = document.headings
		.map((heading) => heading.path.join(" "))
		.join(" ")
		.toLocaleLowerCase();
	const bodyText = document.content.toLocaleLowerCase();
	if (normalizedQuery && bodyText.includes(normalizedQuery)) {
		score += 8;
		reasons.push("exact body match");
	}
	for (const token of tokens) {
		if (headingText.includes(token)) {
			score += 12;
			reasons.push(`heading:${token}`);
		}
		if (bodyText.includes(token)) {
			score += 2;
			reasons.push(`body:${token}`);
		}
	}
	if (document.reference.path.startsWith(resolve(cwd))) score += 2;
	return { score, reasons: uniqueStrings(reasons) };
}

function snippetForLine(document: IndexedDocument, lineNumber: number): string {
	const start = Math.max(1, lineNumber - 1);
	const end = Math.min(document.lines.length, lineNumber + 1);
	return document.lines
		.slice(start - 1, end)
		.join("\n")
		.trim();
}

function bestMatchLine(
	document: IndexedDocument,
	query: string,
): { line: number; heading?: ReturnType<typeof headingForLine> } {
	const normalizedQuery = normalizeText(query);
	const tokens = taskTokens(query);
	for (const heading of document.headings) {
		const headingText = heading.path.join(" ").toLocaleLowerCase();
		if (normalizedQuery && headingText.includes(normalizedQuery)) return { line: heading.startLine, heading };
		if (tokens.some((token) => headingText.includes(token))) return { line: heading.startLine, heading };
	}
	for (let index = 0; index < document.lines.length; index++) {
		const line = document.lines[index]!.toLocaleLowerCase();
		if ((normalizedQuery && line.includes(normalizedQuery)) || tokens.some((token) => line.includes(token))) {
			return { line: index + 1, heading: headingForLine(document, index + 1) };
		}
	}
	return { line: 1, heading: undefined };
}

function mergeRequirement(requirements: Requirement[], candidate: Requirement): void {
	const existing = requirements.find(
		(item) => normalizeText(item.text) === normalizeText(candidate.text) && item.polarity === candidate.polarity,
	);
	if (existing) {
		for (const citation of candidate.citations) addCitation(existing, citation);
		for (const checkId of candidate.requiredCheckIds) {
			if (!existing.requiredCheckIds.includes(checkId)) existing.requiredCheckIds.push(checkId);
		}
		return;
	}
	requirements.push(candidate);
}

function mergeCommand(commands: DocumentedCommand[], candidate: DocumentedCommand): void {
	const existing = commands.find((item) => commandSignature(item.command) === commandSignature(candidate.command));
	if (existing) {
		for (const citation of candidate.citations) addCitation(existing, citation);
		return;
	}
	commands.push(candidate);
}

function mergeCheck(checks: RequiredCheck[], candidate: RequiredCheck): RequiredCheck {
	const existing = checks.find(
		(item) =>
			item.commands.some((command) =>
				candidate.commands.some((other) => commandSignature(command) === commandSignature(other)),
			) || normalizeText(item.label) === normalizeText(candidate.label),
	);
	if (existing) {
		for (const command of candidate.commands)
			if (!existing.commands.includes(command)) existing.commands.push(command);
		for (const citation of candidate.citations) addCitation(existing, citation);
		return existing;
	}
	checks.push(candidate);
	return candidate;
}

function mergeCompletion(criteria: CompletionCriterion[], candidate: CompletionCriterion): void {
	const existing = criteria.find((item) => normalizeText(item.text) === normalizeText(candidate.text));
	if (existing) {
		for (const citation of candidate.citations) addCitation(existing, citation);
		for (const checkId of candidate.requiredCheckIds)
			if (!existing.requiredCheckIds.includes(checkId)) existing.requiredCheckIds.push(checkId);
		return;
	}
	criteria.push(candidate);
}

function mergeStopCondition(conditions: StopCondition[], candidate: StopCondition): void {
	const existing = conditions.find((item) => normalizeText(item.text) === normalizeText(candidate.text));
	if (existing) {
		for (const citation of candidate.citations) addCitation(existing, citation);
		return;
	}
	conditions.push(candidate);
}

function extractFacts(documents: readonly IndexedDocument[]): ExtractedFacts {
	const requirements: Requirement[] = [];
	const allowedCommands: DocumentedCommand[] = [];
	const requiredChecks: RequiredCheck[] = [];
	const stopConditions: StopCondition[] = [];
	const completionCriteria: CompletionCriterion[] = [];
	const diagnostics: DocumentDiagnostic[] = [];

	for (const document of documents) {
		for (const script of document.packageScripts) {
			const citation = citationForLine(document, script.line);
			const command: DocumentedCommand = {
				id: stableDocumentId("command", document.reference.id, script.name, script.command),
				command: script.command,
				kind: "recommended",
				scriptName: script.name,
				citations: [citation],
			};
			mergeCommand(allowedCommands, command);
			if (
				/^(check|test|lint|typecheck|verify|build)(:|$)/i.test(script.name) ||
				isVerificationCommand(script.command)
			) {
				mergeCheck(requiredChecks, {
					id: stableDocumentId("check", document.reference.id, script.name, script.command),
					label: `Run ${script.name}`,
					commands: [script.command],
					citations: [citation],
				});
			}
		}

		const headingByLine = (line: number) => headingForLine(document, line);
		for (const block of document.codeBlocks) {
			const heading = headingByLine(block.startLine);
			if (!CODE_LANGUAGE_PATTERN.test(block.language ?? "") && !headingIsRelevant(heading?.title)) continue;
			for (let offset = 0; offset < block.lines.length; offset++) {
				const commandText = block.lines[offset]!.trim();
				if (!commandText || commandText.startsWith("#") || commandText.startsWith("//")) continue;
				const command = commandText.replace(/^\$\s*/, "");
				if (!isCommandLike(command)) continue;
				const line = block.contentStartLine + offset;
				const citation = citationForLine(document, line);
				mergeCommand(allowedCommands, {
					id: stableDocumentId("command", document.reference.id, command),
					command,
					kind: headingIsCheck(heading?.title) ? "recommended" : "allowed",
					citations: [citation],
				});
				if (headingIsCheck(heading?.title) || isVerificationCommand(command)) {
					const check = mergeCheck(requiredChecks, {
						id: stableDocumentId("check", document.reference.id, command),
						label: `Run ${command}`,
						commands: [command],
						citations: [citation],
					});
					for (const requirement of requirements) {
						if (
							requirement.citations.some(
								(item) =>
									item.documentId === document.reference.id &&
									item.startLine >= (heading?.startLine ?? 1) &&
									item.startLine <= block.endLine,
							)
						) {
							if (!requirement.requiredCheckIds.includes(check.id)) requirement.requiredCheckIds.push(check.id);
						}
					}
				}
			}
		}

		for (let index = 0; index < document.lines.length; index++) {
			const lineNumber = index + 1;
			if (document.codeBlocks.some((block) => lineNumber >= block.startLine && lineNumber <= block.endLine))
				continue;
			const line = document.lines[index] ?? "";
			const heading = headingByLine(lineNumber);
			const listMatch = line.match(LIST_PATTERN);
			const text = cleanFactText(listMatch?.[1] ?? line);
			if (!text || text.length > 500) continue;
			const explicit = POSITIVE_MODAL_PATTERN.test(text) || NEGATIVE_PATTERN.test(text);
			const eligibleList = listMatch !== null && headingIsRelevant(heading?.title);
			if (!explicit && !eligibleList) continue;
			const citation = citationForLine(document, lineNumber);
			const polarity = factPolarity(text);
			const requirement: Requirement = {
				id: stableDocumentId("requirement", normalizeText(text), polarity),
				text,
				level: /\b(?:should|recommended|建议|可以)\b/i.test(text) ? "recommended" : "required",
				polarity,
				citations: [citation],
				requiredCheckIds: [],
			};
			mergeRequirement(requirements, requirement);
			if (polarity === "negative" && (headingIsStop(heading?.title) || explicit)) {
				mergeStopCondition(stopConditions, {
					id: stableDocumentId("stop", normalizeText(text)),
					text,
					citations: [citation],
				});
			}
			if (headingIsCompletion(heading?.title) || /\b(?:done|complete|completion|acceptance)\b/i.test(text)) {
				mergeCompletion(completionCriteria, {
					id: stableDocumentId("completion", normalizeText(text)),
					text,
					requiredCheckIds: [],
					citations: [citation],
				});
			}
			if (headingIsCheck(heading?.title) && isCommandLike(text)) {
				const check = mergeCheck(requiredChecks, {
					id: stableDocumentId("check", document.reference.id, text),
					label: text,
					commands: [text],
					citations: [citation],
				});
				requirement.requiredCheckIds.push(check.id);
			}
		}

		for (let index = 0; index < document.lines.length; index++) {
			const lineNumber = index + 1;
			const line = document.lines[index] ?? "";
			const heading = headingByLine(lineNumber);
			for (const match of line.matchAll(INLINE_CODE_PATTERN)) {
				const command = match[1]!.trim();
				if (!isCommandLike(command)) continue;
				const citation = citationForLine(document, lineNumber);
				mergeCommand(allowedCommands, {
					id: stableDocumentId("command", document.reference.id, command),
					command,
					kind: headingIsCheck(heading?.title) ? "recommended" : "allowed",
					citations: [citation],
				});
				if (headingIsCheck(heading?.title) || isVerificationCommand(command)) {
					const check = mergeCheck(requiredChecks, {
						id: stableDocumentId("check", document.reference.id, command),
						label: `Run ${command}`,
						commands: [command],
						citations: [citation],
					});
					for (const requirement of requirements) {
						if (
							requirement.citations.some((item) => item.id === citation.id) &&
							!requirement.requiredCheckIds.includes(check.id)
						) {
							requirement.requiredCheckIds.push(check.id);
						}
					}
				}
			}
		}
	}

	for (const check of requiredChecks) {
		for (const criterion of completionCriteria) {
			if (
				criterion.citations.some((citation) =>
					check.citations.some((item) => item.documentId === citation.documentId),
				)
			) {
				if (!criterion.requiredCheckIds.includes(check.id)) criterion.requiredCheckIds.push(check.id);
			}
		}
	}
	if (completionCriteria.length === 0 && requiredChecks.length > 0) {
		const citations = requiredChecks
			.flatMap((check) => check.citations)
			.filter((citation, index, all) => all.findIndex((item) => item.id === citation.id) === index);
		completionCriteria.push({
			id: stableDocumentId("completion", "required-checks"),
			text: "Complete the documented required checks",
			requiredCheckIds: requiredChecks.map((check) => check.id),
			citations,
		});
	}

	const positiveByCore = new Map<string, Requirement>();
	const negativeByCore = new Map<string, Requirement>();
	for (const requirement of requirements) {
		const core = normalizeText(requirement.text)
			.replace(/\b(?:must not|do not|don't|never|required|must|shall|不得|禁止|必须|不允许)\b/g, "")
			.trim();
		const opposite = requirement.polarity === "positive" ? negativeByCore.get(core) : positiveByCore.get(core);
		if (opposite) {
			diagnostics.push({
				code: "conflict",
				severity: "error",
				message: `Conflicting documented requirements: “${opposite.text}” and “${requirement.text}”`,
				citations: [...opposite.citations, ...requirement.citations],
			});
		}
		(requirement.polarity === "positive" ? positiveByCore : negativeByCore).set(core, requirement);
	}
	return { requirements, allowedCommands, requiredChecks, stopConditions, completionCriteria, diagnostics };
}

function selectDocuments(
	documents: readonly IndexedDocument[],
	task: string,
	cwd: string,
	maxDocuments: number,
): IndexedDocument[] {
	const scored = documents.map((document) => ({ document, score: scoreDocument(document, task, cwd).score }));
	const mandatory = scored.filter(
		({ document }) =>
			document.reference.kind === "agents" ||
			document.reference.kind === "claude" ||
			document.reference.source === "global" ||
			document.reference.source === "ancestor" ||
			document.reference.source === "explicit",
	);
	const selected: IndexedDocument[] = [];
	const add = (document: IndexedDocument): void => {
		if (!selected.some((item) => item.reference.id === document.reference.id) && selected.length < maxDocuments)
			selected.push(document);
	};
	for (const item of mandatory.sort(
		(left, right) =>
			left.score - right.score || left.document.reference.path.localeCompare(right.document.reference.path),
	))
		add(item.document);
	for (const item of scored.sort(
		(left, right) =>
			right.score - left.score || left.document.reference.path.localeCompare(right.document.reference.path),
	)) {
		if (item.score <= 0 && selected.length > 0) continue;
		add(item.document);
	}
	return selected;
}

function contractPrompt(contract: ExecutionContract): string {
	const citationLabel = (citation: DocumentCitation): string => `${citation.displayPath}:${citation.startLine}`;
	const lines = [
		`id=${contract.id} version=${contract.version}`,
		`task=${contract.task.replace(/[\r\n]+/g, " ").slice(0, 500)}`,
		"requirements:",
		...contract.requirements
			.slice(0, 20)
			.map((item) => `- ${item.text} [${item.citations.map(citationLabel).join(", ")}]`),
		"required checks:",
		...contract.requiredChecks
			.slice(0, 12)
			.map(
				(item) => `- ${item.label}: ${item.commands.join(" | ")} [${item.citations.map(citationLabel).join(", ")}]`,
			),
		"completion:",
		...contract.completionCriteria
			.slice(0, 12)
			.map((item) => `- ${item.text} [${item.citations.map(citationLabel).join(", ")}]`),
		"stop conditions:",
		...contract.stopConditions
			.slice(0, 12)
			.map((item) => `- ${item.text} [${item.citations.map(citationLabel).join(", ")}]`),
		"documents:",
		...contract.documents.map((document) => `- ${document.displayPath} (${document.hash.slice(0, 12)})`),
	];
	return lines.join("\n").slice(0, 12_000);
}

export class DocumentRuntime {
	readonly cwd: string;
	readonly agentDir: string;
	private readonly resourceLoader: ResourceLoader;
	private readonly budgets: DocumentRuntimeBudgets;
	private readonly now: () => number;
	private readonly cache = new Map<string, RuntimeCacheEntry>();
	private currentContract: ExecutionContract | undefined;

	constructor(options: DocumentRuntimeOptions) {
		this.cwd = resolve(options.cwd);
		this.agentDir = resolve(options.agentDir);
		this.resourceLoader = options.resourceLoader;
		this.budgets = { ...DEFAULT_DOCUMENT_RUNTIME_BUDGETS, ...options.budgets };
		this.now = options.now ?? Date.now;
	}

	get snapshot(): DocumentRuntimeSnapshot {
		return { contract: this.currentContract ? structuredClone(this.currentContract) : undefined };
	}

	getContract(): ExecutionContract | undefined {
		return this.currentContract ? structuredClone(this.currentContract) : undefined;
	}

	getPromptContract(): string | undefined {
		if (!this.currentContract || this.currentContract.status !== "active") return undefined;
		return contractPrompt(this.currentContract);
	}

	restoreContract(contract: ExecutionContract | undefined): void {
		this.currentContract = contract ? structuredClone(contract) : undefined;
	}

	async initialize(): Promise<ExecutionContract | undefined> {
		return this.validateCurrentContract();
	}

	async reload(): Promise<void> {
		this.cache.clear();
		await this.validateCurrentContract();
	}

	async discover(explicitPaths?: string[]): Promise<{
		documents: IndexedDocument[];
		diagnostics: DocumentDiagnostic[];
		truncated: boolean;
		indexedBytes: number;
	}> {
		const result = await discoverDocuments({
			cwd: this.cwd,
			agentDir: this.agentDir,
			resourceLoader: this.resourceLoader,
			budgets: this.budgets,
			explicitPaths,
		});
		const documents: IndexedDocument[] = [];
		for (const file of result.files) {
			documents.push(this.indexFile(file));
		}
		return {
			documents,
			diagnostics: result.diagnostics,
			truncated: result.truncated,
			indexedBytes: result.totalBytes,
		};
	}

	async search(query: string, scope?: DocumentSearchScope): Promise<DocumentSearchResult> {
		const discovered = await this.discover();
		const normalizedPaths = new Set((scope?.paths ?? []).map((path) => resolve(this.cwd, path)));
		const documentIds = new Set(scope?.documentIds ?? []);
		const sources = new Set(scope?.sources ?? []);
		const filtered = discovered.documents.filter((document) => {
			if (sources.size > 0 && !document.reference.sources.some((source) => sources.has(source))) return false;
			if (documentIds.size > 0 && !documentIds.has(document.reference.id)) return false;
			if (normalizedPaths.size > 0 && !normalizedPaths.has(document.reference.path)) return false;
			return true;
		});
		const tokens = taskTokens(query);
		if (tokens.length === 0) {
			return {
				query,
				matches: [],
				diagnostics: [
					...discovered.diagnostics,
					{ code: "invalid_markdown_range", severity: "info", message: "Search query is empty" },
				],
				truncated: discovered.truncated,
				indexedDocuments: filtered.length,
				indexedBytes: discovered.indexedBytes,
			};
		}
		const matches: DocumentSearchMatch[] = [];
		for (const document of filtered) {
			const scored = scoreDocument(document, query, this.cwd);
			const best = bestMatchLine(document, query);
			const normalizedBody = document.content.toLocaleLowerCase();
			const normalizedHeading = document.headings
				.map((heading) => heading.path.join(" "))
				.join(" ")
				.toLocaleLowerCase();
			const hasMatch =
				normalizedBody.includes(normalizeText(query)) ||
				tokens.some((token) => normalizedBody.includes(token) || normalizedHeading.includes(token));
			if (!hasMatch) continue;
			const citation = citationForLine(document, best.line);
			matches.push({
				id: stableDocumentId("match", document.reference.id, citation.id, normalizeText(query)),
				document: document.reference,
				citation,
				heading: best.heading,
				snippet: snippetForLine(document, best.line),
				score: scored.score,
				reasons: scored.reasons,
			});
		}
		const sorted = matches.sort(
			(left, right) => right.score - left.score || left.document.path.localeCompare(right.document.path),
		);
		const truncated = discovered.truncated || sorted.length > this.budgets.maxSearchResults;
		return {
			query,
			matches: sorted.slice(0, this.budgets.maxSearchResults),
			diagnostics: discovered.diagnostics,
			truncated,
			indexedDocuments: filtered.length,
			indexedBytes: discovered.indexedBytes,
		};
	}

	async read(options: {
		document: string;
		heading?: string;
		startLine?: number;
		endLine?: number;
		offset?: number;
		limit?: number;
	}): Promise<DocumentReadResult> {
		const looksLikeDocumentId = options.document.startsWith("document_");
		const discovered = await this.discover(looksLikeDocumentId ? undefined : [options.document]);
		const document = this.findDocument(discovered.documents, options.document);
		if (!document) throw new Error(`Document not found: ${options.document}`);
		const diagnostics = [...discovered.diagnostics];
		let startLine = options.startLine;
		let endLine = options.endLine;
		let selectedHeading: ReturnType<typeof findHeading>["heading"];
		if (options.heading !== undefined) {
			const headingResult = findHeading(document, options.heading);
			if (!headingResult.heading) {
				diagnostics.push({
					code: "heading_not_found",
					severity: "error",
					message: `Heading not found: ${options.heading}`,
					path: document.reference.path,
				});
				throw new Error(`Heading not found: ${options.heading}`);
			}
			if (headingResult.ambiguous)
				diagnostics.push({
					code: "ambiguous_heading",
					severity: "warning",
					message: `Multiple headings match: ${options.heading}`,
					path: document.reference.path,
				});
			selectedHeading = headingResult.heading;
			startLine = selectedHeading.startLine;
			endLine = selectedHeading.endLine;
		}
		if (options.offset !== undefined) {
			startLine = options.offset;
			if (options.limit !== undefined) endLine = options.offset + options.limit - 1;
		}
		startLine ??= 1;
		endLine ??= document.lines.length;
		if (startLine < 1 || endLine < startLine || startLine > document.lines.length) {
			diagnostics.push({
				code: "invalid_markdown_range",
				severity: "error",
				message: "Invalid document line range",
				path: document.reference.path,
			});
			throw new Error("Invalid document line range");
		}
		endLine = Math.min(endLine, document.lines.length);
		const citation = citationForRange(document, startLine, endLine);
		return {
			content: selectedHeading
				? getHeadingRange(document, selectedHeading)
				: getLineRange(document, startLine, endLine),
			document: document.reference,
			citation,
			heading: selectedHeading,
			diagnostics,
		};
	}

	async resolveTask(options: ResolveTaskOptions): Promise<ResolveTaskResult> {
		const discovered = await this.discover(options.explicitPaths);
		const selected = selectDocuments(discovered.documents, options.task, this.cwd, this.budgets.maxContractDocuments);
		const criticalDocuments = selected.map((document) => ({
			...document,
			reference: { ...document.reference, critical: true },
		}));
		const facts = extractFacts(criticalDocuments);
		const diagnostics = [...discovered.diagnostics, ...facts.diagnostics];
		const documentHashes = Object.fromEntries(
			criticalDocuments.map((document) => [document.reference.id, document.reference.hash]),
		);
		const taskSignature = stableDocumentId("task", normalizeText(options.task));
		const contractId = stableDocumentId(
			"contract",
			taskSignature,
			...criticalDocuments.flatMap((document) => [document.reference.id, document.reference.hash]),
		);
		const existing = this.currentContract?.id === contractId ? this.currentContract : undefined;
		const timestamp = new Date(this.now()).toISOString();
		const contract: ExecutionContract = {
			version: 1,
			id: contractId,
			task: options.task,
			taskSignature,
			documents: criticalDocuments.map((document) => document.reference),
			requirements: facts.requirements,
			allowedCommands: facts.allowedCommands,
			requiredChecks: facts.requiredChecks,
			stopConditions: facts.stopConditions,
			completionCriteria: facts.completionCriteria,
			documentHashes,
			createdAt: existing?.createdAt ?? timestamp,
			updatedAt: options.refresh || !existing ? timestamp : existing.updatedAt,
			status: "active",
			staleReasons: [],
			diagnostics,
		};
		this.currentContract = contract;
		return {
			contract: structuredClone(contract),
			diagnostics,
			truncated: discovered.truncated,
			indexedDocuments: discovered.documents.length,
			indexedBytes: discovered.indexedBytes,
		};
	}

	async validateCurrentContract(): Promise<ExecutionContract | undefined> {
		if (!this.currentContract) return undefined;
		const reasons: string[] = [];
		for (const document of this.currentContract.documents) {
			try {
				const currentContent = await readFile(document.path, "utf-8");
				const currentHash = hashDocumentContent(currentContent);
				if (currentHash !== this.currentContract?.documentHashes[document.id]) {
					reasons.push(
						`${document.displayPath} changed (expected ${document.hash.slice(0, 12)}, found ${currentHash.slice(0, 12)})`,
					);
				}
			} catch {
				reasons.push(`${document.displayPath} is unavailable`);
			}
		}
		this.currentContract = {
			...this.currentContract,
			status: reasons.length > 0 ? "stale" : "active",
			staleReasons: uniqueStrings(reasons),
			updatedAt:
				reasons.length > 0 && this.currentContract.status !== "stale"
					? new Date(this.now()).toISOString()
					: this.currentContract.updatedAt,
		};
		return structuredClone(this.currentContract);
	}

	async noteFilesModified(paths: readonly string[]): Promise<ExecutionContract | undefined> {
		if (!this.currentContract || paths.length === 0) return this.currentContract;
		const changed = new Set(paths.map((path) => resolve(this.cwd, path)));
		if (!this.currentContract.documents.some((document) => changed.has(resolve(document.path))))
			return this.currentContract;
		return this.validateCurrentContract();
	}

	private indexFile(file: DocumentDiscoveryFile): IndexedDocument {
		const critical =
			this.currentContract?.documents.some(
				(document) => document.id === stableDocumentId("document", file.canonicalPath),
			) ?? false;
		const reference = referenceFromFile(file, critical);
		const cached = this.cache.get(file.canonicalPath);
		if (cached && cached.document.reference.hash === reference.hash) {
			cached.lastUsed = this.now();
			return { ...cached.document, reference };
		}
		const indexed = indexMarkdownDocument(reference, file.content);
		indexed.packageScripts = file.packageScripts;
		this.cache.set(file.canonicalPath, { document: indexed, lastUsed: this.now() });
		this.trimCache();
		return indexed;
	}

	private trimCache(): void {
		while (this.cache.size > this.budgets.maxCachedDocuments) {
			const oldest = [...this.cache.entries()].sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
			if (!oldest) return;
			this.cache.delete(oldest[0]);
		}
	}

	private findDocument(documents: readonly IndexedDocument[], input: string): IndexedDocument | undefined {
		const resolvedInput = resolve(this.cwd, input);
		return documents.find(
			(document) =>
				document.reference.id === input ||
				document.reference.path === resolvedInput ||
				document.reference.displayPath === input ||
				basename(document.reference.path) === input,
		);
	}
}

export function formatExecutionContractForPrompt(contract: ExecutionContract): string {
	return contractPrompt(contract);
}

export async function writeDocumentToolOutput(
	content: string,
): Promise<{ path: string; truncation: TruncationResult }> {
	const truncation = truncateHead(content);
	const path = `/tmp/pi-docs-${randomBytes(8).toString("hex")}.log`;
	await writeFile(path, content, "utf-8");
	return { path, truncation };
}
