import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type Api, contentText, type Model } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { AgentSession, AgentSessionEvent } from "../agent-session.ts";
import type { DocumentCitation } from "../documents/types.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { PolicySettings } from "../policy/index.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../sdk.ts";
import type { SearchRuntime, WebCitation } from "../search/index.ts";
import { SessionManager } from "../session-manager.ts";
import { SettingsManager } from "../settings-manager.ts";
import { allToolNames } from "../tools/index.ts";
import {
	type AgentCancellationStrategy,
	type AgentPoolConfig,
	type AgentProfile,
	calculateAgentConcurrencyLimit,
	DEFAULT_AGENT_IDLE_TIMEOUT_MS,
	DEFAULT_AGENT_PROFILE,
	MAX_AGENT_TIMEOUT_MS,
	resolveAgentProfiles,
} from "./agent-profile.ts";
import { createControlledResourceLoader } from "./controlled-resource-loader.ts";

export type AgentTaskStatus = "completed" | "failed" | "cancelled" | "timed_out";
export type AgentLifecycleEventType = "started" | "running" | "progress" | AgentTaskStatus;

export interface AgentTaskError {
	code: string;
	message: string;
}

export interface AgentTaskCheck {
	name: string;
	status: "passed" | "failed" | "pending" | "unknown";
	details?: string;
}

export interface AgentTaskUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	cost: number;
}

export interface AgentTaskBudgetSummary {
	maxTokens?: number;
	maxTurns?: number;
	/** Final wall-clock limit after a pool slot is acquired. */
	timeoutMs?: number;
	/** Sliding no-progress limit refreshed by observable child activity. */
	idleTimeoutMs?: number;
	tokensUsed: number;
	turnsUsed: number;
	elapsedMs: number;
}

export type AgentTaskActivityOutcome = "started" | "succeeded" | "failed";

export interface AgentTaskActivity {
	turn: number;
	toolName?: string;
	targetPath?: string;
	outcome: AgentTaskActivityOutcome;
	message: string;
	timestamp: number;
}

export type AgentTaskCitation = DocumentCitation | WebCitation;

export interface AgentClarificationQuestion {
	question: string;
	options: string[];
}

export interface AgentClarificationRequest {
	version: 1;
	questions: AgentClarificationQuestion[];
}

export interface AgentTaskResult {
	taskId: string;
	profile: string;
	status: AgentTaskStatus;
	summary: string;
	citations: AgentTaskCitation[];
	references: string[];
	filesModified: string[];
	checks: AgentTaskCheck[];
	diagnostics: string[];
	clarificationRequest?: AgentClarificationRequest;
	lastActivity?: AgentTaskActivity;
	error?: AgentTaskError;
	usage: AgentTaskUsage;
	budget: AgentTaskBudgetSummary;
}

export interface AgentLifecycleEvent {
	taskId: string;
	profile: string;
	taskSummary: string;
	timestamp: number;
	type: AgentLifecycleEventType;
	status: "starting" | "running" | AgentTaskStatus;
	turn?: number;
	toolName?: string;
	targetPath?: string;
	outcome?: AgentTaskActivityOutcome;
	message?: string;
	budget?: AgentTaskBudgetSummary;
	lastActivity?: AgentTaskActivity;
	error?: AgentTaskError;
}

export interface AgentProgressEvent extends AgentTaskActivity {
	taskId: string;
	profile: string;
}

export type AgentLifecycleEventListener = (event: AgentLifecycleEvent) => void;
export type AgentTaskProgressListener = (event: AgentProgressEvent) => void;

type CreateChildSession = (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;

interface SlotWaiter {
	resolve: (release: () => void) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	cleanup: () => void;
}

export interface AgentPoolDependencies {
	cwd: string;
	agentDir: string;
	modelRuntime: ModelRuntime;
	resourceLoader: ResourceLoader;
	model?: Model<Api>;
	customTools?: readonly ToolDefinition[];
	searchRuntime: SearchRuntime;
	searchBudgetScopeId: string;
	policySettings?: PolicySettings;
	createSession: CreateChildSession;
}

export interface DelegateTaskInput {
	task: string;
	profile?: string;
	budget?: {
		maxTokens?: number;
		maxTurns?: number;
		/** Sliding no-progress timeout; activity renews it up to the Profile hard limit. */
		timeoutMs?: number;
	};
	cancelStrategy?: AgentCancellationStrategy;
	/** Internal absolute limit used by Workflow nodes; not exposed by delegate_task. */
	hardTimeoutMs?: number;
	/** Internal Workflow override; not exposed by delegate_task. */
	cwd?: string;
	/** Internal Workflow boundary that can further restrict, never broaden, Profile write access. */
	allowFileModifications?: boolean;
}

const DELEGATE_TASK_PARAMETERS = Type.Object({
	task: Type.String({ minLength: 1, description: "Self-contained task for the child agent" }),
	profile: Type.Optional(Type.String({ minLength: 1, description: "Agent profile id" })),
	budget: Type.Optional(
		Type.Object({
			maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
			maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
			timeoutMs: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_AGENT_TIMEOUT_MS,
					description: "No-progress timeout; child activity renews it up to the Profile hard limit",
				}),
			),
		}),
	),
	cancelStrategy: Type.Optional(Type.Union([Type.Literal("abort"), Type.Literal("graceful")])),
});

