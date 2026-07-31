import type { MonitorRecord, MonitorStatus, MonitorTarget } from "../monitor/index.ts";

export const BACKGROUND_DETAILS_VERSION = 1;
export const BACKGROUND_SESSION_ENTRY_TYPE = "beaupi.background.snapshot";
export const BACKGROUND_WAKE_MESSAGE_TYPE = "beaupi.background.wake";

export type BackgroundTriggerType =
	| "completed"
	| "failed"
	| "timeout"
	| "stalled"
	| "error-pattern"
	| "progress-review";

export type BackgroundWakeReason = BackgroundTriggerType;
export type BackgroundWakeState = "queued" | "delivered" | "consumed" | "cancelled";
export type ProgressReviewState = "progressing" | "stalled" | "failed" | "needs-user" | "completed";

export interface BackgroundTriggerV1 {
	version: typeof BACKGROUND_DETAILS_VERSION;
	id: string;
	type: BackgroundTriggerType;
	enabled: boolean;
	pattern?: string;
	flags?: string;
}

export interface BackgroundProgressReviewConfigV1 {
	version: typeof BACKGROUND_DETAILS_VERSION;
	enabled: boolean;
	minimumIntervalMs: number;
	maxReviews: number;
	maxInputCharacters: number;
	timeoutMs: number;
	maxOutputTokens: number;
}

export interface ProgressReviewV1 {
	version: typeof BACKGROUND_DETAILS_VERSION;
	state: ProgressReviewState;
	summary: string;
	shouldWakeCoordinator: boolean;
	suggestedAction?: string;
	reviewedAt: number;
	logHash: string;
}

export interface BackgroundTaskV1 {
	version: typeof BACKGROUND_DETAILS_VERSION;
	id: string;
	sessionId: string;
	monitorId: string;
	source: "started" | "attached";
	name: string;
	goal?: string;
	executable?: string;
	args: string[];
	cwd?: string;
	createdAt: number;
	waitRequestedAt?: number;
	triggers: BackgroundTriggerV1[];
	logCursor: number;
	logHash?: string;
	logPrefixHash?: string;
	lastLogActivityAt?: number;
	lastReviewAt?: number;
	reviewCount: number;
	lastReviewHash?: string;
	lastReviewSummary?: string;
	progressReview: BackgroundProgressReviewConfigV1;
	diagnostics: string[];
}

export interface BackgroundWakeLogV1 {
	cursor: number;
	hash: string;
	summary: string;
	logPath?: string;
	truncated: boolean;
	rotated: boolean;
}

export interface BackgroundWakeEventV1 {
	version: typeof BACKGROUND_DETAILS_VERSION;
	id: string;
	dedupeKey: string;
	taskId: string;
	monitorId: string;
	reason: BackgroundWakeReason;
	monitorStatus: MonitorStatus;
	createdAt: number;
	state: BackgroundWakeState;
	deliveredAt?: number;
	consumedAt?: number;
	log?: BackgroundWakeLogV1;
	diagnostic?: string;
	progressReview?: ProgressReviewV1;
}

export interface BackgroundStoreSnapshotV1 {
	version: typeof BACKGROUND_DETAILS_VERSION;
	sessionId: string;
	tasks: BackgroundTaskV1[];
	wakeEvents: BackgroundWakeEventV1[];
	consumedEventKeys: string[];
	updatedAt: number;
}

export interface BackgroundTaskSnapshotV1 extends BackgroundTaskV1 {
	status: MonitorStatus;
	monitor?: MonitorRecord;
	target?: MonitorTarget;
	wakeQueued: number;
	lastWakeReason?: BackgroundWakeReason;
}

export interface BackgroundRuntimeSnapshotV1 {
	version: typeof BACKGROUND_DETAILS_VERSION;
	tasks: BackgroundTaskSnapshotV1[];
	wakeEvents: BackgroundWakeEventV1[];
	summary: BackgroundSummaryV1;
}

export type BackgroundRuntimeListener = (snapshot: BackgroundRuntimeSnapshotV1) => void;

export interface BackgroundSummaryV1 {
	version: typeof BACKGROUND_DETAILS_VERSION;
	total: number;
	waiting: number;
	starting: number;
	running: number;
	stalled: number;
	completed: number;
	failed: number;
	cancelled: number;
	lost: number;
	wakeQueued: number;
}

export interface BackgroundLogResultV1 {
	mode: "tail" | "errors" | "summary" | "full";
	content: string;
	cursor: number;
	hash: string;
	changed: boolean;
	truncated: boolean;
	rotated: boolean;
	missing: boolean;
	logPath?: string;
	diagnostic?: string;
}

export interface BackgroundCancelResultV1 {
	accepted: boolean;
	reason: "cancel_requested" | "already_terminal" | "task_not_found" | "stop_rejected";
	forced: boolean;
}

export type BackgroundToolOperation =
	| "background_start"
	| "background_attach"
	| "background_status"
	| "background_logs"
	| "background_wait"
	| "background_cancel";

export interface BackgroundToolDetailsV1 {
	version: typeof BACKGROUND_DETAILS_VERSION;
	operation: BackgroundToolOperation;
	ok: boolean;
	task?: BackgroundTaskSnapshotV1;
	tasks?: BackgroundTaskSnapshotV1[];
	summary?: BackgroundSummaryV1;
	logs?: Omit<BackgroundLogResultV1, "content">;
	cancel?: BackgroundCancelResultV1;
	wakeEvents?: BackgroundWakeEventV1[];
	error?: { code: string; message: string };
}

export interface BackgroundWakeDeliveryV1 {
	version: typeof BACKGROUND_DETAILS_VERSION;
	eventIds: string[];
	events: BackgroundWakeEventV1[];
	tasks: BackgroundTaskSnapshotV1[];
}

export interface BackgroundWakeHost {
	isBusy(): boolean;
	hasPendingUserMessages(): boolean;
	deliver(delivery: BackgroundWakeDeliveryV1, mode: "trigger" | "followUp"): Promise<void>;
}

export interface BackgroundScheduler {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface ProgressReviewerInput {
	taskId: string;
	goal: string;
	previousSummary?: string;
	newLog: string;
	logHash: string;
	runtimeMs: number;
	resources?: MonitorRecord["resources"];
	config: BackgroundProgressReviewConfigV1;
}

export interface BackgroundProgressReviewer {
	review(input: ProgressReviewerInput, signal?: AbortSignal): Promise<ProgressReviewV1>;
}

export interface BackgroundStartInput {
	executable: string;
	args?: string[];
	cwd?: string;
	name?: string;
	goal?: string;
	timeoutMs?: number;
	stallTimeoutMs?: number;
	triggers?: BackgroundTriggerInput[];
	progressReview?: BackgroundProgressReviewInput;
}

export interface BackgroundAttachInput {
	monitorId: string;
	name?: string;
	goal?: string;
	triggers?: BackgroundTriggerInput[];
	progressReview?: BackgroundProgressReviewInput;
}

export interface BackgroundTriggerInput {
	type: BackgroundTriggerType;
	pattern?: string;
	flags?: string;
}

export interface BackgroundProgressReviewInput {
	enabled: boolean;
	minimumIntervalMs?: number;
	maxReviews?: number;
	maxInputCharacters?: number;
	timeoutMs?: number;
	maxOutputTokens?: number;
}
