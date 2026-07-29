import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { BashResult } from "../bash-executor.ts";
import {
	type CompletionCriterion,
	DOCUMENT_CONTRACT_ENTRY_TYPE,
	type DocumentCitation,
	type DocumentRuntimeToolDetails,
	type ExecutionContract,
	getDocumentRuntimeToolDetails,
	type RequiredCheck,
	type Requirement,
} from "../documents/types.ts";
import type { BashExecutionMessage } from "../messages.ts";
import type { SessionEntry } from "../session-manager.ts";

export const TASK_LEDGER_DETAILS_KEY = "taskLedger";
export const TASK_LEDGER_DETAILS_VERSION = 1;
export const TASK_LEDGER_DUPLICATE_WINDOW_MS = 30_000;
export const TASK_LEDGER_RECENT_COMPLETION_MS = 30_000;

export type TaskPhase = "discover" | "execute" | "verify" | "commit";
export type TaskCommandStatus = "queued" | "running" | "success" | "failed" | "cancelled";
export type TaskVerificationStatus = "none" | "pending" | "running" | "passed" | "failed" | "cancelled";
export type TaskTodoStatus = "pending" | "active" | "completed" | "failed" | "blocked";

export interface TaskLedgerToolDetails {
	version: typeof TASK_LEDGER_DETAILS_VERSION;
	eventId: string;
	status: Exclude<TaskCommandStatus, "queued" | "running">;
	startedAt: number;
	endedAt: number;
	command?: string;
	commandSignature?: string;
	filesRead?: string[];
	filesModified?: string[];
	verification?: boolean;
	commit?: boolean;
}

export interface CommandRecord {
	id: string;
	source: "tool" | "shell";
	toolCallId?: string;
	toolName: string;
	label: string;
	summary?: string;
	command?: string;
	signature?: string;
	status: TaskCommandStatus;
	startedAt: number;
	endedAt?: number;
	workspaceRevision: number;
	duplicateOf?: string;
	verification: boolean;
	commit: boolean;
}

export interface FileReadRecord {
	id: string;
	path: string;
	commandId: string;
	timestamp: number;
}

export interface FileModificationRecord {
	id: string;
	path: string;
	commandId: string;
	timestamp: number;
}

export interface FailureRecord {
	id: string;
	commandId: string;
	toolName: string;
	status: "failed" | "cancelled";
	timestamp: number;
}

export interface VerificationState {
	status: TaskVerificationStatus;
	commandId?: string;
	label?: string;
	timestamp?: number;
}

export interface TaskTodo {
	id: string;
	label: string;
	status: TaskTodoStatus;
	sequence: number;
	updatedAt: number;
	completedAt?: number;
	owner?: string;
	blockedBy?: string[];
	activity?: string;
	source?: string;
}

export type TaskDocumentItemStatus = "pending" | "active" | "completed" | "failed" | "cancelled" | "blocked" | "stale";

export interface TaskRequirementState extends Requirement {
	/** Requirements remain enforceable in the contract and tracked here, but never project as task Todos. */
	projection: "task" | "policy";
	status: TaskDocumentItemStatus;
	evidenceCommandIds: string[];
}

export interface TaskRequiredCheckState extends RequiredCheck {
	/** Policy checks remain documented but do not project as current-task Todos. */
	projection: "task" | "policy";
	status: TaskDocumentItemStatus;
	evidenceCommandIds: string[];
}

export interface TaskCompletionCriterionState extends CompletionCriterion {
	/** Policy completion guidance remains documented but does not project as current-task Todos. */
	projection: "task" | "policy";
	status: TaskDocumentItemStatus;
}

export interface TaskDocumentContractSnapshot {
	contract: ExecutionContract;
	documents: ExecutionContract["documents"];
	requirements: TaskRequirementState[];
	requiredChecks: TaskRequiredCheckState[];
	completionCriteria: TaskCompletionCriterionState[];
	diagnostics: ExecutionContract["diagnostics"];
	stale: boolean;
	staleReasons: string[];
	sourceCitations: DocumentCitation[];
}

export interface TaskLedgerSnapshot {
	taskId: string;
	phase: TaskPhase;
	startedAt?: number;
	updatedAt?: number;
	revision: number;
	workspaceRevision: number;
	commands: readonly CommandRecord[];
	filesRead: readonly FileReadRecord[];
	fileModifications: readonly FileModificationRecord[];
	filesModified: readonly string[];
	failures: readonly FailureRecord[];
	verification: VerificationState;
	todos: readonly TaskTodo[];
	documentContract?: TaskDocumentContractSnapshot;
}

interface MutableCommandRecord extends CommandRecord {
	args?: unknown;
}

interface FinalCommandFacts {
	status: Exclude<TaskCommandStatus, "queued" | "running">;
	endedAt: number;
	filesRead: string[];
	filesModified: string[];
	verification: boolean;
	commit: boolean;
}

interface ParsedCommand {
	tokens: string[];
	hasOperators: boolean;
}

const TOOL_LABELS = Object.freeze({
	read: "Read",
	edit: "Update",
	write: "Write",
	bash: "Bash",
	grep: "Search",
	find: "Find",
	ls: "List",
	web_search: "Web Search",
	web_fetch: "Fetch",
	delegate_task: "Agent",
	workflow_run: "Workflow",
	background_start: "Background",
	monitor_attach: "Monitor Attach",
	monitor_list: "Monitor List",
	monitor_status: "Monitor Status",
	monitor_logs: "Monitor Logs",
	monitor_wait: "Monitor Wait",
	monitor_stop: "Monitor Stop",
	docs_search: "Docs Search",
	docs_read: "Docs Read",
	docs_resolve_task: "Docs Resolve",
} as const satisfies Readonly<Record<string, string>>);