type DelegateTaskParameters = Static<typeof DELEGATE_TASK_PARAMETERS>;

const DEFAULT_CHILD_TOOLS = new Set(DEFAULT_AGENT_PROFILE.toolAllowlist ?? []);
const AGENT_ACTIVITY_HEARTBEAT_MS = 15_000;

const RESERVED_TOOL_NAMES = new Set([
	"delegate_task",
	"ask_user_question",
	"tasks_update",
	"privileged_exec",
	"workflow_run",
	"workflow_status",
	"workflow_cancel",
	"background_start",
	"background_attach",
	"background_status",
	"background_logs",
	"background_wait",
	"background_cancel",
]);

function errorWithCode(code: string, message: string): AgentTaskError {
	return { code, message };
}

function abortError(): Error {
	const error = new Error("Operation cancelled");
	error.name = "AbortError";
	return error;
}

function asErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function taskSummary(task: string): string {
	const firstLine = task.split(/\r\n|\r|\n/, 1)[0]?.trim() ?? "";
	return firstLine.length > 160 ? `${firstLine.slice(0, 159)}…` : firstLine;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function targetPathFromArgs(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
	const record = args as Record<string, unknown>;
	for (const key of ["path", "file_path", "document", "targetPath", "cwd"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function isAgentTaskResult(value: AgentTaskResult | AgentProgressEvent): value is AgentTaskResult {
	return "budget" in value;
}

function agentResultText(result: AgentTaskResult | AgentProgressEvent): string {
	if (!isAgentTaskResult(result)) {
		const target = result.targetPath ? ` · ${result.targetPath}` : "";
		return `${result.message}${target}`;
	}
	if (result.status === "completed") return taskSummary(result.summary) || "Completed";
	const code = result.error?.code ?? result.status;
	const turns =
		result.budget.maxTurns === undefined
			? `${result.budget.turnsUsed} turns`
			: `${result.budget.turnsUsed}/${result.budget.maxTurns} turns`;
	const last = result.lastActivity?.toolName ? ` · last: ${result.lastActivity.toolName}` : "";
	return `${code} · ${turns}${last}`;
}

function agentStatusColor(result: AgentTaskResult): "success" | "muted" | "error" {
	if (result.status === "completed") return "success";
	if (result.status === "cancelled") return "muted";
	return "error";
}

function agentBudgetSummary(result: AgentTaskResult): string {
	const turns =
		result.budget.maxTurns === undefined
			? `${result.budget.turnsUsed} turns`
			: `${result.budget.turnsUsed}/${result.budget.maxTurns} turns`;
	const hardTimeout =
		result.budget.timeoutMs === undefined
			? "no timeout"
			: `${Math.round(result.budget.timeoutMs / 60_000)}m hard timeout`;
	const timeout =
		result.budget.idleTimeoutMs !== undefined && result.budget.idleTimeoutMs < (result.budget.timeoutMs ?? Infinity)
			? `${Math.round(result.budget.idleTimeoutMs / 60_000)}m idle · ${hardTimeout}`
			: hardTimeout;
	const elapsedSeconds = Math.max(0, result.budget.elapsedMs) / 1000;
	const elapsed = elapsedSeconds < 10 ? `${elapsedSeconds.toFixed(1)}s` : `${Math.round(elapsedSeconds)}s`;
	return `${result.status} · ${turns} · ${result.budget.tokensUsed} output tokens · ${elapsed} · ${timeout}`;
}

function agentDetailBody(result: AgentTaskResult): string {
	const lines: string[] = [];
	const summary = result.summary.trim();
	if (summary) lines.push(summary);
	if (result.error) lines.push(`Error: ${result.error.message}`);
	if (result.lastActivity) {
		const target = result.lastActivity.targetPath ? ` · ${result.lastActivity.targetPath}` : "";
		lines.push(`Last activity: ${result.lastActivity.message}${target}`);
	}
	if (result.references.length > 0) {
		lines.push(`References:\n${result.references.map((reference) => `- ${reference}`).join("\n")}`);
	}
	if (result.filesModified.length > 0) {
		lines.push(`Files modified:\n${result.filesModified.map((file) => `- ${file}`).join("\n")}`);
	}
	if (result.checks.length > 0) {
		lines.push(
			`Checks:\n${result.checks
				.map((check) => `- ${check.name}: ${check.status}${check.details ? ` · ${check.details}` : ""}`)
				.join("\n")}`,
		);
	}
	if (result.diagnostics.length > 0) {
		lines.push(`Diagnostics:\n${result.diagnostics.map((diagnostic) => `- ${diagnostic}`).join("\n")}`);
	}
	return lines.join("\n");
}

function parseClarificationRequest(text: string | undefined): AgentClarificationRequest | undefined {
	if (!text) return undefined;
	const match = text.match(/<clarification_request>\s*([\s\S]*?)\s*<\/clarification_request>/);
	if (!match?.[1]) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[1]);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	if (
		record.version !== 1 ||
		!Array.isArray(record.questions) ||
		record.questions.length < 1 ||
		record.questions.length > 4
	) {
		return undefined;
	}
	const questions: AgentClarificationQuestion[] = [];
	for (const item of record.questions) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
		const question = item as Record<string, unknown>;
		if (typeof question.question !== "string" || !question.question.trim()) return undefined;
		if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 4)
			return undefined;
		if (
			!question.options.every((option): option is string => typeof option === "string" && option.trim().length > 0)
		) {
			return undefined;
		}
		questions.push({ question: question.question, options: [...question.options] });
	}
	return { version: 1, questions };
}

function usageFromSession(session: AgentSession): AgentTaskUsage {
	const stats = session.getSessionStats();
	return {
		inputTokens: stats.tokens.input,
		outputTokens: stats.tokens.output,
		cacheReadTokens: stats.tokens.cacheRead,
		cacheWriteTokens: stats.tokens.cacheWrite,
		totalTokens: stats.tokens.total,
		cost: stats.cost,
	};
}

function lastAssistant(session: AgentSession): Extract<AgentMessage, { role: "assistant" }> | undefined {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (message?.role === "assistant") return message as Extract<AgentMessage, { role: "assistant" }>;
	}
	return undefined;
}

