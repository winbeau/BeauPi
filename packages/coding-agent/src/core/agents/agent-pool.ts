import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { AgentSession, AgentSessionEvent } from "../agent-session.ts";
import type { DocumentCitation } from "../documents/types.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import { POLICY_CONFIRM_VERSION, type PolicyConfirmRequest, type PolicySettings } from "../policy/index.ts";
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
	DEFAULT_AGENT_PROFILE,
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
	timeoutMs?: number;
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
	policyRequest?: PolicyConfirmRequest;
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
	resolve: () => void;
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
		timeoutMs?: number;
	};
	cancelStrategy?: AgentCancellationStrategy;
}

const DELEGATE_TASK_PARAMETERS = Type.Object({
	task: Type.String({ minLength: 1, description: "Self-contained task for the child agent" }),
	profile: Type.Optional(Type.String({ minLength: 1, description: "Agent profile id" })),
	budget: Type.Optional(
		Type.Object({
			maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
			maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
		}),
	),
	cancelStrategy: Type.Optional(Type.Union([Type.Literal("abort"), Type.Literal("graceful")])),
});

type DelegateTaskParameters = Static<typeof DELEGATE_TASK_PARAMETERS>;

const DEFAULT_CHILD_TOOLS = new Set(DEFAULT_AGENT_PROFILE.toolAllowlist ?? []);
const RESERVED_TOOL_NAMES = new Set(["delegate_task", "ask_user_question"]);

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
			tokensUsed: usage.outputTokens,
			turnsUsed,
			elapsedMs: Date.now() - startedAt,
		},
	};
}

