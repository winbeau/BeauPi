import { createHash, randomUUID } from "node:crypto";
import type { SessionEntry, SessionManager } from "../session-manager.ts";
import { isExecutableDynamicTaskPrompt } from "./prompt-trigger.ts";
import {
	DYNAMIC_TASK_LIMITS,
	DynamicTaskValidationError,
	validateDynamicTaskPlan,
	validateTaskPatch,
	validateTasksUpdateInput,
} from "./schema.ts";
import type { TaskReviewer, TaskReviewLimits } from "./task-reviewer.ts";
import {
	DYNAMIC_TASK_REVIEW_ENTRY_TYPE,
	DYNAMIC_TASK_SNAPSHOT_ENTRY_TYPE,
	DYNAMIC_TASK_VERSION,
	type DynamicTaskDiagnosticV1,
	type DynamicTaskFactInputV1,
	type DynamicTaskFactStatus,
	type DynamicTaskFactV1,
	type DynamicTaskItemV1,
	type DynamicTaskMutationResultV1,
	type DynamicTaskNoticeV1,
	type DynamicTaskPlanV1,
	type DynamicTaskReviewEntryV1,
	type DynamicTaskSnapshotEntryV1,
	type TaskPatchV1,
	type TasksUpdateInputV1,
} from "./types.ts";

export interface DynamicTaskReviewLimits {
	minimumIntervalMs: number;
	timeoutMs: number;
	maxInputCharacters: number;
	maxOutputCharacters: number;
}

export const DEFAULT_TASK_REVIEW_LIMITS: Readonly<DynamicTaskReviewLimits> = Object.freeze({
	minimumIntervalMs: 15_000,
	timeoutMs: 20_000,
	maxInputCharacters: 16_000,
	maxOutputCharacters: 16_000,
});

export interface DynamicTaskRuntimeOptions {
	sessionManager: Pick<SessionManager, "getBranch" | "appendCustomEntry">;
	now?: () => number;
	planId?: () => string;
	reviewer?: TaskReviewer;
	reviewLimits?: Partial<DynamicTaskReviewLimits>;
	onNotification?: (notice: DynamicTaskNoticeV1) => void | Promise<void>;
}

type DynamicTaskListener = (snapshot: DynamicTaskPlanV1 | undefined) => void;

export interface DynamicTaskToolStartFact {
	toolCallId: string;
	toolName: string;
	args: unknown;
	workspaceMutation: boolean;
	verification: boolean;
	createdAt?: number;
}

export interface DynamicTaskToolFinishFact {
	toolCallId: string;
	toolName: string;
	status: "success" | "failed" | "cancelled";
	filesModified?: string[];
	verification: boolean;
	diagnostic?: string;
	createdAt?: number;
}

export interface DynamicTaskWorkflowFact {
	workflowId: string;
	nodeId: string;
	status: DynamicTaskFactStatus;
	summary: string;
	createdAt?: number;
}

export interface DynamicTaskBackgroundFact {
	taskId: string;
	status: DynamicTaskFactStatus;
	summary: string;
	eventId?: string;
	createdAt?: number;
}

export interface DynamicTaskMonitorFact {
	monitorId: string;
	status: DynamicTaskFactStatus;
	summary: string;
	createdAt?: number;
}

interface ActiveDynamicTool {
	toolName: string;
	taskId?: string;
	summary: string;
	verification: boolean;
}

function asUsage(value: unknown): DynamicTaskReviewEntryV1["usage"] {
	const usage = asRecord(value);
	const cost = asRecord(usage?.cost);
	if (
		!usage ||
		typeof usage.input !== "number" ||
		typeof usage.output !== "number" ||
		typeof usage.cacheRead !== "number" ||
		typeof usage.cacheWrite !== "number" ||
		typeof usage.totalTokens !== "number" ||
		!cost ||
		typeof cost.input !== "number" ||
		typeof cost.output !== "number" ||
		typeof cost.cacheRead !== "number" ||
		typeof cost.cacheWrite !== "number" ||
		typeof cost.total !== "number"
	) {
		return undefined;
	}
	return structuredClone(value as NonNullable<DynamicTaskReviewEntryV1["usage"]>);
}

export function getDynamicTaskReviewEntry(value: unknown): DynamicTaskReviewEntryV1 | undefined {
	const record = asRecord(value);
	if (
		record?.version !== DYNAMIC_TASK_VERSION ||
		typeof record.planId !== "string" ||
		typeof record.expectedRevision !== "number" ||
		typeof record.actualRevision !== "number" ||
		typeof record.factsHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(record.factsHash) ||
		typeof record.throughFactSequence !== "number" ||
		(record.status !== "completed" &&
			record.status !== "no_change" &&
			record.status !== "malformed" &&
			record.status !== "provider_failure" &&
			record.status !== "timed_out" &&
			record.status !== "aborted" &&
			record.status !== "revision_conflict" &&
			record.status !== "unavailable") ||
		typeof record.createdAt !== "number"
	) {
		return undefined;
	}
	const usage = record.usage === undefined ? undefined : asUsage(record.usage);
	if (record.usage !== undefined && usage === undefined) return undefined;
	return structuredClone({
		version: DYNAMIC_TASK_VERSION,
		planId: record.planId,
		expectedRevision: record.expectedRevision,
		actualRevision: record.actualRevision,
		factsHash: record.factsHash,
		throughFactSequence: record.throughFactSequence,
		status: record.status,
		createdAt: record.createdAt,
		model: typeof record.model === "string" ? record.model : undefined,
		usage,
		diagnostic: typeof record.diagnostic === "string" ? record.diagnostic : undefined,
	} satisfies DynamicTaskReviewEntryV1);
}

function diagnostic(error: unknown): DynamicTaskDiagnosticV1 {
	if (error instanceof DynamicTaskValidationError) {
		return { code: error.code, message: error.message, taskId: error.taskId };
	}
	return { code: "dynamic_task_error", message: error instanceof Error ? error.message : String(error) };
}