function makeChecks(session: AgentSession): AgentTaskCheck[] {
	const verification = session.taskLedger.getSnapshot().verification;
	if (verification.status === "none") return [];
	const status =
		verification.status === "passed"
			? "passed"
			: verification.status === "failed"
				? "failed"
				: verification.status === "pending" || verification.status === "running"
					? "pending"
					: "unknown";
	return [
		{
			name: verification.label ?? "task verification",
			status,
		},
	];
}

function createResultBase(
	taskId: string,
	profile: AgentProfile,
	status: AgentTaskStatus,
	startedAt: number,
	usage: AgentTaskUsage,
	turnsUsed: number,
	error?: AgentTaskError,
): AgentTaskResult {
	return {
		taskId,
		profile: profile.id,
		status,
		summary: "",
		citations: [],
		references: [],
		filesModified: [],
		checks: [],
		diagnostics: [],
		...(error ? { error } : {}),
		usage,
		budget: {
			maxTokens: profile.maxTokens,
			maxTurns: profile.maxTurns,
			timeoutMs: profile.timeoutMs,
			idleTimeoutMs: profile.idleTimeoutMs,
			tokensUsed: usage.outputTokens,
			turnsUsed,
			elapsedMs: Date.now() - startedAt,
		},
	};
}

function bestAvailableSummary(
	session: AgentSession | undefined,
	partialAssistantText: string,
	lastActivity: AgentTaskActivity | undefined,
	status: AgentTaskStatus,
	timeoutMessage: string | undefined,
): string {
	const finalized = session?.getLastAssistantText()?.trim();
	if (finalized) return finalized;
	const partial = partialAssistantText.trim();
	if (partial) return partial;
	if (lastActivity) {
		const target = lastActivity.targetPath ? ` · ${lastActivity.targetPath}` : "";
		return `No assistant text was finalized. Last activity: ${lastActivity.message}${target}.`;
	}
	if (status === "timed_out") {
		return `${timeoutMessage ?? `Agent timed out after ${MAX_AGENT_TIMEOUT_MS}ms`} before producing assistant text.`;
	}
	return "No summary returned by the child agent.";
}

type EffectiveAgentProfile = AgentProfile & { timeoutMs: number; idleTimeoutMs: number };
type AgentTimeoutKind = "idle" | "hard";

function mergeBudget(profile: AgentProfile, input: DelegateTaskInput): EffectiveAgentProfile {
	const requestBudget = input.budget;
	const minimum = (profileValue: number | undefined, requestValue: number | undefined): number | undefined => {
		if (profileValue === undefined) return requestValue;
		if (requestValue === undefined) return profileValue;
		return Math.min(profileValue, requestValue);
	};
	const profileHardTimeoutMs = profile.timeoutMs ?? MAX_AGENT_TIMEOUT_MS;
	const timeoutMs = Math.min(profileHardTimeoutMs, input.hardTimeoutMs ?? profileHardTimeoutMs);
	const profileIdleTimeoutMs = profile.idleTimeoutMs ?? Math.min(DEFAULT_AGENT_IDLE_TIMEOUT_MS, timeoutMs);
	const idleTimeoutMs = Math.min(profileIdleTimeoutMs, requestBudget?.timeoutMs ?? profileIdleTimeoutMs, timeoutMs);
	return {
		...profile,
		maxTokens: minimum(profile.maxTokens, requestBudget?.maxTokens),
		maxTurns: minimum(profile.maxTurns, requestBudget?.maxTurns),
		timeoutMs,
		idleTimeoutMs,
		cancelStrategy: input.cancelStrategy ?? profile.cancelStrategy,
		allowFileModifications: input.allowFileModifications === false ? false : profile.allowFileModifications,
	};
}