const SHELL_OPERATORS = new Set([";", "&&", "||", "|", "&", "\n"]);
const VERIFICATION_TOOL_NAMES = new Set(["test", "tests", "check", "verify", "lint", "typecheck", "build"]);
const READ_TOOL_NAMES = new Set(["read", "docs_read"]);
const MODIFY_TOOL_NAMES = new Set(["edit", "write"]);
const POLICY_DOCUMENT_KINDS: ReadonlySet<ExecutionContract["documents"][number]["kind"]> = new Set([
	"agents",
	"claude",
	"contributing",
]);
const DEFAULT_TASK_OWNER = "main";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function messageTimestamp(entry: SessionEntry): number {
	if (entry.type === "message") {
		const timestamp = (entry.message as { timestamp?: unknown }).timestamp;
		const parsed = asFiniteNumber(timestamp);
		if (parsed !== undefined) return parsed;
	}
	const parsed = new Date(entry.timestamp).getTime();
	return Number.isNaN(parsed) ? 0 : parsed;
}

function toolLabel(toolName: string): string {
	const known = TOOL_LABELS[toolName as keyof typeof TOOL_LABELS];
	if (known) return known;
	return toolName
		.split(/[_-]+/)
		.filter(Boolean)
		.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

function summarizeValue(value: unknown): string | undefined {
	if (typeof value === "string") return value.split(/\r\n|\r|\n/, 1)[0]?.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

function summarizeToolArgs(toolName: string, args: unknown): string | undefined {
	const record = asRecord(args);
	if (!record) return undefined;
	const keys = toolName === "bash" ? ["command"] : ["path", "file_path", "pattern", "query", "command", "task"];
	for (const key of keys) {
		const summary = summarizeValue(record[key]);
		if (summary) return summary;
	}
	return undefined;
}

function getCommandFromArgs(toolName: string, args: unknown): string | undefined {
	if (toolName !== "bash") return undefined;
	const command = asRecord(args)?.command;
	return typeof command === "string" && command.trim() ? command : undefined;
}

function getPathFromArgs(args: unknown): string | undefined {
	const record = asRecord(args);
	const value = record?.path ?? record?.file_path;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeFilePath(filePath: string, cwd: string): string {
	const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
	const relativePath = relative(resolve(cwd), absolutePath);
	if (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	) {
		return relativePath === "" ? "." : relativePath.split(sep).join("/");
	}
	return absolutePath.split(sep).join("/");
}

function parseCommand(command: string): ParsedCommand {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let hasOperators = false;

	const flush = (): void => {
		if (current.length === 0) return;
		tokens.push(current);
		current = "";
	};

	for (let index = 0; index < command.length; index++) {
		const character = command[index]!;
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			flush();
			if (character === "\n") hasOperators = true;
			continue;
		}
		if (character === ";" || character === "|" || character === "&") {
			flush();
			const next = command[index + 1];
			const operator = next === character && character !== ";" ? `${character}${next}` : character;
			if (operator.length === 2) index++;
			tokens.push(operator);
			hasOperators = true;
			continue;
		}
		current += character;
	}
	if (escaped) current += "\\";
	flush();
	return { tokens, hasOperators };
}

function commandName(token: string): string {
	const normalized = token.replace(/\\/g, "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function canonicalGitStatusTokens(parsed: ParsedCommand): string[] | undefined {
	if (parsed.hasOperators || parsed.tokens.some((token) => SHELL_OPERATORS.has(token))) return undefined;
	const tokens = [...parsed.tokens];
	let index = 0;
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index++;
	if (commandName(tokens[index] ?? "") === "env") {
		index++;
		while (
			index < tokens.length &&
			(tokens[index]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!))
		) {
			index++;
		}
	}
	if (commandName(tokens[index] ?? "") !== "git") return undefined;
	index++;

	const globalOptionsWithValue = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
	while (index < tokens.length) {
		const token = tokens[index]!;
		if (token === "--no-optional-locks" || token === "--no-pager" || token === "--literal-pathspecs") {
			index++;
			continue;
		}
		const optionName = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
		if (globalOptionsWithValue.has(optionName)) {
			index += token.includes("=") ? 1 : 2;
			continue;
		}
		break;
	}
	if ((tokens[index] ?? "").toLowerCase() !== "status") return undefined;
	index++;

	const statusOptions: string[] = [];
	const paths: string[] = [];
	for (; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token === "--") {
			paths.push(...tokens.slice(index + 1));
			break;
		}
		if (token === "-s") statusOptions.push("--short");
		else if (token === "-b") statusOptions.push("--branch");
		else if (token === "-sb" || token === "-bs") statusOptions.push("--branch", "--short");
		else if (token.startsWith("-")) statusOptions.push(token.toLowerCase());
		else paths.push(token);
	}
	return ["git", "status", ...unique(statusOptions).sort(), ...(paths.length > 0 ? ["--", ...paths] : [])];
}

export function createCommandSignature(command: string): string {
	const parsed = parseCommand(command.trim());
	const gitStatusTokens = canonicalGitStatusTokens(parsed);
	const tokens = gitStatusTokens ?? parsed.tokens;
	return tokens
		.map((token, index) => (index === 0 ? commandName(token) : token))
		.join(" ")
		.trim();
}

export function isGitStatusCommand(command: string): boolean {
	return canonicalGitStatusTokens(parseCommand(command.trim())) !== undefined;
}

export function isVerificationCommand(command: string): boolean {
	const normalized = command.trim().replace(/\s+/g, " ");
	if (!normalized) return false;
	return (
		/(^|[;&|]\s*)(\.\/)?test\.sh(?:\s|$)/i.test(normalized) ||
		/(^|[;&|]\s*)(npm|pnpm|yarn|bun)(?:\s+run)?\s+(check|test|lint|typecheck|build)(?:\s|$)/i.test(normalized) ||
		/(^|[;&|]\s*)(npx\s+)?(tsc|vitest|jest|pytest|ruff|eslint)(?:\s|$)/i.test(normalized) ||
		/(^|[;&|]\s*)cargo\s+(check|test|clippy)(?:\s|$)/i.test(normalized) ||
		/(^|[;&|]\s*)go\s+test(?:\s|$)/i.test(normalized) ||
		/(^|[;&|]\s*)git\s+diff\s+--check(?:\s|$)/i.test(normalized)
	);
}

export function isCommitCommand(command: string): boolean {
	const parsed = parseCommand(command.trim());
	if (parsed.hasOperators) return false;
	const tokens = parsed.tokens;
	let index = 0;
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index++;
	if (commandName(tokens[index] ?? "") !== "git") return false;
	index++;
	while (index < tokens.length && tokens[index]!.startsWith("-")) {
		const token = tokens[index]!;
		index += token === "-c" || token === "-C" ? 2 : 1;
	}
	return (tokens[index] ?? "").toLowerCase() === "commit";
}

export function getTaskLedgerToolDetails(details: unknown): TaskLedgerToolDetails | undefined {
	const record = asRecord(details);
	const taskLedger = asRecord(record?.[TASK_LEDGER_DETAILS_KEY]);
	if (!taskLedger || taskLedger.version !== TASK_LEDGER_DETAILS_VERSION) return undefined;
	const eventId = taskLedger.eventId;
	const status = taskLedger.status;
	const startedAt = asFiniteNumber(taskLedger.startedAt);
	const endedAt = asFiniteNumber(taskLedger.endedAt);
	if (
		typeof eventId !== "string" ||
		(status !== "success" && status !== "failed" && status !== "cancelled") ||
		startedAt === undefined ||
		endedAt === undefined
	) {
		return undefined;
	}
	return {
		version: TASK_LEDGER_DETAILS_VERSION,
		eventId,
		status,
		startedAt,
		endedAt,
		command: typeof taskLedger.command === "string" ? taskLedger.command : undefined,
		commandSignature: typeof taskLedger.commandSignature === "string" ? taskLedger.commandSignature : undefined,
		filesRead: asStringArray(taskLedger.filesRead),
		filesModified: asStringArray(taskLedger.filesModified),
		verification: taskLedger.verification === true,
		commit: taskLedger.commit === true,
	};
}

export function attachTaskLedgerToolDetails(details: unknown, metadata: TaskLedgerToolDetails): unknown {
	if (details === undefined || details === null) {
		return { [TASK_LEDGER_DETAILS_KEY]: metadata };
	}
	const record = asRecord(details);
	if (!record) return details;
	return { ...record, [TASK_LEDGER_DETAILS_KEY]: metadata };
}

export class TaskLedger {
	private readonly taskId: string;
	private readonly cwd: string;
	private phase: TaskPhase = "discover";
	private startedAt: number | undefined;
	private updatedAt: number | undefined;
	private revision = 0;
	private workspaceRevision = 0;
	private readonly commands = new Map<string, MutableCommandRecord>();
	private readonly commandOrder: string[] = [];
	private readonly fileReads = new Map<string, FileReadRecord>();
	private readonly fileModifications = new Map<string, FileModificationRecord>();
	private readonly failures = new Map<string, FailureRecord>();
	private readonly documentRuntimeDetails = new Map<string, DocumentRuntimeToolDetails>();
	private documentContract: ExecutionContract | undefined;

	constructor(options: { taskId: string; cwd: string; entries?: readonly SessionEntry[] }) {
		this.taskId = options.taskId;
		this.cwd = options.cwd;
		if (options.entries) this.rebuild(options.entries);
	}

	rebuild(entries: readonly SessionEntry[]): void {
		this.phase = "discover";
		this.startedAt = undefined;
		this.updatedAt = undefined;
		this.workspaceRevision = 0;
		this.commands.clear();
		this.commandOrder.length = 0;
		this.fileReads.clear();
		this.fileModifications.clear();
		this.failures.clear();
		this.documentRuntimeDetails.clear();
		this.documentContract = undefined;

		const unresolvedAssistantStates = new Map<string, "failed" | "cancelled">();
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === DOCUMENT_CONTRACT_ENTRY_TYPE) {
				const details = getDocumentRuntimeToolDetails(entry.data);
				if (details) this.ingestDocumentRuntimeDetails(`entry:${entry.id}`, details);
				continue;
			}
			if (entry.type !== "message") continue;
			const timestamp = messageTimestamp(entry);
			const message = entry.message;
			if (message.role === "user") {
				this.noteTaskStarted(timestamp);
				continue;
			}
			if (message.role === "assistant") {
				const unresolvedStatus =
					message.stopReason === "aborted" ? "cancelled" : message.stopReason === "error" ? "failed" : undefined;
				for (const content of message.content) {
					if (content.type !== "toolCall") continue;
					this.startTool(content.id, content.name, content.arguments, timestamp);
					if (unresolvedStatus) unresolvedAssistantStates.set(content.id, unresolvedStatus);
				}
				continue;
			}
			if (message.role === "toolResult") {
				const metadata = getTaskLedgerToolDetails(message.details);
				this.finishTool(
					message.toolCallId,
					message.toolName,
					message.details,
					metadata?.status ?? (message.isError ? "failed" : "success"),
					timestamp,
					metadata,
				);
				unresolvedAssistantStates.delete(message.toolCallId);
				continue;
			}
			if (message.role === "bashExecution") {
				this.ingestBashEntry(entry.id, message, timestamp);
			}
		}

		for (const [toolCallId, status] of unresolvedAssistantStates) {
			const record = this.commands.get(`tool:${toolCallId}`);
			if (record && (record.status === "queued" || record.status === "running")) {
				this.applyFinalFacts(record, {
					status,
					endedAt: record.startedAt,
					filesRead: [],
					filesModified: [],
					verification: record.verification,
					commit: record.commit,
				});
			}
		}
		for (const record of this.commands.values()) {
			if (record.status !== "queued" && record.status !== "running") continue;
			this.applyFinalFacts(record, {
				status: "cancelled",
				endedAt: record.startedAt,
				filesRead: [],
				filesModified: [],
				verification: record.verification,
				commit: record.commit,
			});
		}
		this.revision++;
	}

	handleAgentEvent(event: AgentEvent, options?: { cancelled?: boolean }): TaskLedgerToolDetails | undefined {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "user") this.noteTaskStarted(event.message.timestamp);
				return undefined;
			case "tool_execution_start":
				this.startTool(event.toolCallId, event.toolName, event.args, Date.now());
				return undefined;
			case "tool_execution_end": {
				const status = options?.cancelled ? "cancelled" : event.isError ? "failed" : "success";
				return this.finishTool(
					event.toolCallId,
					event.toolName,
					(event.result as { details?: unknown }).details,
					status,
					Date.now(),
				);
			}
			default:
				return undefined;
		}
	}

	updateToolArgs(toolCallId: string, args: unknown): void {
		const record = this.commands.get(`tool:${toolCallId}`);
		if (!record) return;
		record.args = args;
		record.summary = summarizeToolArgs(record.toolName, args);
		const command = getCommandFromArgs(record.toolName, args);
		if (command) {
			record.command = command;
			record.signature = createCommandSignature(command);
			record.verification = isVerificationCommand(command);
			record.commit = isCommitCommand(command);
		}
	}

	startShell(executionId: string, command: string, startedAt = Date.now()): CommandRecord {
		const id = `shell:${executionId}`;
		return this.startCommand({
			id,
			source: "shell",
			toolName: "bash",
			args: { command },
			startedAt,
		});
	}

	finishShell(
		executionId: string,
		command: string,
		result: BashResult & { error?: string },
		endedAt = Date.now(),
	): TaskLedgerToolDetails {
		const id = `shell:${executionId}`;
		let record = this.commands.get(id);
		if (!record) {
			this.startShell(executionId, command, endedAt);
			record = this.commands.get(id)!;
		}
		const status: FinalCommandFacts["status"] = result.cancelled
			? "cancelled"
			: result.error || (result.exitCode !== undefined && result.exitCode !== 0)
				? "failed"
				: "success";
		return this.applyFinalFacts(record, {
			status,
			endedAt,
			filesRead: [],
			filesModified: [],
			verification: record.verification,
			commit: record.commit,
		});
	}

	getDocumentRuntimeDetails(toolCallId: string): DocumentRuntimeToolDetails | undefined {
		return this.documentRuntimeDetails.get(`tool:${toolCallId}`);
	}

	setDocumentRuntimeContract(contract: ExecutionContract | undefined): void {
		this.documentContract = contract ? structuredClone(contract) : undefined;
		this.revision++;
	}

	recordDocumentRuntimeDetails(eventId: string, details: DocumentRuntimeToolDetails): void {
		this.ingestDocumentRuntimeDetails(eventId, details);
		this.revision++;
	}

	getToolDetails(toolCallId: string): TaskLedgerToolDetails | undefined {
		const record = this.commands.get(`tool:${toolCallId}`);
		if (!record || record.status === "queued" || record.status === "running") return undefined;
		const filesRead = [...this.fileReads.values()]
			.filter((file) => file.commandId === record.id)
			.map((file) => file.path);
		const filesModified = [...this.fileModifications.values()]
			.filter((file) => file.commandId === record.id)
			.map((file) => file.path);
		return this.metadataFor(record, filesRead, filesModified);
	}

	getSnapshot(now = Date.now()): TaskLedgerSnapshot {
		const commands = this.commandOrder
			.map((id) => this.commands.get(id))
			.filter((record): record is MutableCommandRecord => record !== undefined)
			.map(({ args: _args, ...record }) => ({ ...record }));
		const fileReads = [...this.fileReads.values()].map((record) => ({ ...record }));
		const fileModifications = [...this.fileModifications.values()].map((record) => ({ ...record }));
		const failures = [...this.failures.values()].map((record) => ({ ...record }));
		const filesModified = unique(fileModifications.map((record) => record.path));
		const verification = this.getVerificationState(commands, fileModifications);
		const documentContract = this.buildDocumentContractSnapshot(commands);
		return {
			taskId: this.taskId,
			phase: this.phase,
			startedAt: this.startedAt,
			updatedAt: this.updatedAt,
			revision: this.revision,
			workspaceRevision: this.workspaceRevision,
			commands,
			filesRead: fileReads,
			fileModifications,
			filesModified,
			failures,
			verification,
			todos: this.buildTodos(commands, filesModified, verification, now),
			documentContract,
		};
	}

	private noteTaskStarted(timestamp: number): void {
		if (!Number.isFinite(timestamp)) return;
		if (this.startedAt === undefined || timestamp < this.startedAt) this.startedAt = timestamp;
		this.updatedAt = Math.max(this.updatedAt ?? timestamp, timestamp);
	}

	private startTool(toolCallId: string, toolName: string, args: unknown, startedAt: number): CommandRecord {
		return this.startCommand({
			id: `tool:${toolCallId}`,
			source: "tool",
			toolCallId,
			toolName,
			args,
			startedAt,
		});
	}

	private startCommand(options: {
		id: string;
		source: "tool" | "shell";
		toolCallId?: string;
		toolName: string;
		args: unknown;
		startedAt: number;
	}): CommandRecord {
		const existing = this.commands.get(options.id);
		if (existing) return existing;
		const command = getCommandFromArgs(options.toolName, options.args);
		const signature = command ? createCommandSignature(command) : undefined;
		const verification = command ? isVerificationCommand(command) : VERIFICATION_TOOL_NAMES.has(options.toolName);
		const commit = command ? isCommitCommand(command) : options.toolName === "git_commit";
		const record: MutableCommandRecord = {
			id: options.id,
			source: options.source,
			toolCallId: options.toolCallId,
			toolName: options.toolName,
			label: toolLabel(options.toolName),
			summary: summarizeToolArgs(options.toolName, options.args),
			command,
			signature,
			status: "running",
			startedAt: options.startedAt,
			workspaceRevision: this.workspaceRevision,
			verification,
			commit,
			args: options.args,
		};
		if (command && signature && isGitStatusCommand(command)) {
			const duplicate = this.findDuplicateGitStatus(signature, options.startedAt);
			if (duplicate) record.duplicateOf = duplicate.id;
		}
		this.commands.set(record.id, record);
		this.commandOrder.push(record.id);
		this.noteTaskStarted(options.startedAt);
		this.updatedAt = options.startedAt;
		if (commit) this.phase = "commit";
		else if (verification) this.phase = "verify";
		else if (MODIFY_TOOL_NAMES.has(options.toolName)) this.phase = "execute";
		else if (!READ_TOOL_NAMES.has(options.toolName) && !["grep", "find", "ls"].includes(options.toolName)) {
			if (!(command && isGitStatusCommand(command))) this.phase = "execute";
		}
		this.revision++;
		return { ...record };
	}

	private findDuplicateGitStatus(signature: string, startedAt: number): MutableCommandRecord | undefined {
		for (let index = this.commandOrder.length - 1; index >= 0; index--) {
			const previous = this.commands.get(this.commandOrder[index]!);
			if (!previous || previous.signature !== signature || previous.workspaceRevision !== this.workspaceRevision)
				continue;
			if (!previous.command || !isGitStatusCommand(previous.command)) continue;
			const previousTime = previous.endedAt ?? previous.startedAt;
			const elapsed = startedAt - previousTime;
			if (elapsed < 0 || elapsed > TASK_LEDGER_DUPLICATE_WINDOW_MS) return undefined;
			return previous;
		}
		return undefined;
	}

	private finishTool(
		toolCallId: string,
		toolName: string,
		details: unknown,
		fallbackStatus: FinalCommandFacts["status"],
		endedAt: number,
		metadata = getTaskLedgerToolDetails(details),
	): TaskLedgerToolDetails {
		const id = `tool:${toolCallId}`;
		let record = this.commands.get(id);
		if (!record) {
			this.startTool(toolCallId, toolName, undefined, metadata?.startedAt ?? endedAt);
			record = this.commands.get(id)!;
		}
		const documentDetails = getDocumentRuntimeToolDetails(details);
		if (documentDetails) this.ingestDocumentRuntimeDetails(record.id, documentDetails);
		const suppliedFilesRead =
			metadata?.filesRead ?? this.extractFilesRead(toolName, record.args, details, fallbackStatus);
		const suppliedFilesModified =
			metadata?.filesModified ?? this.extractFilesModified(toolName, record.args, details, fallbackStatus);
		return this.applyFinalFacts(record, {
			status: metadata?.status ?? fallbackStatus,
			endedAt: metadata?.endedAt ?? endedAt,
			filesRead: suppliedFilesRead,
			filesModified: suppliedFilesModified,
			verification: metadata?.verification ?? record.verification,
			commit: metadata?.commit ?? record.commit,
		});
	}

	private extractFilesRead(
		toolName: string,
		args: unknown,
		details: unknown,
		status: FinalCommandFacts["status"],
	): string[] {
		if (status !== "success") return [];
		const taskDetails = asRecord(asRecord(details)?.[TASK_LEDGER_DETAILS_KEY]);
		const supplied = asStringArray(taskDetails?.filesRead);
		if (supplied.length > 0) return supplied;
		const detailsPath = asRecord(details)?.path;
		const documentDetails = getDocumentRuntimeToolDetails(details);
		const documentPath = documentDetails?.filesRead?.[0];
		const path = typeof detailsPath === "string" ? detailsPath : (documentPath ?? getPathFromArgs(args));
		return READ_TOOL_NAMES.has(toolName) && path ? [normalizeFilePath(path, this.cwd)] : [];
	}

	private extractFilesModified(
		toolName: string,
		args: unknown,
		details: unknown,
		status: FinalCommandFacts["status"],
	): string[] {
		if (status !== "success") return [];
		const taskDetails = asRecord(asRecord(details)?.[TASK_LEDGER_DETAILS_KEY]);
		const supplied = asStringArray(taskDetails?.filesModified);
		if (supplied.length > 0) return supplied;
		const detailsPath = asRecord(details)?.path;
		const path = typeof detailsPath === "string" ? detailsPath : getPathFromArgs(args);
		return MODIFY_TOOL_NAMES.has(toolName) && path ? [normalizeFilePath(path, this.cwd)] : [];
	}

	private ingestDocumentRuntimeDetails(eventId: string, details: DocumentRuntimeToolDetails): void {
		const normalizedEventId =
			eventId.startsWith("tool:") || eventId.startsWith("entry:") ? eventId : `tool:${eventId}`;
		this.documentRuntimeDetails.set(normalizedEventId, details);
		if (details.kind === "resolve_task" && details.contract)
			this.documentContract = structuredClone(details.contract);
	}

	private applyFinalFacts(record: MutableCommandRecord, facts: FinalCommandFacts): TaskLedgerToolDetails {
		const wasFinal = record.status === "success" || record.status === "failed" || record.status === "cancelled";
		if (wasFinal) {
			return this.metadataFor(record, facts.filesRead, facts.filesModified);
		}
		record.status = facts.status;
		record.endedAt = facts.endedAt;
		record.verification = facts.verification;
		record.commit = facts.commit;
		const normalizedReads = unique(facts.filesRead.map((filePath) => normalizeFilePath(filePath, this.cwd)));
		const normalizedModifications = unique(
			facts.filesModified.map((filePath) => normalizeFilePath(filePath, this.cwd)),
		);
		for (const filePath of normalizedReads) {
			const id = `read:${record.id}:${filePath}`;
			if (!this.fileReads.has(id)) {
				this.fileReads.set(id, { id, path: filePath, commandId: record.id, timestamp: facts.endedAt });
			}
		}
		let modified = false;
		for (const filePath of normalizedModifications) {
			const id = `modify:${record.id}:${filePath}`;
			if (!this.fileModifications.has(id)) {
				this.fileModifications.set(id, {
					id,
					path: filePath,
					commandId: record.id,
					timestamp: facts.endedAt,
				});
				modified = true;
			}
		}
		if (modified) {
			this.workspaceRevision++;
			this.phase = "execute";
		}
		if (facts.commit) this.phase = "commit";
		else if (facts.verification) this.phase = "verify";
		else if (MODIFY_TOOL_NAMES.has(record.toolName)) this.phase = "execute";
		if (facts.status === "failed" || facts.status === "cancelled") {
			const id = `failure:${record.id}`;
			if (!this.failures.has(id)) {
				this.failures.set(id, {
					id,
					commandId: record.id,
					toolName: record.toolName,
					status: facts.status,
					timestamp: facts.endedAt,
				});
			}
		}
		this.updatedAt = facts.endedAt;
		this.revision++;
		return this.metadataFor(record, normalizedReads, normalizedModifications);
	}

	private metadataFor(
		record: MutableCommandRecord,
		filesRead: readonly string[],
		filesModified: readonly string[],
	): TaskLedgerToolDetails {
		return {
			version: TASK_LEDGER_DETAILS_VERSION,
			eventId: record.id,
			status: record.status === "success" || record.status === "cancelled" ? record.status : "failed",
			startedAt: record.startedAt,
			endedAt: record.endedAt ?? record.startedAt,
			command: record.command,
			commandSignature: record.signature,
			filesRead: filesRead.length > 0 ? [...filesRead] : undefined,
			filesModified: filesModified.length > 0 ? [...filesModified] : undefined,
			verification: record.verification || undefined,
			commit: record.commit || undefined,
		};
	}

	private ingestBashEntry(entryId: string, message: BashExecutionMessage, timestamp: number): void {
		const executionId = entryId;
		this.startShell(executionId, message.command, message.timestamp ?? timestamp);
		this.finishShell(
			executionId,
			message.command,
			{
				output: message.output,
				exitCode: message.exitCode,
				cancelled: message.cancelled,
				truncated: message.truncated,
				fullOutputPath: message.fullOutputPath,
			},
			timestamp,
		);
	}

	private getVerificationState(
		commands: readonly CommandRecord[],
		fileModifications: readonly FileModificationRecord[],
	): VerificationState {
		const latestModification = fileModifications[fileModifications.length - 1];
		const verificationCommands = commands.filter((command) => command.verification);
		const latestVerification = verificationCommands[verificationCommands.length - 1];
		if (!latestVerification) {
			return latestModification
				? { status: "pending", timestamp: latestModification.timestamp }
				: { status: "none" };
		}
		const verificationTime = latestVerification.endedAt ?? latestVerification.startedAt;
		if (latestModification && latestModification.timestamp > verificationTime) {
			return { status: "pending", timestamp: latestModification.timestamp };
		}
		const status: TaskVerificationStatus =
			latestVerification.status === "running" || latestVerification.status === "queued"
				? "running"
				: latestVerification.status === "success"
					? "passed"
					: latestVerification.status === "cancelled"
						? "cancelled"
						: "failed";
		return {
			status,
			commandId: latestVerification.id,
			label: latestVerification.command ?? latestVerification.label,
			timestamp: verificationTime,
		};
	}

	private buildDocumentContractSnapshot(commands: readonly CommandRecord[]): TaskDocumentContractSnapshot | undefined {
		const contract = this.documentContract;
		if (!contract) return undefined;
		const stale = contract.status === "stale";
		const projectionForCitations = (citations: readonly DocumentCitation[]): "task" | "policy" => {
			const citedDocuments = contract.documents.filter((document) =>
				citations.some((citation) => citation.documentId === document.id),
			);
			return citedDocuments.length > 0 &&
				citedDocuments.every((document) => POLICY_DOCUMENT_KINDS.has(document.kind))
				? "policy"
				: "task";
		};
		const requirementProjection = new Map(
			contract.requirements.map((requirement) => [requirement.id, projectionForCitations(requirement.citations)]),
		);
		const criterionProjection = new Map(
			contract.completionCriteria.map((criterion) => [criterion.id, projectionForCitations(criterion.citations)]),
		);
		const taskCheckIds = new Set([
			...contract.requirements
				.filter((requirement) => requirementProjection.get(requirement.id) === "task")
				.flatMap((requirement) => requirement.requiredCheckIds),
			...contract.completionCriteria
				.filter((criterion) => criterionProjection.get(criterion.id) === "task")
				.flatMap((criterion) => criterion.requiredCheckIds),
		]);
		const commandForCheck = (check: RequiredCheck): CommandRecord[] =>
			commands.filter(
				(command) =>
					command.signature !== undefined &&
					check.commands.some((expected) => command.signature === createCommandSignature(expected)),
			);
		const checkStates: TaskRequiredCheckState[] = contract.requiredChecks.map((check) => {
			const evidence = commandForCheck(check);
			const latest = evidence[evidence.length - 1];
			const status: TaskDocumentItemStatus = stale
				? "stale"
				: latest === undefined || latest.status === "queued"
					? "pending"
					: latest.status === "running"
						? "active"
						: latest.status === "success"
							? "completed"
							: latest.status === "cancelled"
								? "cancelled"
								: "failed";
			const finalEvidence = evidence.filter(
				(command) => command.status === "success" || command.status === "failed" || command.status === "cancelled",
			);
			return {
				...check,
				projection: taskCheckIds.has(check.id) ? "task" : "policy",
				status,
				evidenceCommandIds: finalEvidence.map((item) => item.id),
			};
		});
		const statusForRequirement = (requirement: Requirement): TaskDocumentItemStatus => {
			if (stale) return "stale";
			if (requirement.requiredCheckIds.length === 0) return "pending";
			const checks = checkStates.filter(
				(check) => check.projection === "task" && requirement.requiredCheckIds.includes(check.id),
			);
			if (checks.some((check) => check.status === "failed" || check.status === "cancelled")) return "blocked";
			if (checks.length > 0 && checks.every((check) => check.status === "completed")) return "completed";
			if (checks.some((check) => check.status === "active")) return "active";
			return "pending";
		};
		const requirementStates: TaskRequirementState[] = contract.requirements.map((requirement) => {
			const projection = requirementProjection.get(requirement.id) ?? "task";
			const evidenceCommandIds = checkStates
				.filter((check) => check.projection === "task" && requirement.requiredCheckIds.includes(check.id))
				.flatMap((check) => check.evidenceCommandIds);
			return {
				...requirement,
				projection,
				status: statusForRequirement(requirement),
				evidenceCommandIds,
			};
		});
		const completionCriteria: TaskCompletionCriterionState[] = contract.completionCriteria.map((criterion) => {
			const projection = criterionProjection.get(criterion.id) ?? "task";
			const checks = checkStates.filter(
				(check) => check.projection === "task" && criterion.requiredCheckIds.includes(check.id),
			);
			const status: TaskDocumentItemStatus = stale
				? "stale"
				: checks.length > 0 && checks.every((check) => check.status === "completed")
					? "completed"
					: checks.some((check) => check.status === "failed" || check.status === "cancelled")
						? "blocked"
						: checks.some((check) => check.status === "active")
							? "active"
							: "pending";
			return { ...criterion, projection, status };
		});
		return {
			contract: structuredClone(contract),
			documents: structuredClone(contract.documents),
			requirements: requirementStates,
			requiredChecks: checkStates,
			completionCriteria,
			diagnostics: structuredClone(contract.diagnostics),
			stale,
			staleReasons: [...contract.staleReasons],
			sourceCitations: [
				...contract.requirements.flatMap((item) => item.citations),
				...contract.requiredChecks.flatMap((item) => item.citations),
				...contract.completionCriteria.flatMap((item) => item.citations),
			].filter((citation, index, all) => all.findIndex((item) => item.id === citation.id) === index),
		};
	}

	private buildTodos(
		commands: readonly CommandRecord[],
		filesModified: readonly string[],
		verification: VerificationState,
		now: number,
	): TaskTodo[] {
		if (this.startedAt === undefined && commands.length === 0 && !this.documentContract) return [];
		const firstCommand = commands[0];
		const latestCommand = commands[commands.length - 1];
		const mutationCommands = commands.filter((command) => MODIFY_TOOL_NAMES.has(command.toolName));
		const latestMutation = mutationCommands[mutationCommands.length - 1];
		const duplicateStatuses = commands.filter(
			(command) =>
				command.duplicateOf !== undefined &&
				command.workspaceRevision === this.workspaceRevision &&
				now - command.startedAt <= TASK_LEDGER_DUPLICATE_WINDOW_MS,
		);
		const todos: TaskTodo[] = [];
		const documentSnapshot = this.buildDocumentContractSnapshot(commands);
		if (documentSnapshot) {
			const contractTime = Date.parse(documentSnapshot.contract.updatedAt) || now;
			for (const check of documentSnapshot.requiredChecks) {
				if (check.projection === "policy") continue;
				const status: TaskTodoStatus =
					check.status === "completed"
						? "completed"
						: check.status === "failed" || check.status === "cancelled"
							? "failed"
							: check.status === "stale"
								? "blocked"
								: check.status === "active"
									? "active"
									: "pending";
				const source = check.citations[0];
				todos.push({
					id: `required-check:${check.id}`,
					label: `Required check: ${check.label}`,
					status,
					sequence: -50 + todos.length,
					updatedAt: contractTime,
					owner: DEFAULT_TASK_OWNER,
					blockedBy: status === "blocked" ? [check.status] : undefined,
					source: source ? `${source.displayPath}:${source.startLine}` : undefined,
				});
			}
			for (const criterion of documentSnapshot.completionCriteria) {
				if (criterion.projection === "policy") continue;
				const status: TaskTodoStatus =
					criterion.status === "completed"
						? "completed"
						: criterion.status === "stale" || criterion.status === "blocked"
							? "blocked"
							: criterion.status === "active"
								? "active"
								: "pending";
				const source = criterion.citations[0];
				todos.push({
					id: `completion:${criterion.id}`,
					label: `Completion: ${criterion.text}`,
					status,
					sequence: -10 + todos.length,
					updatedAt: contractTime,
					owner: DEFAULT_TASK_OWNER,
					source: source ? `${source.displayPath}:${source.startLine}` : undefined,
				});
			}
		}

		const discoveryCompletedAt =
			firstCommand?.endedAt ?? (firstCommand?.status === "running" ? undefined : firstCommand?.startedAt);
		todos.push({
			id: "discover",
			label: "Inspect task context",
			status: firstCommand ? (discoveryCompletedAt === undefined ? "active" : "completed") : "active",
			sequence: 0,
			updatedAt: discoveryCompletedAt ?? this.startedAt ?? now,
			completedAt: discoveryCompletedAt,
			owner: DEFAULT_TASK_OWNER,
			activity: firstCommand?.label,
		});

		let executeStatus: TaskTodoStatus = "pending";
		let executeCompletedAt: number | undefined;
		if (latestMutation?.status === "running" || (this.phase === "execute" && filesModified.length === 0)) {
			executeStatus = "active";
		} else if (latestMutation?.status === "failed" || latestMutation?.status === "cancelled") {
			executeStatus = "failed";
		} else if (filesModified.length > 0) {
			executeStatus = "completed";
			executeCompletedAt = latestMutation?.endedAt;
		}
		todos.push({
			id: "execute",
			label:
				filesModified.length > 0
					? `Update ${filesModified.length} file${filesModified.length === 1 ? "" : "s"}`
					: "Make requested changes",
			status: executeStatus,
			sequence: 1,
			updatedAt: latestMutation?.endedAt ?? latestMutation?.startedAt ?? this.startedAt ?? now,
			completedAt: executeCompletedAt,
			owner: DEFAULT_TASK_OWNER,
			activity: latestMutation?.summary,
		});

		const verifyStatus: TaskTodoStatus =
			verification.status === "running"
				? "active"
				: verification.status === "passed"
					? "completed"
					: verification.status === "failed" || verification.status === "cancelled"
						? "failed"
						: "pending";
		todos.push({
			id: "verify",
			label: "Run verification",
			status: verifyStatus,
			sequence: 2,
			updatedAt: verification.timestamp ?? this.startedAt ?? now,
			completedAt: verification.status === "passed" ? verification.timestamp : undefined,
			owner: DEFAULT_TASK_OWNER,
			activity: verification.label,
		});

		const commitCommands = commands.filter((command) => command.commit);
		const latestCommit = commitCommands[commitCommands.length - 1];
		if (latestCommit) {
			todos.push({
				id: "commit",
				label: "Commit changes",
				status:
					latestCommit.status === "running" || latestCommit.status === "queued"
						? "active"
						: latestCommit.status === "success"
							? "completed"
							: "failed",
				sequence: 3,
				updatedAt: latestCommit.endedAt ?? latestCommit.startedAt,
				completedAt: latestCommit.status === "success" ? latestCommit.endedAt : undefined,
				owner: DEFAULT_TASK_OWNER,
				activity: latestCommit.command,
			});
		}

		if (duplicateStatuses.length > 0) {
			const latestDuplicate = duplicateStatuses[duplicateStatuses.length - 1]!;
			todos.push({
				id: "duplicate-git-status",
				label: "Repeated git status",
				status: "blocked",
				sequence: 4,
				updatedAt: latestDuplicate.startedAt,
				owner: DEFAULT_TASK_OWNER,
				blockedBy: ["unchanged workspace"],
				activity: latestDuplicate.command,
			});
		}

		if (latestCommand && latestCommand.status === "failed" && !latestCommand.verification && !latestCommand.commit) {
			todos.push({
				id: `failure:${latestCommand.id}`,
				label: `${latestCommand.label} failed`,
				status: "failed",
				sequence: 5,
				updatedAt: latestCommand.endedAt ?? latestCommand.startedAt,
				owner: DEFAULT_TASK_OWNER,
				activity: latestCommand.command ?? latestCommand.summary,
			});
		}
		return todos;
	}
}

export function taskTodoSelectionRank(todo: TaskTodo, now: number): number {
	if (
		todo.status === "completed" &&
		todo.completedAt !== undefined &&
		now - todo.completedAt <= TASK_LEDGER_RECENT_COMPLETION_MS
	) {
		return 0;
	}
	if (todo.status === "failed") return 1;
	if (todo.status === "active") return 2;
	if (todo.status === "pending") return 3;
	if (todo.status === "blocked") return 4;
	return 5;
}

export function selectTaskTodos(
	todos: readonly TaskTodo[],
	maxVisible: number,
	now = Date.now(),
): { visible: TaskTodo[]; hidden: TaskTodo[] } {
	const limit = Math.max(0, Math.floor(maxVisible));
	const sorted = todos
		.map((todo, index) => ({ todo, index }))
		.sort(
			(left, right) =>
				taskTodoSelectionRank(left.todo, now) - taskTodoSelectionRank(right.todo, now) ||
				right.todo.updatedAt - left.todo.updatedAt ||
				left.todo.sequence - right.todo.sequence ||
				left.index - right.index,
		)
		.map(({ todo }) => todo);
	return { visible: sorted.slice(0, limit), hidden: sorted.slice(limit) };
}