function mutationResult(
	status: DynamicTaskMutationResultV1["status"],
	expectedRevision: number,
	actualRevision: number,
	snapshot: DynamicTaskPlanV1 | undefined,
	diagnostics: DynamicTaskDiagnosticV1[] = [],
): DynamicTaskMutationResultV1 {
	return {
		version: DYNAMIC_TASK_VERSION,
		status,
		expectedRevision,
		actualRevision,
		snapshot: snapshot ? structuredClone(snapshot) : undefined,
		diagnostics,
	};
}

function stablePlanContent(plan: DynamicTaskPlanV1): string {
	return JSON.stringify({
		goal: plan.goal,
		tasks: plan.tasks.map((task) => ({
			id: task.id,
			title: task.title,
			status: task.status,
			dependsOn: task.dependsOn,
			matchHints: task.matchHints,
			activity: task.activity,
			evidence: task.evidence,
			blockedBy: task.blockedBy,
			completedAt: task.completedAt,
		})),
		facts: plan.facts,
		factSequence: plan.factSequence,
	});
}

function stablePlanStructure(plan: DynamicTaskPlanV1): string {
	return JSON.stringify({
		goal: plan.goal,
		tasks: plan.tasks.map((task) => ({
			id: task.id,
			title: task.title,
			dependsOn: task.dependsOn,
			matchHints: task.matchHints,
		})),
	});
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSnapshot(left: DynamicTaskPlanV1, right: DynamicTaskPlanV1): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function toolSummary(toolName: string, args: unknown): string {
	const record = asRecord(args);
	const value = record?.path ?? record?.file_path ?? record?.command ?? record?.task ?? record?.query;
	const detail = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
	return detail ? `${toolName}: ${detail}`.slice(0, DYNAMIC_TASK_LIMITS.maxFactSummaryLength) : toolName;
}

function matchTokens(value: string): Set<string> {
	return new Set(
		value
			.normalize("NFKC")
			.toLocaleLowerCase("en-US")
			.split(/[^\p{L}\p{N}_-]+/u)
			.map((token) => token.trim())
			.filter((token) => token.length >= 2),
	);
}

function verificationTask(task: DynamicTaskItemV1): boolean {
	return /\b(test|tests|verify|verification|check|lint|typecheck|build)\b|(?:测试|验证|检查|构建)/iu.test(
		`${task.title} ${task.matchHints.join(" ")}`,
	);
}

function taskMatchScore(task: DynamicTaskItemV1, summary: string, verification: boolean): number {
	let score = verificationTask(task) === verification ? 4 : -4;
	const target = summary.normalize("NFKC").toLocaleLowerCase("en-US");
	for (const hint of task.matchHints) {
		const normalizedHint = hint.normalize("NFKC").toLocaleLowerCase("en-US");
		if (normalizedHint && target.includes(normalizedHint)) score += 20;
	}
	const targetTokens = matchTokens(target);
	for (const token of matchTokens(`${task.title} ${task.matchHints.join(" ")}`)) {
		if (targetTokens.has(token)) score += 2;
	}
	return score;
}

function taskReady(task: DynamicTaskItemV1, tasks: readonly DynamicTaskItemV1[]): boolean {
	return task.dependsOn.every(
		(dependency) => tasks.find((candidate) => candidate.id === dependency)?.status === "completed",
	);
}

function selectTask(
	plan: DynamicTaskPlanV1,
	summary: string,
	verification: boolean,
	statuses: readonly DynamicTaskItemV1["status"][],
): DynamicTaskItemV1 | undefined {
	const candidates = plan.tasks.filter((task) => statuses.includes(task.status) && taskReady(task, plan.tasks));
	const match = candidates
		.map((task, index) => ({ task, index, score: taskMatchScore(task, summary, verification) }))
		.sort((left, right) => right.score - left.score || left.index - right.index)[0];
	return match && match.score >= 6 ? match.task : undefined;
}

export function hashDynamicTaskFacts(facts: readonly DynamicTaskFactV1[]): string {
	return createHash("sha256")
		.update(
			JSON.stringify(
				facts.map((fact) => ({
					sequence: fact.sequence,
					id: fact.id,
					kind: fact.kind,
					ref: fact.ref,
					status: fact.status,
					summary: fact.summary,
					path: fact.path,
				})),
			),
		)
		.digest("hex");
}

function factId(prefix: string, ref: string): string {
	const raw = `${prefix}:${ref}`;
	if (raw.length <= DYNAMIC_TASK_LIMITS.maxFactIdLength) return raw;
	return `${prefix}:${createHash("sha256").update(ref).digest("hex")}`;
}

function mutationAfterDispose(snapshot: DynamicTaskPlanV1 | undefined): DynamicTaskMutationResultV1 {
	const revision = snapshot?.revision ?? 0;
	return mutationResult("invalid", revision, revision, snapshot, [
		{ code: "runtime_disposed", message: "Dynamic Task Runtime is disposed" },
	]);
}

function terminalExternalStatus(status: DynamicTaskFactStatus): DynamicTaskItemV1["status"] | undefined {
	if (status === "completed" || status === "passed") return "completed";
	if (status === "failed" || status === "cancelled" || status === "lost") return "failed";
	if (status === "blocked" || status === "stalled") return "blocked";
	return undefined;
}

function reviewerTransitionAllowed(from: DynamicTaskItemV1["status"], to: DynamicTaskItemV1["status"]): boolean {
	if (from === to) return true;
	if (from === "pending") return to === "active" || to === "failed" || to === "blocked";
	if (from === "active") return to === "completed" || to === "failed" || to === "blocked";
	if (from === "failed" || from === "blocked") return to === "active";
	return false;
}

function promptValue(value: string, maxCharacters: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= maxCharacters ? normalized : `${normalized.slice(0, Math.max(0, maxCharacters - 1))}…`;
}

export class DynamicTaskRuntime {
	private readonly sessionManager: DynamicTaskRuntimeOptions["sessionManager"];
	private readonly now: () => number;
	private readonly createPlanId: () => string;
	private readonly reviewer: TaskReviewer | undefined;
	private readonly reviewLimits: DynamicTaskReviewLimits;
	private readonly onNotification: DynamicTaskRuntimeOptions["onNotification"];
	private readonly listeners = new Set<DynamicTaskListener>();
	private writeQueue: Promise<void> = Promise.resolve();
	private snapshot: DynamicTaskPlanV1 | undefined;
	private readonly snapshotHistory = new Map<number, DynamicTaskPlanV1>();
	private readonly activeTools = new Map<string, ActiveDynamicTool>();
	private readonly reviewedRuns = new Set<number>();
	private lastReview: DynamicTaskReviewEntryV1 | undefined;
	private reviewController: AbortController | undefined;
	private reviewActive = false;
	private initialPlanRequired = false;
	private refreshReminder: string | undefined;
	private disposed = false;

	constructor(options: DynamicTaskRuntimeOptions) {
		this.sessionManager = options.sessionManager;
		this.now = options.now ?? (() => Date.now());
		this.createPlanId = options.planId ?? (() => `plan-${randomUUID()}`);
		this.reviewer = options.reviewer;
		this.reviewLimits = {
			minimumIntervalMs: Math.max(
				0,
				Math.floor(options.reviewLimits?.minimumIntervalMs ?? DEFAULT_TASK_REVIEW_LIMITS.minimumIntervalMs),
			),
			timeoutMs: Math.max(1, Math.floor(options.reviewLimits?.timeoutMs ?? DEFAULT_TASK_REVIEW_LIMITS.timeoutMs)),
			maxInputCharacters: Math.max(
				256,
				Math.floor(options.reviewLimits?.maxInputCharacters ?? DEFAULT_TASK_REVIEW_LIMITS.maxInputCharacters),
			),
			maxOutputCharacters: Math.max(
				256,
				Math.floor(options.reviewLimits?.maxOutputCharacters ?? DEFAULT_TASK_REVIEW_LIMITS.maxOutputCharacters),
			),
		};
		this.onNotification = options.onNotification;
		this.rebuild(options.sessionManager.getBranch());
	}

	getSnapshot(): DynamicTaskPlanV1 | undefined {
		return this.snapshot ? structuredClone(this.snapshot) : undefined;
	}

	beginUserPrompt(text: string): void {
		const executable = isExecutableDynamicTaskPrompt(text);
		if (!this.snapshot) {
			this.initialPlanRequired = executable;
			this.refreshReminder = undefined;
			return;
		}
		this.initialPlanRequired = false;
		if (executable) {
			this.refreshReminder =
				"The user supplied executable work while a Dynamic Task plan exists. Check whether scope, dependencies, blockers, or verification changed; call tasks_update(reason: plan_changed) only when needed.";
		}
	}

	setRefreshReminder(message: string): void {
		this.refreshReminder = message.trim() || undefined;
	}

	getPromptProjection(options: { consumeReminder?: boolean } = {}): string | undefined {
		if (!this.snapshot) {
			if (!this.initialPlanRequired) return undefined;
			return [
				'<dynamic_tasks required="initial_plan">',
				"This is an executable user task. In the existing first model turn, call tasks_update once with version 1, expectedRevision 0, and reason initial_plan before the first mutation.",
				"A coarse 3-7 Task plan is sufficient before read-only discovery. Use concise mid-level phase titles that retain one or two distinguishing domain nouns (for example PrivilegeRuntime, tmux, sudo, or TUI), normally around 15 Chinese characters or an equivalently short phrase. Avoid commands, paths, key sequences, and step-by-step details. This is a soft style target, not a validation limit.",
				"Do not expose JSON to the user and do not create one Task per file or command.",
				"</dynamic_tasks>",
			].join("\n");
		}
		const snapshot = this.snapshot;
		const completed = snapshot.tasks.filter((task) => task.status === "completed").length;
		const closingLines = [
			"Only the Coordinator may change Task structure. Keep Task titles as short mid-level phase labels with one or two distinguishing domain nouns (about 15 Chinese characters or an equivalently brief phrase), and use the projected revision for expectedRevision.",
			"</dynamic_tasks>",
		];
		const lines = [
			`<dynamic_tasks revision="${snapshot.revision}">`,
			`goal: ${promptValue(snapshot.goal, 300)}`,
			`progress: ${completed}/${snapshot.tasks.length} completed`,
		];
		for (const task of snapshot.tasks) {
			const dependencies =
				task.dependsOn.length > 0 ? ` · depends on ${promptValue(task.dependsOn.join(", "), 100)}` : "";
			const activity = task.activity ? ` · ${promptValue(task.activity, 140)}` : "";
			const evidence =
				task.evidence.length > 0
					? ` · evidence ${task.evidence
							.slice(-2)
							.map((id) => promptValue(id, 70))
							.join(", ")}`
					: "";
			const line = `- ${task.id} [${task.status}] ${promptValue(task.title, 140)}${dependencies}${activity}${evidence}`;
			const projected = [...lines, line, ...closingLines].join("\n");
			if (projected.length > 6_000) {
				lines.push(`- … ${snapshot.tasks.length - (lines.length - 3)} tasks omitted`);
				break;
			}
			lines.push(line);
		}
		if (this.refreshReminder) {
			const reminder = `reminder: ${promptValue(this.refreshReminder, 400)}`;
			if ([...lines, reminder, ...closingLines].join("\n").length <= 6_000) lines.push(reminder);
		}
		lines.push(...closingLines);
		if (options.consumeReminder) this.refreshReminder = undefined;
		return lines.join("\n");
	}

	async noteToolStarted(input: DynamicTaskToolStartFact): Promise<DynamicTaskMutationResultV1> {
		return await this.serial(() => {
			const snapshot = this.snapshot;
			if (this.disposed) return mutationAfterDispose(snapshot);
			const revision = snapshot?.revision ?? 0;
			if (!snapshot || input.toolName === "tasks_update") {
				return mutationResult("no_change", revision, revision, snapshot);
			}
			const id = factId("tool", `${input.toolCallId}:started`);
			if (snapshot.facts.some((fact) => fact.id === id)) {
				return mutationResult("no_change", revision, revision, snapshot);
			}
			const timestamp = input.createdAt ?? this.now();
			const summary = toolSummary(input.toolName, input.args);
			const selected =
				input.workspaceMutation || input.verification
					? selectTask(snapshot, summary, input.verification, ["active", "pending"])
					: selectTask(snapshot, summary, false, ["active"]);
			const fact: DynamicTaskFactV1 = {
				version: DYNAMIC_TASK_VERSION,
				sequence: snapshot.factSequence + 1,
				id,
				kind: "tool",
				ref: input.toolCallId,
				status: "started",
				summary: `${input.toolName} started${summary === input.toolName ? "" : ` · ${summary.slice(input.toolName.length + 2)}`}`,
				createdAt: timestamp,
			};
			const tasks = snapshot.tasks.map((task): DynamicTaskItemV1 => {
				if (task.id !== selected?.id) return structuredClone(task);
				return {
					...structuredClone(task),
					status: task.status === "pending" ? "active" : task.status,
					activity: fact.summary,
					evidence: unique([...task.evidence, fact.id]).slice(-DYNAMIC_TASK_LIMITS.maxEvidence),
					updatedAt: timestamp,
				};
			});
			const next = this.withFacts(snapshot, tasks, [fact], timestamp);
			this.activeTools.set(input.toolCallId, {
				toolName: input.toolName,
				taskId: selected?.id,
				summary,
				verification: input.verification,
			});
			if (input.workspaceMutation && selected) {
				this.refreshReminder = `Work started on ${selected.id}. Continue the mutation without waiting, then call tasks_update(reason: work_started or plan_changed) only if the plan needs a material refresh.`;
			}
			this.acceptSnapshot(next);
			return mutationResult("accepted", revision, next.revision, next);
		});
	}

	async noteToolFinished(input: DynamicTaskToolFinishFact): Promise<DynamicTaskMutationResultV1> {
		return await this.serial(() => {
			const snapshot = this.snapshot;
			if (this.disposed) return mutationAfterDispose(snapshot);
			const revision = snapshot?.revision ?? 0;
			if (!snapshot || input.toolName === "tasks_update") {
				this.activeTools.delete(input.toolCallId);
				return mutationResult("no_change", revision, revision, snapshot);
			}
			const timestamp = input.createdAt ?? this.now();
			const active = this.activeTools.get(input.toolCallId);
			this.activeTools.delete(input.toolCallId);
			const summary = active?.summary ?? input.toolName;
			const task =
				(active?.taskId ? snapshot.tasks.find((candidate) => candidate.id === active.taskId) : undefined) ??
				selectTask(snapshot, summary, input.verification, ["active", "pending"]);
			const candidates: Array<Omit<DynamicTaskFactV1, "sequence">> = [];
			const finalStatus = input.status === "success" ? "succeeded" : input.status;
			candidates.push({
				version: DYNAMIC_TASK_VERSION,
				id: factId("tool", `${input.toolCallId}:${input.status}`),
				kind: input.status === "success" ? "tool" : "failure",
				ref: input.toolCallId,
				status: finalStatus,
				summary:
					input.status === "success"
						? `${input.toolName} completed`
						: `${input.toolName} ${input.status}${input.diagnostic ? ` · ${input.diagnostic}` : ""}`,
				createdAt: timestamp,
			});
			for (const path of unique(input.filesModified ?? [])) {
				candidates.push({
					version: DYNAMIC_TASK_VERSION,
					id: factId("file", `${input.toolCallId}:${path}`),
					kind: "file",
					ref: input.toolCallId,
					status: input.status === "success" ? "succeeded" : input.status,
					summary: `${input.status === "success" ? "Modified" : "Failed to modify"} ${path}`,
					path,
					createdAt: timestamp,
				});
			}
			if (input.verification) {
				candidates.push({
					version: DYNAMIC_TASK_VERSION,
					id: factId("verify", `${input.toolCallId}:${input.status === "success" ? "passed" : input.status}`),
					kind: "verification",
					ref: input.toolCallId,
					status: input.status === "success" ? "passed" : input.status,
					summary: `Verification ${input.status === "success" ? "passed" : input.status}`,
					createdAt: timestamp,
				});
			}
			const existingIds = new Set(snapshot.facts.map((fact) => fact.id));
			const facts: DynamicTaskFactV1[] = candidates
				.filter((fact) => !existingIds.has(fact.id))
				.map((fact, index) => ({ ...fact, sequence: snapshot.factSequence + index + 1 }));
			if (facts.length === 0) return mutationResult("no_change", revision, revision, snapshot);
			const evidenceIds = facts.map((fact) => fact.id);
			const tasks = snapshot.tasks.map((item): DynamicTaskItemV1 => {
				if (item.id !== task?.id) return structuredClone(item);
				const status = input.verification ? (input.status === "success" ? "completed" : "failed") : item.status;
				return {
					...structuredClone(item),
					status,
					activity: facts.at(-1)?.summary ?? item.activity,
					evidence: unique([...item.evidence, ...evidenceIds]).slice(-DYNAMIC_TASK_LIMITS.maxEvidence),
					updatedAt: timestamp,
					completedAt: status === "completed" ? timestamp : undefined,
				};
			});
			const next = this.withFacts(snapshot, tasks, facts, timestamp);
			this.acceptSnapshot(next);
			return mutationResult("accepted", revision, next.revision, next);
		});
	}

	async noteWorkflow(input: DynamicTaskWorkflowFact): Promise<DynamicTaskMutationResultV1> {
		return await this.recordFact({
			id: factId("workflow", `${input.workflowId}:${input.nodeId}:${input.status}`),
			kind: "workflow",
			ref: `${input.workflowId}:${input.nodeId}`,
			status: input.status,
			summary: input.summary,
			createdAt: input.createdAt,
		});
	}

	async noteBackground(input: DynamicTaskBackgroundFact): Promise<DynamicTaskMutationResultV1> {
		return await this.recordFact({
			id: factId("background", `${input.taskId}:${input.eventId ?? input.status}`),
			kind: "background",
			ref: input.taskId,
			status: input.status,
			summary: input.summary,
			createdAt: input.createdAt,
		});
	}

	async noteMonitor(input: DynamicTaskMonitorFact): Promise<DynamicTaskMutationResultV1> {
		return await this.recordFact({
			id: factId("monitor", `${input.monitorId}:${input.status}`),
			kind: "monitor",
			ref: input.monitorId,
			status: input.status,
			summary: input.summary,
			createdAt: input.createdAt,
		});
	}

	get isReviewing(): boolean {
		return this.reviewActive;
	}

	abortReview(): void {
		this.reviewController?.abort();
	}

	async reviewAfterSettled(runId: number, signal?: AbortSignal): Promise<DynamicTaskReviewEntryV1 | undefined> {
		if (this.disposed || !this.reviewer || this.reviewedRuns.has(runId)) return undefined;
		const snapshot = this.getSnapshot();
		if (!snapshot) return undefined;
		const throughFactSequence = this.lastReview?.throughFactSequence ?? 0;
		const newFacts = snapshot.facts.filter((fact) => fact.sequence > throughFactSequence);
		if (newFacts.length === 0) return undefined;
		const hash = hashDynamicTaskFacts(newFacts);
		if (hash === this.lastReview?.factsHash) return undefined;
		const now = this.now();
		if (this.lastReview && now - this.lastReview.createdAt < this.reviewLimits.minimumIntervalMs) return undefined;
		this.reviewedRuns.add(runId);
		const controller = new AbortController();
		this.reviewController = controller;
		this.reviewActive = true;
		const onAbort = (): void => controller.abort();
		if (signal?.aborted) controller.abort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		let status: DynamicTaskReviewEntryV1["status"] = "provider_failure";
		let actualRevision = snapshot.revision;
		let model: string | undefined;
		let usage: DynamicTaskReviewEntryV1["usage"];
		let reviewDiagnostic: string | undefined;
		try {
			const limits: TaskReviewLimits = {
				timeoutMs: this.reviewLimits.timeoutMs,
				maxInputCharacters: this.reviewLimits.maxInputCharacters,
				maxOutputCharacters: this.reviewLimits.maxOutputCharacters,
			};
			const result = await this.reviewer.review(
				{
					snapshot,
					expectedRevision: snapshot.revision,
					factsHash: hash,
					lastReviewedFactsHash: this.lastReview?.factsHash,
					facts: newFacts,
					trigger: "agent_settled",
					limits,
				},
				controller.signal,
			);
			model = result.model;
			usage = result.usage;
			reviewDiagnostic = result.error;
			if (result.status === "completed" && result.patch) {
				const applied = await this.applyReviewerPatch(result.patch);
				actualRevision = applied.actualRevision;
				status =
					applied.status === "accepted"
						? "completed"
						: applied.status === "no_change"
							? "no_change"
							: applied.status === "revision_conflict"
								? "revision_conflict"
								: "malformed";
				if (applied.status === "invalid") {
					reviewDiagnostic = applied.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ");
				}
				if (status === "revision_conflict") {
					await this.notify({
						version: DYNAMIC_TASK_VERSION,
						kind: "revision_conflict",
						revision: actualRevision,
						message: `Task review for revision ${snapshot.revision} was discarded because the current revision is ${actualRevision}. Re-read the projected snapshot before replanning.`,
					});
				}
				const attention =
					this.snapshot?.tasks.filter((task) => task.status === "blocked" || task.status === "failed") ?? [];
				if (status === "completed" && attention.length > 0) {
					await this.notify({
						version: DYNAMIC_TASK_VERSION,
						kind: "blocked",
						revision: actualRevision,
						message: `Dynamic Tasks need attention: ${attention.map((task) => `${task.id} (${task.status})`).join(", ")}. Refresh the plan or resolve the blocker before continuing.`,
					});
				}
			} else {
				status =
					result.status === "skipped"
						? "no_change"
						: result.status === "unavailable"
							? "unavailable"
							: result.status === "malformed"
								? "malformed"
								: result.status === "timed_out"
									? "timed_out"
									: result.status === "aborted"
										? "aborted"
										: "provider_failure";
			}
		} catch (error) {
			status = controller.signal.aborted ? "aborted" : "provider_failure";
			reviewDiagnostic = error instanceof Error ? error.message : String(error);
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (this.reviewController === controller) this.reviewController = undefined;
			this.reviewActive = false;
		}
		if (this.disposed) return undefined;
		const entry: DynamicTaskReviewEntryV1 = {
			version: DYNAMIC_TASK_VERSION,
			planId: snapshot.planId,
			expectedRevision: snapshot.revision,
			actualRevision,
			factsHash: hash,
			throughFactSequence: newFacts.at(-1)?.sequence ?? throughFactSequence,
			status,
			createdAt: this.now(),
			model,
			usage,
			diagnostic: reviewDiagnostic?.slice(0, 2_000),
		};
		this.lastReview = structuredClone(entry);
		this.sessionManager.appendCustomEntry(DYNAMIC_TASK_REVIEW_ENTRY_TYPE, entry);
		return structuredClone(entry);
	}

	private async notify(notice: DynamicTaskNoticeV1): Promise<void> {
		try {
			await this.onNotification?.(structuredClone(notice));
		} catch {
			// Notifications are non-authoritative.
		}
	}

	subscribe(listener: DynamicTaskListener): () => void {
		this.listeners.add(listener);
		try {
			listener(this.getSnapshot());
		} catch {
			// Projection observers are non-authoritative.
		}
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) {
			try {
				listener(snapshot);
			} catch {
				// Projection observers are non-authoritative.
			}
		}
	}

	private serial<T>(operation: () => Promise<T> | T): Promise<T> {
		const run = this.writeQueue.then(operation, operation);
		this.writeQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async updatePlan(value: unknown): Promise<DynamicTaskMutationResultV1> {
		return await this.serial(async () => {
			if (this.disposed) return mutationAfterDispose(this.snapshot);
			let input: TasksUpdateInputV1;
			try {
				input = validateTasksUpdateInput(value);
			} catch (error) {
				return mutationResult(
					"invalid",
					typeof (value as { expectedRevision?: unknown })?.expectedRevision === "number"
						? ((value as { expectedRevision: number }).expectedRevision ?? 0)
						: 0,
					this.snapshot?.revision ?? 0,
					this.snapshot,
					[diagnostic(error)],
				);
			}
			const actualRevision = this.snapshot?.revision ?? 0;
			let baseSnapshot = this.snapshot;
			const rebasing = input.expectedRevision !== actualRevision;
			if (rebasing) {
				const expectedSnapshot = this.snapshotHistory.get(input.expectedRevision);
				if (
					!this.snapshot ||
					!expectedSnapshot ||
					expectedSnapshot.planId !== this.snapshot.planId ||
					stablePlanStructure(expectedSnapshot) !== stablePlanStructure(this.snapshot)
				) {
					return mutationResult("revision_conflict", input.expectedRevision, actualRevision, this.snapshot, [
						{
							code: "revision_conflict",
							message: `Dynamic Task structure changed after revision ${input.expectedRevision}; current revision is ${actualRevision}`,
						},
					]);
				}
				baseSnapshot = expectedSnapshot;
			}
			if (!this.snapshot && input.reason !== "initial_plan") {
				return mutationResult("invalid", input.expectedRevision, actualRevision, undefined, [
					{
						code: "initial_plan_required",
						message: "Create the first Dynamic Task plan with reason initial_plan",
					},
				]);
			}
			if (this.snapshot && input.reason === "initial_plan") {
				return mutationResult("invalid", input.expectedRevision, actualRevision, this.snapshot, [
					{ code: "plan_exists", message: "initial_plan cannot replace an existing Dynamic Task plan" },
				]);
			}

			const timestamp = this.now();
			const previousById = new Map(this.snapshot?.tasks.map((task) => [task.id, task]) ?? []);
			const baseById = new Map(baseSnapshot?.tasks.map((task) => [task.id, task]) ?? []);
			const tasks: DynamicTaskItemV1[] = input.tasks.map((task) => {
				const previous = previousById.get(task.id);
				const base = baseById.get(task.id);
				const status = rebasing && previous && base && task.status === base.status ? previous.status : task.status;
				const activity =
					rebasing && previous && base && task.activity !== undefined && task.activity === base.activity
						? previous.activity
						: (task.activity ?? previous?.activity);
				const blockedBy =
					task.blockedBy !== undefined
						? rebasing && previous && base && sameStrings(task.blockedBy, base.blockedBy)
							? previous.blockedBy
							: task.blockedBy
						: previous?.status === status
							? previous.blockedBy
							: [];
				const completedAt =
					status === "completed"
						? previous?.status === "completed"
							? previous.completedAt
							: timestamp
						: undefined;
				return {
					id: task.id,
					title: task.title,
					status,
					dependsOn: [...(task.dependsOn ?? [])],
					matchHints: [...(task.matchHints ?? [])],
					activity,
					evidence: [...(previous?.evidence ?? [])],
					blockedBy: [...blockedBy],
					createdAt: previous?.createdAt ?? timestamp,
					updatedAt: timestamp,
					completedAt,
				};
			});
			const next: DynamicTaskPlanV1 = {
				version: DYNAMIC_TASK_VERSION,
				planId: this.snapshot?.planId ?? this.createPlanId(),
				revision: actualRevision + 1,
				goal: input.goal,
				createdAt: this.snapshot?.createdAt ?? timestamp,
				updatedAt: timestamp,
				factSequence: this.snapshot?.factSequence ?? 0,
				tasks,
				facts: structuredClone(this.snapshot?.facts ?? []),
			};
			try {
				validateDynamicTaskPlan(next);
			} catch (error) {
				return mutationResult("invalid", input.expectedRevision, actualRevision, this.snapshot, [
					diagnostic(error),
				]);
			}
			if (this.snapshot && stablePlanContent(next) === stablePlanContent(this.snapshot)) {
				return mutationResult("no_change", input.expectedRevision, actualRevision, this.snapshot);
			}
			this.acceptSnapshot(next);
			this.initialPlanRequired = false;
			if (input.reason === "initial_plan" || input.reason === "plan_changed" || input.reason === "blocked") {
				this.refreshReminder = undefined;
			}
			const attention = next.tasks.filter((task) => task.status === "blocked" || task.status === "failed");
			if (attention.length > 0) {
				await this.notify({
					version: DYNAMIC_TASK_VERSION,
					kind: "blocked",
					revision: next.revision,
					message: `Dynamic Tasks need attention: ${attention.map((task) => `${task.id} (${task.status})`).join(", ")}. Resolve the blocker or refresh the plan before continuing.`,
				});
			}
			return mutationResult("accepted", input.expectedRevision, next.revision, next);
		});
	}

	async applyReviewerPatch(value: unknown): Promise<DynamicTaskMutationResultV1> {
		return await this.serial(() => {
			if (this.disposed) return mutationAfterDispose(this.snapshot);
			let patch: TaskPatchV1;
			try {
				patch = validateTaskPatch(value);
			} catch (error) {
				return mutationResult(
					"invalid",
					typeof (value as { expectedRevision?: unknown })?.expectedRevision === "number"
						? (value as { expectedRevision: number }).expectedRevision
						: 0,
					this.snapshot?.revision ?? 0,
					this.snapshot,
					[diagnostic(error)],
				);
			}
			const snapshot = this.snapshot;
			const actualRevision = snapshot?.revision ?? 0;
			if (!snapshot) {
				return mutationResult("invalid", patch.expectedRevision, actualRevision, undefined, [
					{ code: "plan_missing", message: "Cannot apply a Task patch without a Dynamic Task plan" },
				]);
			}
			if (patch.expectedRevision !== actualRevision) {
				return mutationResult("revision_conflict", patch.expectedRevision, actualRevision, snapshot, [
					{
						code: "revision_conflict",
						message: `Expected Dynamic Task revision ${patch.expectedRevision}, current revision is ${actualRevision}`,
					},
				]);
			}
			const eligibleFacts = snapshot.facts.filter(
				(fact) => fact.sequence > (this.lastReview?.throughFactSequence ?? 0),
			);
			const expectedFactsHash = hashDynamicTaskFacts(eligibleFacts);
			if (eligibleFacts.length === 0 || patch.factsHash !== expectedFactsHash) {
				return mutationResult("invalid", patch.expectedRevision, actualRevision, snapshot, [
					{
						code: "facts_hash_mismatch",
						message: "Reviewer patch factsHash does not match the current unreviewed Dynamic Task facts",
					},
				]);
			}
			const eligibleFactIds = new Set(eligibleFacts.map((fact) => fact.id));
			const factIds = new Set(snapshot.facts.map((fact) => fact.id));
			const updates = new Map(patch.updates.map((update) => [update.id, update]));
			for (const update of patch.updates) {
				const task = snapshot.tasks.find((candidate) => candidate.id === update.id);
				if (!task) {
					return mutationResult("invalid", patch.expectedRevision, actualRevision, snapshot, [
						{
							code: "task_not_found",
							message: `Unknown Dynamic Task ${JSON.stringify(update.id)}`,
							taskId: update.id,
						},
					]);
				}
				const nextStatus = update.status ?? task.status;
				if (!reviewerTransitionAllowed(task.status, nextStatus)) {
					return mutationResult("invalid", patch.expectedRevision, actualRevision, snapshot, [
						{
							code: "reviewer_transition_forbidden",
							message: `Reviewer cannot transition Task ${JSON.stringify(update.id)} from ${task.status} to ${nextStatus}`,
							taskId: update.id,
						},
					]);
				}
				for (const evidence of update.evidence ?? []) {
					if (!factIds.has(evidence)) {
						return mutationResult("invalid", patch.expectedRevision, actualRevision, snapshot, [
							{
								code: "unknown_evidence",
								message: `Reviewer patch references unknown evidence ${JSON.stringify(evidence)}`,
								taskId: update.id,
							},
						]);
					}
				}
				const hasNewEvidence = (update.evidence ?? []).some((evidence) => eligibleFactIds.has(evidence));
				if (nextStatus === "completed" && !hasNewEvidence) {
					return mutationResult("invalid", patch.expectedRevision, actualRevision, snapshot, [
						{
							code: "completion_new_evidence_required",
							message: `Reviewer completion for ${JSON.stringify(update.id)} requires evidence from the current review facts`,
							taskId: update.id,
						},
					]);
				}
				if ((task.status === "failed" || task.status === "blocked") && nextStatus === "active" && !hasNewEvidence) {
					return mutationResult("invalid", patch.expectedRevision, actualRevision, snapshot, [
						{
							code: "reactivation_new_evidence_required",
							message: `Reviewer reactivation for ${JSON.stringify(update.id)} requires evidence from the current review facts`,
							taskId: update.id,
						},
					]);
				}
			}
			const timestamp = this.now();
			const tasks = snapshot.tasks.map((task): DynamicTaskItemV1 => {
				const update = updates.get(task.id);
				if (!update) return structuredClone(task);
				const status = update.status ?? task.status;
				const evidence = unique([...task.evidence, ...(update.evidence ?? [])]);
				const blockedBy = update.blockedBy ?? task.blockedBy;
				if (status === "blocked" && blockedBy.length === 0) {
					throw new DynamicTaskValidationError(
						"blocked_reason_required",
						`Reviewer blocked status for ${JSON.stringify(task.id)} requires blockedBy`,
						task.id,
					);
				}
				return {
					...structuredClone(task),
					status,
					activity: update.activity ?? task.activity,
					evidence,
					blockedBy:
						status === "blocked" ? [...blockedBy] : update.blockedBy ? [...update.blockedBy] : task.blockedBy,
					updatedAt: timestamp,
					completedAt:
						status === "completed" ? (task.status === "completed" ? task.completedAt : timestamp) : undefined,
				};
			});
			const next: DynamicTaskPlanV1 = {
				...structuredClone(snapshot),
				revision: snapshot.revision + 1,
				updatedAt: timestamp,
				tasks,
			};
			try {
				validateDynamicTaskPlan(next);
			} catch (error) {
				return mutationResult("invalid", patch.expectedRevision, actualRevision, snapshot, [diagnostic(error)]);
			}
			if (stablePlanContent(next) === stablePlanContent(snapshot)) {
				return mutationResult("no_change", patch.expectedRevision, actualRevision, snapshot);
			}
			this.acceptSnapshot(next);
			return mutationResult("accepted", patch.expectedRevision, next.revision, next);
		}).catch((error) =>
			mutationResult(
				"invalid",
				typeof (value as { expectedRevision?: unknown })?.expectedRevision === "number"
					? (value as { expectedRevision: number }).expectedRevision
					: 0,
				this.snapshot?.revision ?? 0,
				this.snapshot,
				[diagnostic(error)],
			),
		);
	}

	async recordFact(input: DynamicTaskFactInputV1): Promise<DynamicTaskMutationResultV1> {
		return await this.serial(() => {
			const snapshot = this.snapshot;
			if (this.disposed) return mutationAfterDispose(snapshot);
			const actualRevision = snapshot?.revision ?? 0;
			if (!snapshot) return mutationResult("no_change", actualRevision, actualRevision, undefined);
			if (snapshot.facts.some((fact) => fact.id === input.id)) {
				return mutationResult("no_change", actualRevision, actualRevision, snapshot);
			}
			if (!input.id || !input.ref || !input.summary) {
				return mutationResult("invalid", actualRevision, actualRevision, snapshot, [
					{ code: "invalid_fact", message: "Dynamic Task facts require id, ref, and summary" },
				]);
			}
			if (input.taskId && !snapshot.tasks.some((task) => task.id === input.taskId)) {
				return mutationResult("invalid", actualRevision, actualRevision, snapshot, [
					{ code: "task_not_found", message: `Unknown Dynamic Task ${JSON.stringify(input.taskId)}` },
				]);
			}
			const timestamp = input.createdAt ?? this.now();
			const fact: DynamicTaskFactV1 = {
				version: DYNAMIC_TASK_VERSION,
				sequence: snapshot.factSequence + 1,
				id: input.id,
				kind: input.kind,
				ref: input.ref,
				status: input.status,
				summary: input.summary,
				path: input.path,
				createdAt: timestamp,
			};
			let facts = [...snapshot.facts, fact];
			if (facts.length > DYNAMIC_TASK_LIMITS.maxFacts) facts = facts.slice(-DYNAMIC_TASK_LIMITS.maxFacts);
			const retainedFactIds = new Set(facts.map((item) => item.id));
			const selected = input.taskId
				? snapshot.tasks.find((task) => task.id === input.taskId)
				: selectTask(
						snapshot,
						`${input.ref} ${input.summary}${input.path ? ` ${input.path}` : ""}`,
						input.kind === "verification",
						["active", "pending"],
					);
			const external = input.kind === "workflow" || input.kind === "background" || input.kind === "monitor";
			const tasks = snapshot.tasks.map((task): DynamicTaskItemV1 => {
				const evidence = task.evidence.filter((evidenceId) => retainedFactIds.has(evidenceId));
				if (task.id !== selected?.id) return { ...structuredClone(task), evidence };
				let status = task.status;
				let blockedBy = task.blockedBy;
				if (task.status !== "completed") {
					const terminalStatus = external ? terminalExternalStatus(input.status) : undefined;
					if (terminalStatus) {
						status = terminalStatus;
						blockedBy = terminalStatus === "blocked" ? [promptValue(input.summary, 240)] : [];
					} else if (task.status === "pending" && ["started", "running", "healthy"].includes(input.status)) {
						status = "active";
					}
				}
				return {
					...structuredClone(task),
					status,
					activity: input.summary,
					evidence: unique([...evidence, fact.id]).slice(-DYNAMIC_TASK_LIMITS.maxEvidence),
					blockedBy,
					updatedAt: timestamp,
					completedAt: status === "completed" ? (task.completedAt ?? timestamp) : undefined,
				};
			});
			const next: DynamicTaskPlanV1 = {
				...structuredClone(snapshot),
				revision: snapshot.revision + 1,
				updatedAt: timestamp,
				factSequence: fact.sequence,
				tasks,
				facts,
			};
			try {
				validateDynamicTaskPlan(next);
			} catch (error) {
				return mutationResult("invalid", actualRevision, actualRevision, snapshot, [diagnostic(error)]);
			}
			this.acceptSnapshot(next);
			return mutationResult("accepted", actualRevision, next.revision, next);
		});
	}

	rebuild(entries: readonly SessionEntry[] = this.sessionManager.getBranch()): void {
		if (this.disposed) return;
		let restored: DynamicTaskPlanV1 | undefined;
		this.snapshotHistory.clear();
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== DYNAMIC_TASK_SNAPSHOT_ENTRY_TYPE) continue;
			const data = entry.data;
			if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
			const record = data as Record<string, unknown>;
			if (record.version !== DYNAMIC_TASK_VERSION) continue;
			let candidate: DynamicTaskPlanV1;
			try {
				candidate = validateDynamicTaskPlan(record.snapshot);
			} catch {
				continue;
			}
			const expectedRevision = (restored?.revision ?? 0) + 1;
			if (candidate.revision === restored?.revision && restored && sameSnapshot(candidate, restored)) continue;
			if (candidate.revision !== expectedRevision) continue;
			restored = candidate;
			this.snapshotHistory.set(candidate.revision, structuredClone(candidate));
		}
		this.snapshot = restored ? structuredClone(restored) : undefined;
		this.lastReview = undefined;
		if (restored) {
			for (const entry of entries) {
				if (entry.type !== "custom" || entry.customType !== DYNAMIC_TASK_REVIEW_ENTRY_TYPE) continue;
				const review = getDynamicTaskReviewEntry(entry.data);
				if (!review || review.planId !== restored.planId || review.throughFactSequence > restored.factSequence)
					continue;
				this.lastReview = review;
			}
		}
		this.activeTools.clear();
		this.reviewedRuns.clear();
		this.abortReview();
		this.initialPlanRequired = false;
		this.refreshReminder = undefined;
		this.emit();
	}

	private withFacts(
		snapshot: DynamicTaskPlanV1,
		tasks: DynamicTaskItemV1[],
		newFacts: DynamicTaskFactV1[],
		timestamp: number,
	): DynamicTaskPlanV1 {
		let facts = [...snapshot.facts, ...newFacts];
		if (facts.length > DYNAMIC_TASK_LIMITS.maxFacts) facts = facts.slice(-DYNAMIC_TASK_LIMITS.maxFacts);
		const retainedFactIds = new Set(facts.map((fact) => fact.id));
		const normalizedTasks = tasks.map((task) => ({
			...task,
			evidence: task.evidence.filter((evidence) => retainedFactIds.has(evidence)),
		}));
		const next: DynamicTaskPlanV1 = {
			...structuredClone(snapshot),
			revision: snapshot.revision + 1,
			updatedAt: timestamp,
			factSequence: newFacts.at(-1)?.sequence ?? snapshot.factSequence,
			tasks: normalizedTasks,
			facts,
		};
		validateDynamicTaskPlan(next);
		return next;
	}

	private acceptSnapshot(snapshot: DynamicTaskPlanV1): void {
		if (this.disposed) return;
		this.snapshot = structuredClone(snapshot);
		this.snapshotHistory.set(snapshot.revision, structuredClone(snapshot));
		const entry: DynamicTaskSnapshotEntryV1 = {
			version: DYNAMIC_TASK_VERSION,
			snapshot: structuredClone(snapshot),
		};
		this.sessionManager.appendCustomEntry(DYNAMIC_TASK_SNAPSHOT_ENTRY_TYPE, entry);
		this.emit();
	}

	dispose(): void {
		this.disposed = true;
		this.abortReview();
		this.listeners.clear();
	}
}