function timeoutErrorMessage(profile: EffectiveAgentProfile, kind: AgentTimeoutKind): string {
	return kind === "idle"
		? `Agent had no activity for ${profile.idleTimeoutMs}ms before its ${profile.timeoutMs}ms hard limit`
		: `Agent reached its ${profile.timeoutMs}ms hard timeout`;
}

function getAllowedTools(
	profile: AgentProfile,
	customTools: readonly ToolDefinition[],
	resourceLoader: ResourceLoader,
): string[] {
	const configured = profile.toolAllowlist ?? [...DEFAULT_CHILD_TOOLS];
	const extensionTools = resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]);
	const known = new Set<string>([...allToolNames, ...customTools.map((tool) => tool.name), ...extensionTools]);
	// Unknown names are left out by AgentSession as well; keeping this filtering
	// here makes the child context deterministic and avoids provider-side schema noise.
	return configured.filter((name) => known.has(name) && !RESERVED_TOOL_NAMES.has(name));
}

function createPartialResult(progress: AgentProgressEvent): AgentToolResult<AgentProgressEvent> {
	return {
		content: [{ type: "text", text: progress.message }],
		details: progress,
	};
}

export class AgentPool {
	private readonly maxConcurrency: number;
	private readonly profiles: Map<string, AgentProfile>;
	private readonly defaultProfileId: string;
	private readonly dependencies: AgentPoolDependencies;
	private readonly customTools: readonly ToolDefinition[];
	private readonly eventListeners = new Set<AgentLifecycleEventListener>();
	private readonly waiters: SlotWaiter[] = [];
	private readonly activeTasks = new Map<string, { cancel: () => void }>();
	private activeCountValue = 0;
	private maxObservedConcurrencyValue = 0;
	private disposed = false;
	private readonly _delegateTaskTool: ToolDefinition<
		typeof DELEGATE_TASK_PARAMETERS,
		AgentTaskResult | AgentProgressEvent
	>;

	constructor(config: AgentPoolConfig, dependencies: AgentPoolDependencies) {
		const cpuConcurrencyLimit = calculateAgentConcurrencyLimit();
		this.maxConcurrency = Math.min(config.maxConcurrency ?? cpuConcurrencyLimit, cpuConcurrencyLimit);
		this.profiles = resolveAgentProfiles(config);
		this.defaultProfileId = config.defaultProfile ?? config.profiles?.[0]?.id ?? DEFAULT_AGENT_PROFILE.id;
		this.dependencies = dependencies;
		this.customTools = (dependencies.customTools ?? []).filter((tool) => !RESERVED_TOOL_NAMES.has(tool.name));
		this._delegateTaskTool = {
			name: "delegate_task",
			label: "Agent",
			description: "Run an isolated in-process sub-agent and return only a structured result.",
			promptSnippet: "delegate_task: delegate a bounded task to an isolated sub-agent",
			promptGuidelines: [
				"Never use delegate_task from a controlled sub-agent.",
				"Omit budget.timeoutMs for ordinary reviews; when provided it is a no-progress window, not the expected total task duration.",
				"When delegate_task returns clarificationRequest, resolve it from existing context or ask the user from the Coordinator; never fabricate a child answer.",
				"When delegate_task times out, use its partial summary and lastActivity instead of treating the result as empty.",
			],
			parameters: DELEGATE_TASK_PARAMETERS,
			executionMode: "parallel",
			execute: async (
				_toolCallId,
				params,
				signal,
				onUpdate,
			): Promise<AgentToolResult<AgentTaskResult | AgentProgressEvent>> => {
				return await this.executeDelegateTool(params, signal, onUpdate);
			},
			renderCall: (args, currentTheme) =>
				new Text(
					`${currentTheme.fg("toolTitle", currentTheme.bold(`Agent(${args.profile ?? this.defaultProfileId})`))}(${taskSummary(args.task)})`,
					0,
					0,
				),
			renderResult: (result, options, currentTheme) => {
				const details = result.details;
				if (options.expanded && isAgentTaskResult(details)) {
					const body = agentDetailBody(details);
					const statusLine = currentTheme.fg(agentStatusColor(details), agentBudgetSummary(details));
					return new Text(body ? `${statusLine}\n${currentTheme.fg("toolOutput", body)}` : statusLine, 0, 0);
				}
				const text = agentResultText(details);
				const rendered = isAgentTaskResult(details)
					? currentTheme.fg(agentStatusColor(details), text)
					: currentTheme.fg("muted", text);
				return new Text(
					`${rendered}${options.expanded ? "" : ` ${keyHint("app.tools.expand", "to expand")}`}`,
					0,
					0,
				);
			},
		};
	}

	get delegateTaskTool(): ToolDefinition {
		return this._delegateTaskTool as ToolDefinition;
	}

	get activeCount(): number {
		return this.activeCountValue;
	}

	get concurrencyLimit(): number {
		return this.maxConcurrency;
	}

	get maxObservedConcurrency(): number {
		return this.maxObservedConcurrencyValue;
	}

