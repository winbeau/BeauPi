import { Compile } from "typebox/compile";
import type { SessionEntry } from "../session-manager.ts";
import {
	BACKGROUND_STORE_SNAPSHOT_SCHEMA,
	BACKGROUND_TASK_SCHEMA,
	PROGRESS_REVIEW_SCHEMA,
	WAKE_EVENT_SCHEMA,
} from "./schema.ts";
import {
	BACKGROUND_DETAILS_VERSION,
	BACKGROUND_SESSION_ENTRY_TYPE,
	type BackgroundStoreSnapshotV1,
	type BackgroundTaskSnapshotV1,
	type BackgroundToolDetailsV1,
	type BackgroundWakeEventV1,
} from "./types.ts";

const storeValidator = Compile(BACKGROUND_STORE_SNAPSHOT_SCHEMA);
const taskValidator = Compile(BACKGROUND_TASK_SCHEMA);
const wakeValidator = Compile(WAKE_EVENT_SCHEMA);
const reviewValidator = Compile(PROGRESS_REVIEW_SCHEMA);

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function parseTaskSnapshot(value: unknown): BackgroundTaskSnapshotV1 | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const { status, wakeQueued, lastWakeReason, monitor, target, ...task } = record;
	if (
		!taskValidator.Check(task) ||
		typeof status !== "string" ||
		typeof wakeQueued !== "number" ||
		!Number.isInteger(wakeQueued) ||
		wakeQueued < 0
	)
		return undefined;
	if (
		status !== "starting" &&
		status !== "running" &&
		status !== "healthy" &&
		status !== "stalled" &&
		status !== "completed" &&
		status !== "failed" &&
		status !== "cancelled" &&
		status !== "lost"
	) {
		return undefined;
	}
	if (lastWakeReason !== undefined && typeof lastWakeReason !== "string") return undefined;
	return clone({ ...task, status, wakeQueued, lastWakeReason, monitor, target } as BackgroundTaskSnapshotV1);
}

function parseWake(value: unknown): BackgroundWakeEventV1 | undefined {
	return wakeValidator.Check(value) ? clone(value as BackgroundWakeEventV1) : undefined;
}

export function parseBackgroundStore(value: unknown): BackgroundStoreSnapshotV1 | undefined {
	if (!storeValidator.Check(value)) return undefined;
	return clone(value as BackgroundStoreSnapshotV1);
}

export function backgroundStoreFromEntries(entries: readonly SessionEntry[]): BackgroundStoreSnapshotV1 | undefined {
	let latest: BackgroundStoreSnapshotV1 | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== BACKGROUND_SESSION_ENTRY_TYPE) continue;
		const parsed = parseBackgroundStore(entry.data);
		if (parsed) latest = parsed;
	}
	return latest;
}

export function getBackgroundToolDetails(details: unknown): BackgroundToolDetailsV1 | undefined {
	const record = asRecord(details);
	const background = asRecord(record?.background);
	if (!background || background.version !== BACKGROUND_DETAILS_VERSION || typeof background.operation !== "string")
		return undefined;
	const operations = new Set([
		"background_start",
		"background_attach",
		"background_status",
		"background_logs",
		"background_wait",
		"background_cancel",
	]);
	if (!operations.has(background.operation) || typeof background.ok !== "boolean") return undefined;
	const task = background.task === undefined ? undefined : parseTaskSnapshot(background.task);
	const tasks = Array.isArray(background.tasks)
		? background.tasks.map(parseTaskSnapshot).filter((item): item is BackgroundTaskSnapshotV1 => item !== undefined)
		: undefined;
	if (background.task !== undefined && !task) return undefined;
	if (Array.isArray(background.tasks) && tasks?.length !== background.tasks.length) return undefined;
	const wakeEvents = Array.isArray(background.wakeEvents)
		? background.wakeEvents.map(parseWake).filter((item): item is BackgroundWakeEventV1 => item !== undefined)
		: undefined;
	if (Array.isArray(background.wakeEvents) && wakeEvents?.length !== background.wakeEvents.length) return undefined;
	const summary = asRecord(background.summary);
	if (
		summary &&
		(summary.version !== 1 || typeof summary.total !== "number" || typeof summary.wakeQueued !== "number")
	)
		return undefined;
	const logs = asRecord(background.logs);
	if (logs && (typeof logs.mode !== "string" || typeof logs.cursor !== "number" || typeof logs.hash !== "string"))
		return undefined;
	const cancel = asRecord(background.cancel);
	if (cancel && (typeof cancel.accepted !== "boolean" || typeof cancel.forced !== "boolean")) return undefined;
	const error = asRecord(background.error);
	if (error && (typeof error.code !== "string" || typeof error.message !== "string")) return undefined;
	if (background.progressReview !== undefined && !reviewValidator.Check(background.progressReview)) return undefined;
	return clone({
		...background,
		task,
		tasks,
		wakeEvents,
		summary,
		logs,
		cancel,
		error,
	} as unknown as BackgroundToolDetailsV1);
}

export function attachBackgroundToolDetails(
	details: unknown,
	metadata: BackgroundToolDetailsV1,
): Record<string, unknown> {
	const record = asRecord(details);
	return record ? { ...record, background: clone(metadata) } : { background: clone(metadata) };
}

export function backgroundTaskSnapshotFromDetails(details: unknown): BackgroundTaskSnapshotV1 | undefined {
	return getBackgroundToolDetails(details)?.task;
}
