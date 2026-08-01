import type { Usage } from "@earendil-works/pi-ai";

export const DYNAMIC_TASK_VERSION = 1;
export const DYNAMIC_TASK_SNAPSHOT_ENTRY_TYPE = "beaupi.dynamic-task.snapshot";
export const DYNAMIC_TASK_REVIEW_ENTRY_TYPE = "beaupi.dynamic-task.review";
export const DYNAMIC_TASK_NOTICE_MESSAGE_TYPE = "beaupi.dynamic-task.notice";
export const DYNAMIC_TASK_DETAILS_KEY = "dynamicTask";

export type DynamicTaskStatus = "pending" | "active" | "completed" | "failed" | "blocked";
export type DynamicTaskUpdateReason = "initial_plan" | "work_started" | "plan_changed" | "blocked";
export type DynamicTaskFactKind = "tool" | "file" | "verification" | "workflow" | "background" | "monitor" | "failure";
export type DynamicTaskFactStatus =
	| "started"
	| "running"
	| "healthy"
	| "succeeded"
	| "passed"
	| "completed"
	| "failed"
	| "cancelled"
	| "blocked"
	| "stalled"
	| "lost";

export interface DynamicTaskFactV1 {
	version: typeof DYNAMIC_TASK_VERSION;
	sequence: number;
	id: string;
	kind: DynamicTaskFactKind;
	ref: string;
	status: DynamicTaskFactStatus;
	summary: string;
	path?: string;
	createdAt: number;
}

export interface DynamicTaskItemV1 {
	id: string;
	title: string;
	status: DynamicTaskStatus;
	dependsOn: string[];
	matchHints: string[];
	activity?: string;
	evidence: string[];
	blockedBy: string[];
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
}

export interface DynamicTaskPlanV1 {
	version: typeof DYNAMIC_TASK_VERSION;
	planId: string;
	revision: number;
	goal: string;
	createdAt: number;
	updatedAt: number;
	factSequence: number;
	tasks: DynamicTaskItemV1[];
	facts: DynamicTaskFactV1[];
}

export interface TasksUpdateTaskV1 {
	id: string;
	title: string;
	status: DynamicTaskStatus;
	dependsOn?: string[];
	matchHints?: string[];
	activity?: string;
	blockedBy?: string[];
}

export interface TasksUpdateInputV1 {
	version: typeof DYNAMIC_TASK_VERSION;
	expectedRevision: number;
	reason: DynamicTaskUpdateReason;
	goal: string;
	tasks: TasksUpdateTaskV1[];
}

export interface TaskPatchUpdateV1 {
	id: string;
	status?: DynamicTaskStatus;
	activity?: string;
	evidence?: string[];
	blockedBy?: string[];
}

export interface TaskPatchV1 {
	version: typeof DYNAMIC_TASK_VERSION;
	expectedRevision: number;
	factsHash: string;
	updates: TaskPatchUpdateV1[];
}

export interface DynamicTaskDiagnosticV1 {
	code: string;
	message: string;
	taskId?: string;
}

export type DynamicTaskMutationStatus = "accepted" | "no_change" | "revision_conflict" | "invalid";

export interface DynamicTaskMutationResultV1 {
	version: typeof DYNAMIC_TASK_VERSION;
	status: DynamicTaskMutationStatus;
	expectedRevision: number;
	actualRevision: number;
	snapshot?: DynamicTaskPlanV1;
	diagnostics: DynamicTaskDiagnosticV1[];
}

export interface DynamicTaskFactInputV1 {
	id: string;
	kind: DynamicTaskFactKind;
	ref: string;
	status: DynamicTaskFactStatus;
	summary: string;
	path?: string;
	taskId?: string;
	createdAt?: number;
}

export interface DynamicTaskSnapshotEntryV1 {
	version: typeof DYNAMIC_TASK_VERSION;
	snapshot: DynamicTaskPlanV1;
}

export type DynamicTaskReviewStatus =
	| "completed"
	| "no_change"
	| "malformed"
	| "provider_failure"
	| "timed_out"
	| "aborted"
	| "revision_conflict"
	| "unavailable";

export interface DynamicTaskReviewEntryV1 {
	version: typeof DYNAMIC_TASK_VERSION;
	planId: string;
	expectedRevision: number;
	actualRevision: number;
	factsHash: string;
	throughFactSequence: number;
	status: DynamicTaskReviewStatus;
	createdAt: number;
	model?: string;
	usage?: Usage;
	diagnostic?: string;
}

export interface DynamicTaskNoticeV1 {
	version: typeof DYNAMIC_TASK_VERSION;
	kind: "blocked" | "revision_conflict" | "replan";
	revision: number;
	message: string;
}

export interface DynamicTaskToolDetailsV1 {
	version: typeof DYNAMIC_TASK_VERSION;
	operation: "tasks_update";
	ok: boolean;
	reason: DynamicTaskUpdateReason;
	result: DynamicTaskMutationResultV1;
}