	hasProfile(profileId: string): boolean {
		return this.profiles.has(profileId);
	}

	getProfileIds(): string[] {
		return [...this.profiles.keys()];
	}

	/** Request cancellation for an active task without exposing child session state. */
	cancelTask(taskId: string): boolean {
		const task = this.activeTasks.get(taskId);
		if (!task) return false;
		task.cancel();
		return true;
	}

	subscribe(listener: AgentLifecycleEventListener): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	private emit(event: AgentLifecycleEvent): void {
		for (const listener of this.eventListeners) {
			try {
				listener(event);
			} catch {
				// Monitor consumers must not break child execution.
			}
		}
	}

	private claimSlot(): () => void {
		this.activeCountValue++;
		this.maxObservedConcurrencyValue = Math.max(this.maxObservedConcurrencyValue, this.activeCountValue);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.release();
		};
	}

	private async acquire(signal?: AbortSignal): Promise<() => void> {
		if (this.disposed) throw new Error("Agent pool is disposed");
		if (signal?.aborted) throw abortError();
		if (this.activeCountValue < this.maxConcurrency) return this.claimSlot();

		const release = await new Promise<() => void>((resolve, reject) => {
			let onAbort = (): void => {};
			const waiter: SlotWaiter = {
				resolve,
				reject,
				signal,
				cleanup: () => signal?.removeEventListener("abort", onAbort),
			};
			onAbort = (): void => {
				const index = this.waiters.indexOf(waiter);
				if (index !== -1) this.waiters.splice(index, 1);
				waiter.cleanup();
				reject(abortError());
			};
			this.waiters.push(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		if (this.disposed) {
			release();
			throw new Error("Agent pool is disposed");
		}
		if (signal?.aborted) {
			release();
			throw abortError();
		}
		return release;
	}

	private release(): void {
		this.activeCountValue = Math.max(0, this.activeCountValue - 1);
		while (this.activeCountValue < this.maxConcurrency && this.waiters.length > 0) {
			const waiter = this.waiters.shift()!;
			if (waiter.signal?.aborted) {
				waiter.cleanup();
				waiter.reject(abortError());
				continue;
			}
			waiter.cleanup();
			waiter.resolve(this.claimSlot());
			break;
		}
	}

	private async executeDelegateTool(
		params: DelegateTaskParameters,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<AgentTaskResult | AgentProgressEvent> | undefined,
	): Promise<AgentToolResult<AgentTaskResult | AgentProgressEvent>> {
		const result = await this.delegateTask(params, signal, (progress) => onUpdate?.(createPartialResult(progress)));
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
		};
	}

	async delegateTask(
		input: DelegateTaskInput,
		signal?: AbortSignal,
		onProgress?: AgentTaskProgressListener,
	): Promise<AgentTaskResult> {
		const taskId = randomUUID();
		const startedAt = Date.now();
		const profileId = input.profile ?? this.defaultProfileId;
		const configuredProfile = this.profiles.get(profileId);
		const profile = configuredProfile ?? DEFAULT_AGENT_PROFILE;
		this.emit({
			taskId,
			profile: profileId,
			taskSummary: taskSummary(input.task),
			timestamp: startedAt,
			type: "started",
			status: "starting",
		});

		if (!input.task.trim()) {
			const error = errorWithCode("invalid_task", "delegate_task requires a non-empty task");
			const result = createResultBase(
				taskId,
				profile,
				"failed",
				startedAt,
				{
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 0,
					cost: 0,
				},
				0,
				error,
			);
			this.emitTerminal(result, input.task);
			return result;
		}
		if (!configuredProfile) {
			const error = errorWithCode("profile_not_found", `Unknown agent profile ${JSON.stringify(profileId)}`);
			const result = createResultBase(
				taskId,
				profile,
				"failed",
				startedAt,
				{
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 0,
					cost: 0,
				},
				0,
				error,
			);
			result.profile = profileId;
			this.emitTerminal(result, input.task);
			return result;
		}

		const effectiveProfile = mergeBudget(configuredProfile, input);
		let executionStartedAt = startedAt;
		let executionStartedMonotonic: number | undefined;
		let lastActivityMonotonic = performance.now();
		let lastProgressMonotonic = lastActivityMonotonic;
		let release: (() => void) | undefined;
		let child: AgentSession | undefined;
		let unsubscribe: (() => void) | undefined;
		let hardTimeout: ReturnType<typeof setTimeout> | undefined;
		let idleTimeout: ReturnType<typeof setTimeout> | undefined;
		let timeoutKind: AgentTimeoutKind | undefined;
		let timedOut = false;
		let budgetExceeded = false;
		let cancellationRequested = false;
		let pendingGracefulCancellation = false;
		let activeTools = 0;
		let turns = 0;
		let outputTokens = 0;
		let partialAssistantText = "";
		let lastActivity: AgentTaskActivity | undefined;
		const activeToolActivities = new Map<string, { toolName: string; targetPath?: string }>();
		const diagnostics: string[] = [];
		const waitAbortController = new AbortController();
		const executionElapsedMs = (): number =>
			executionStartedMonotonic === undefined ? 0 : Math.max(0, performance.now() - executionStartedMonotonic);
		const stopForTimeout = (kind: AgentTimeoutKind): void => {
			if (timedOut) return;
			timedOut = true;
			pendingGracefulCancellation = false;
			timeoutKind = kind;
			if (child) {
				child.agent.abort();
				child.abortBash();
			} else {
				waitAbortController.abort();
			}
		};
		const armIdleTimeout = (): void => {
			if (
				idleTimeout ||
				timedOut ||
				cancellationRequested ||
				effectiveProfile.idleTimeoutMs >= effectiveProfile.timeoutMs
			) {
				return;
			}
			const checkIdle = (): void => {
				idleTimeout = undefined;
				if (timedOut || cancellationRequested) return;
				const remainingMs = effectiveProfile.idleTimeoutMs - (performance.now() - lastActivityMonotonic);
				if (remainingMs > 0) {
					idleTimeout = setTimeout(checkIdle, Math.max(1, Math.ceil(remainingMs)));
					return;
				}
				stopForTimeout("idle");
			};
			idleTimeout = setTimeout(checkIdle, effectiveProfile.idleTimeoutMs);
		};
		const resetIdleTimeout = (): void => {
			lastActivityMonotonic = performance.now();
			armIdleTimeout();
		};
		const progress = (event: AgentProgressEvent): void => {
			resetIdleTimeout();
			lastProgressMonotonic = performance.now();
			lastActivity = {
				turn: event.turn,
				toolName: event.toolName,
				targetPath: event.targetPath,
				outcome: event.outcome,
				message: event.message,
				timestamp: event.timestamp,
			};
			try {
				onProgress?.(event);
			} catch {
				// Progress observers are non-authoritative.
			}
			this.emit({
				taskId,
				profile: effectiveProfile.id,
				taskSummary: taskSummary(input.task),
				timestamp: event.timestamp,
				type: "progress",
				status: "running",
				turn: event.turn,
				toolName: event.toolName,
				targetPath: event.targetPath,
				outcome: event.outcome,
				message: event.message,
			});
		};
		const heartbeat = (message: string, activity?: { toolName: string; targetPath?: string }): void => {
			resetIdleTimeout();
			if (performance.now() - lastProgressMonotonic < AGENT_ACTIVITY_HEARTBEAT_MS) return;
			progress({
				taskId,
				profile: effectiveProfile.id,
				turn: turns,
				toolName: activity?.toolName,
				targetPath: activity?.targetPath,
				outcome: "started",
				message,
				timestamp: Date.now(),
			});
		};

		const cancelChild = (): void => {
			cancellationRequested = true;
			if (idleTimeout) clearTimeout(idleTimeout);
			if (!child) {
				waitAbortController.abort();
				return;
			}
			if (effectiveProfile.cancelStrategy === "graceful" && activeTools > 0) {
				pendingGracefulCancellation = true;
				return;
			}
			child.agent.abort();
			child.abortBash();
		};

		const onParentAbort = (): void => cancelChild();
		this.activeTasks.set(taskId, { cancel: cancelChild });
		signal?.addEventListener("abort", onParentAbort, { once: true });
		if (signal?.aborted) cancelChild();

		try {
			release = await this.acquire(waitAbortController.signal);
			executionStartedAt = Date.now();
			executionStartedMonotonic = performance.now();
			lastActivityMonotonic = executionStartedMonotonic;
			lastProgressMonotonic = executionStartedMonotonic;
			hardTimeout = setTimeout(() => stopForTimeout("hard"), effectiveProfile.timeoutMs);
			resetIdleTimeout();
			if (signal?.aborted || waitAbortController.signal.aborted) {
				if (timedOut) throw new Error(timeoutErrorMessage(effectiveProfile, timeoutKind ?? "hard"));
				throw abortError();
			}
			if (this.disposed) throw new Error("Agent pool is disposed");

			const allowedTools = getAllowedTools(effectiveProfile, this.customTools, this.dependencies.resourceLoader);
			const blockedByBoundary = effectiveProfile.allowFileModifications === false ? ["bash", "edit", "write"] : [];
			const toolAllowlist = allowedTools.filter((name) => !blockedByBoundary.includes(name));
			const controlledLoader = createControlledResourceLoader(this.dependencies.resourceLoader, effectiveProfile);
			const childCwd = input.cwd ?? this.dependencies.cwd;
			const childResult = await this.dependencies.createSession({
				cwd: childCwd,
				agentDir: this.dependencies.agentDir,
				model: this.dependencies.model,
				modelRuntime: this.dependencies.modelRuntime,
				resourceLoader: controlledLoader,
				sessionManager: SessionManager.inMemory(childCwd),
				settingsManager: SettingsManager.inMemory({
					compaction: { enabled: false },
					retry: { enabled: false },
					// In-memory child settings do not inherit the Coordinator timeout.
					httpIdleTimeoutMs: effectiveProfile.timeoutMs,
					policy: this.dependencies.policySettings ? structuredClone(this.dependencies.policySettings) : undefined,
				}),
				tools: toolAllowlist,
				excludeTools: [
					"delegate_task",
					"ask_user_question",
					"tasks_update",
					"privileged_exec",
					"workflow_run",
					"workflow_status",
					"workflow_cancel",
					"background_start",
					"background_attach",
					"background_status",
					"background_logs",
					"background_wait",
					"background_cancel",
				],
				customTools: this.customTools.filter((tool) => tool.name !== "privileged_exec"),
				searchRuntime: this.dependencies.searchRuntime,
				searchBudgetScopeId: this.dependencies.searchBudgetScopeId,
				synchronizeSearchBudget: false,
				policyInteractionMode: "controlled",
				dynamicTasks: false,
				agentPool: false,
			});
			child = childResult.session;
			if (timedOut) {
				child.agent.abort();
				child.abortBash();
				throw new Error("Agent timed out");
			}
			if (signal?.aborted) {
				cancelChild();
				throw abortError();
			}
			if (effectiveProfile.maxTokens !== undefined) {
				const originalStream = child.agent.streamFunction;
				child.agent.streamFunction = (model, context, options) => {
					const remaining = Math.max(1, effectiveProfile.maxTokens! - outputTokens);
					const maxTokens = options?.maxTokens === undefined ? remaining : Math.min(options.maxTokens, remaining);
					return originalStream(model, context, { ...options, maxTokens });
				};
			}
			const previousShouldStopAfterTurn = child.agent.shouldStopAfterTurn;
			child.agent.shouldStopAfterTurn = async (context, childSignal) => {
				if (await previousShouldStopAfterTurn?.(context, childSignal)) return true;
				const needsAnotherTurn =
					context.message.role === "assistant" &&
					(context.message.stopReason === "toolUse" || context.message.stopReason === "length");
				if (!needsAnotherTurn) return false;
				if (effectiveProfile.maxTurns !== undefined && turns >= effectiveProfile.maxTurns) {
					budgetExceeded = true;
					return true;
				}
				if (effectiveProfile.maxTokens !== undefined && outputTokens >= effectiveProfile.maxTokens) {
					budgetExceeded = true;
					return true;
				}
				return false;
			};

			const childEvents = (event: AgentSessionEvent): void => {
				if (event.type === "agent_start") {
					resetIdleTimeout();
					this.emit({
						taskId,
						profile: effectiveProfile.id,
						taskSummary: taskSummary(input.task),
						timestamp: Date.now(),
						type: "running",
						status: "running",
					});
					return;
				}
				if (event.type === "turn_start") {
					if (budgetExceeded || timedOut || cancellationRequested) return;
					turns++;
					const timestamp = Date.now();
					progress({
						taskId,
						profile: effectiveProfile.id,
						turn: turns,
						outcome: "started",
						message: `Turn ${turns} started`,
						timestamp,
					});
					return;
				}
				if (event.type === "message_update" && event.message.role === "assistant") {
					heartbeat("Assistant response streaming");
					const text = contentText(event.message.content).trim();
					if (text) partialAssistantText = text;
					return;
				}
				if (event.type === "message_end" && event.message.role === "assistant") {
					resetIdleTimeout();
					outputTokens += event.message.usage.output;
					const text = contentText(event.message.content).trim();
					if (text) partialAssistantText = text;
					return;
				}
				if (event.type === "tool_execution_start") {
					activeTools++;
					const targetPath = targetPathFromArgs(event.args);
					activeToolActivities.set(event.toolCallId, { toolName: event.toolName, targetPath });
					progress({
						taskId,
						profile: effectiveProfile.id,
						turn: turns,
						toolName: event.toolName,
						targetPath,
						outcome: "started",
						message: `Tool ${event.toolName} started`,
						timestamp: Date.now(),
					});
					return;
				}
				if (event.type === "tool_execution_update") {
					const activity = activeToolActivities.get(event.toolCallId);
					heartbeat(`Tool ${event.toolName} still running`, activity);
					return;
				}
				if (event.type === "tool_execution_end") {
					activeTools = Math.max(0, activeTools - 1);
					const activity = activeToolActivities.get(event.toolCallId);
					activeToolActivities.delete(event.toolCallId);
					if (event.isError) diagnostics.push(`Tool ${event.toolName} failed`);
					progress({
						taskId,
						profile: effectiveProfile.id,
						turn: turns,
						toolName: event.toolName,
						targetPath: activity?.targetPath,
						outcome: event.isError ? "failed" : "succeeded",
						message: `Tool ${event.toolName} ${event.isError ? "failed" : "completed"}`,
						timestamp: Date.now(),
					});
					if (pendingGracefulCancellation && activeTools === 0) {
						pendingGracefulCancellation = false;
						child?.agent.abort();
					}
				}
			};
			unsubscribe = child.subscribe(childEvents);
			if (signal?.aborted) cancelChild();
			await child.prompt(input.task, { resolveDocumentContract: false });
			const usage = usageFromSession(child);
			const assistant = lastAssistant(child);
			const snapshot = child.taskLedger.getSnapshot();
			const status: AgentTaskStatus = timedOut
				? "timed_out"
				: budgetExceeded
					? "failed"
					: cancellationRequested || assistant?.stopReason === "aborted"
						? "cancelled"
						: assistant?.stopReason === "error"
							? "failed"
							: "completed";
			const error = timedOut
				? errorWithCode("timed_out", timeoutErrorMessage(effectiveProfile, timeoutKind ?? "hard"))
				: budgetExceeded
					? errorWithCode("budget_exhausted", "Agent budget was exhausted before the task completed")
					: assistant?.stopReason === "error"
						? errorWithCode("provider_error", assistant.errorMessage ?? "Provider request failed")
						: status === "cancelled"
							? errorWithCode("cancelled", "Agent task was cancelled")
							: undefined;
			const result = createResultBase(taskId, effectiveProfile, status, executionStartedAt, usage, turns, error);
			result.summary = bestAvailableSummary(
				child,
				partialAssistantText,
				lastActivity,
				status,
				timedOut ? timeoutErrorMessage(effectiveProfile, timeoutKind ?? "hard") : undefined,
			);
			if (lastActivity) result.lastActivity = { ...lastActivity };
			const clarificationRequest = parseClarificationRequest(result.summary);
			if (clarificationRequest) result.clarificationRequest = clarificationRequest;
			result.citations = uniqueCitations([
				...(snapshot.documentContract?.sourceCitations ?? []),
				...snapshot.network.flatMap((record) => record.citations),
			]);
			result.references = unique([
				...snapshot.filesRead.map((file) => file.path),
				...result.citations.map(citationReference),
			]);
			result.filesModified = [...snapshot.filesModified];
			result.checks = makeChecks(child);
			result.diagnostics = [...diagnostics, ...controlledLoader.getSkills().diagnostics.map((item) => item.message)];
			result.budget = {
				maxTokens: effectiveProfile.maxTokens,
				maxTurns: effectiveProfile.maxTurns,
				timeoutMs: effectiveProfile.timeoutMs,
				idleTimeoutMs: effectiveProfile.idleTimeoutMs,
				tokensUsed: usage.outputTokens,
				turnsUsed: turns,
				elapsedMs: executionElapsedMs(),
			};
			this.emitTerminal(result, input.task);
			return result;
		} catch (error) {
			const usage = child ? usageFromSession(child) : emptyUsage();
			const status: AgentTaskStatus = timedOut
				? "timed_out"
				: signal?.aborted || cancellationRequested
					? "cancelled"
					: "failed";
			const resultError =
				status === "timed_out"
					? errorWithCode("timed_out", timeoutErrorMessage(effectiveProfile, timeoutKind ?? "hard"))
					: status === "cancelled"
						? errorWithCode("cancelled", "Agent task was cancelled")
						: errorWithCode("agent_error", asErrorMessage(error));
			const result = createResultBase(
				taskId,
				effectiveProfile,
				status,
				executionStartedAt,
				usage,
				turns,
				resultError,
			);
			result.budget.elapsedMs = executionElapsedMs();
			result.summary = bestAvailableSummary(
				child,
				partialAssistantText,
				lastActivity,
				status,
				timedOut ? timeoutErrorMessage(effectiveProfile, timeoutKind ?? "hard") : undefined,
			);
			result.diagnostics = [...diagnostics];
			if (lastActivity) result.lastActivity = { ...lastActivity };
			this.emitTerminal(result, input.task);
			return result;
		} finally {
			if (hardTimeout) clearTimeout(hardTimeout);
			if (idleTimeout) clearTimeout(idleTimeout);
			signal?.removeEventListener("abort", onParentAbort);
			unsubscribe?.();
			child?.dispose();
			this.activeTasks.delete(taskId);
			release?.();
		}
	}

	private emitTerminal(result: AgentTaskResult, task: string): void {
		this.emit({
			taskId: result.taskId,
			profile: result.profile,
			taskSummary: taskSummary(task),
			timestamp: Date.now(),
			type: result.status,
			status: result.status,
			budget: result.budget,
			lastActivity: result.lastActivity,
			error: result.error,
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const waiter of this.waiters.splice(0)) {
			waiter.cleanup();
			waiter.reject(new Error("Agent pool is disposed"));
		}
		for (const task of this.activeTasks.values()) {
			task.cancel();
		}
	}
}

function emptyUsage(): AgentTaskUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		cost: 0,
	};
}

function isWebCitation(citation: AgentTaskCitation): citation is WebCitation {
	return "kind" in citation && citation.kind === "web";
}

function citationReference(citation: AgentTaskCitation): string {
	return isWebCitation(citation) ? citation.url : citation.path;
}

function uniqueCitations(citations: readonly AgentTaskCitation[]): AgentTaskCitation[] {
	const seen = new Set<string>();
	const result: AgentTaskCitation[] = [];
	for (const citation of citations) {
		if (seen.has(citation.id)) continue;
		seen.add(citation.id);
		result.push(citation);
	}
	return result;
}