function mergeBudget(profile: AgentProfile, input: DelegateTaskInput): AgentProfile {
	const requestBudget = input.budget;
	const minimum = (profileValue: number | undefined, requestValue: number | undefined): number | undefined => {
		if (profileValue === undefined) return requestValue;
		if (requestValue === undefined) return profileValue;
		return Math.min(profileValue, requestValue);
	};
	return {
		...profile,
		maxTokens: minimum(profile.maxTokens, requestBudget?.maxTokens),
		maxTurns: minimum(profile.maxTurns, requestBudget?.maxTurns),
		timeoutMs: minimum(profile.timeoutMs, requestBudget?.timeoutMs),
		cancelStrategy: input.cancelStrategy ?? profile.cancelStrategy,
	};
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
		this.maxConcurrency = config.maxConcurrency ?? 2;
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
				"When delegate_task returns clarificationRequest or policyRequest, resolve it from existing context or ask the user from the Coordinator; never fabricate a child answer.",
			],
			parameters: DELEGATE_TASK_PARAMETERS,
			executionMode: "sequential",
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
			renderResult: (result, _options, currentTheme) => {
				const details = result.details;
				const text = agentResultText(details);
				const color = isAgentTaskResult(details)
					? details.status === "completed"
						? "success"
						: details.status === "cancelled"
							? "muted"
							: "error"
					: "muted";
				return new Text(currentTheme.fg(color, text), 0, 0);
			},
		};
	}

	get delegateTaskTool(): ToolDefinition {
		return this._delegateTaskTool as ToolDefinition;
	}

	get activeCount(): number {
		return this.activeCountValue;
	}

	get maxObservedConcurrency(): number {
		return this.maxObservedConcurrencyValue;
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

	private async acquire(signal?: AbortSignal): Promise<() => void> {
		if (this.disposed) throw new Error("Agent pool is disposed");
		if (signal?.aborted) throw abortError();
		if (this.activeCountValue < this.maxConcurrency) {
			this.activeCountValue++;
			this.maxObservedConcurrencyValue = Math.max(this.maxObservedConcurrencyValue, this.activeCountValue);
			return () => this.release();
		}

		await new Promise<void>((resolve, reject) => {
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
		if (this.disposed) throw new Error("Agent pool is disposed");
		if (signal?.aborted) throw abortError();
		this.activeCountValue++;
		this.maxObservedConcurrencyValue = Math.max(this.maxObservedConcurrencyValue, this.activeCountValue);
		return () => this.release();
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
			waiter.resolve();
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
		let release: (() => void) | undefined;
		let child: AgentSession | undefined;
		let unsubscribe: (() => void) | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		let budgetExceeded = false;
		let cancellationRequested = false;
		let pendingGracefulCancellation = false;
		let activeTools = 0;
		let turns = 0;
		let outputTokens = 0;
		let lastActivity: AgentTaskActivity | undefined;
		const activeToolActivities = new Map<string, { toolName: string; targetPath?: string }>();
		const diagnostics: string[] = [];
		const progress = (event: AgentProgressEvent): void => {
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

		const waitAbortController = new AbortController();
		const cancelChild = (): void => {
			cancellationRequested = true;
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
		signal?.addEventListener("abort", onParentAbort, { once: true });
		if (signal?.aborted) cancelChild();
		if (effectiveProfile.timeoutMs !== undefined) {
			timeout = setTimeout(() => {
				timedOut = true;
				if (child) {
					child.agent.abort();
					child.abortBash();
				} else {
					waitAbortController.abort();
				}
			}, effectiveProfile.timeoutMs);
		}

		try {
			release = await this.acquire(waitAbortController.signal);
			if (signal?.aborted || waitAbortController.signal.aborted) {
				if (timedOut) throw new Error("Agent timed out");
				throw abortError();
			}
			if (this.disposed) throw new Error("Agent pool is disposed");

			const allowedTools = getAllowedTools(effectiveProfile, this.customTools, this.dependencies.resourceLoader);
			const blockedByBoundary = effectiveProfile.allowFileModifications === false ? ["bash", "edit", "write"] : [];
			const toolAllowlist = allowedTools.filter((name) => !blockedByBoundary.includes(name));
			const controlledLoader = createControlledResourceLoader(this.dependencies.resourceLoader, effectiveProfile);
			const childResult = await this.dependencies.createSession({
				cwd: this.dependencies.cwd,
				agentDir: this.dependencies.agentDir,
				model: this.dependencies.model,
				modelRuntime: this.dependencies.modelRuntime,
				resourceLoader: controlledLoader,
				sessionManager: SessionManager.inMemory(this.dependencies.cwd),
				settingsManager: SettingsManager.inMemory({
					compaction: { enabled: false },
					retry: { enabled: false },
					policy: this.dependencies.policySettings ? structuredClone(this.dependencies.policySettings) : undefined,
				}),
				tools: toolAllowlist,
				excludeTools: ["delegate_task", "ask_user_question"],
				customTools: [...this.customTools],
				searchRuntime: this.dependencies.searchRuntime,
				searchBudgetScopeId: this.dependencies.searchBudgetScopeId,
				synchronizeSearchBudget: false,
				policyInteractionMode: "controlled",
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
				if (event.type === "message_end" && event.message.role === "assistant") {
					outputTokens += event.message.usage.output;
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
			this.activeTasks.set(taskId, { cancel: cancelChild });
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
				? errorWithCode("timed_out", `Agent timed out after ${effectiveProfile.timeoutMs}ms`)
				: budgetExceeded
					? errorWithCode("budget_exhausted", "Agent budget was exhausted before the task completed")
					: assistant?.stopReason === "error"
						? errorWithCode("provider_error", assistant.errorMessage ?? "Provider request failed")
						: status === "cancelled"
							? errorWithCode("cancelled", "Agent task was cancelled")
							: undefined;
			const result = createResultBase(taskId, effectiveProfile, status, startedAt, usage, turns, error);
			result.summary = child.getLastAssistantText() ?? "No summary returned by the child agent.";
			if (lastActivity) result.lastActivity = { ...lastActivity };
			const clarificationRequest = parseClarificationRequest(result.summary);
			if (clarificationRequest) result.clarificationRequest = clarificationRequest;
			let policyFact: (typeof snapshot.policy)[number] | undefined;
			for (let index = snapshot.policy.length - 1; index >= 0; index--) {
				const fact = snapshot.policy[index];
				if (fact?.confirmation?.status === "interaction_required" && fact.status === "paused") {
					policyFact = fact;
					break;
				}
			}
			if (policyFact) {
				result.policyRequest = {
					version: POLICY_CONFIRM_VERSION,
					requestId: policyFact.requestId,
					toolCallId: policyFact.toolCallId,
					toolName: policyFact.operation.toolName,
					operation: policyFact.operation,
					reason: policyFact.decision.reason ?? "Policy confirmation is required.",
					suggestion: policyFact.decision.suggestion,
					createdAt: policyFact.createdAt,
				};
			}
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
				tokensUsed: usage.outputTokens,
				turnsUsed: turns,
				elapsedMs: Date.now() - startedAt,
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
			const result = createResultBase(
				taskId,
				effectiveProfile,
				status,
				startedAt,
				usage,
				turns,
				errorWithCode(status === "cancelled" ? "cancelled" : "agent_error", asErrorMessage(error)),
			);
			result.diagnostics = [...diagnostics];
			if (lastActivity) result.lastActivity = { ...lastActivity };
			this.emitTerminal(result, input.task);
			return result;
		} finally {
			if (timeout) clearTimeout(timeout);
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
