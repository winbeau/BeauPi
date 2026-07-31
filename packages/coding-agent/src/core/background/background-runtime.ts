import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AgentPool } from "../agents/agent-pool.ts";
import { isMonitorTerminal, type MonitorLifecycleEvent, type MonitorRecord } from "../monitor/index.ts";
import type { MonitorRuntime } from "../monitor/monitor-runtime.ts";
import type { SessionEntry, SessionManager } from "../session-manager.ts";
import { backgroundStoreFromEntries, parseBackgroundStore } from "./details.ts";
import { BackgroundProcessAdapter } from "./process-adapter.ts";
import { AgentPoolProgressReviewer } from "./progress-reviewer.ts";
import {
	BACKGROUND_DETAILS_VERSION,
	BACKGROUND_SESSION_ENTRY_TYPE,
	type BackgroundAttachInput,
	type BackgroundCancelResultV1,
	type BackgroundLogResultV1,
	type BackgroundProgressReviewConfigV1,
	type BackgroundProgressReviewer,
	type BackgroundProgressReviewInput,
	type BackgroundRuntimeListener,
	type BackgroundRuntimeSnapshotV1,
	type BackgroundScheduler,
	type BackgroundStartInput,
	type BackgroundStoreSnapshotV1,
	type BackgroundSummaryV1,
	type BackgroundTaskSnapshotV1,
	type BackgroundTaskV1,
	type BackgroundTriggerInput,
	type BackgroundTriggerV1,
	type BackgroundWakeDeliveryV1,
	type BackgroundWakeEventV1,
	type BackgroundWakeHost,
	type BackgroundWakeLogV1,
	type BackgroundWakeReason,
	type ProgressReviewV1,
} from "./types.ts";

const DEFAULT_REVIEW: BackgroundProgressReviewConfigV1 = {
	version: BACKGROUND_DETAILS_VERSION,
	enabled: false,
	minimumIntervalMs: 300_000,
	maxReviews: 6,
	maxInputCharacters: 12_000,
	timeoutMs: 30_000,
	maxOutputTokens: 512,
};
const DEFAULT_TRIGGERS: BackgroundTriggerInput[] = [
	{ type: "completed" },
	{ type: "failed" },
	{ type: "timeout" },
	{ type: "stalled" },
];
const DEFAULT_GRACE_MS = 1_000;

type RuntimeScheduler = BackgroundScheduler & { sleep(delayMs: number): Promise<void> };

const defaultScheduler: RuntimeScheduler = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => {
		const handle = setTimeout(callback, delayMs);
		handle.unref?.();
		return handle;
	},
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	sleep: (delayMs) => new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs)),
};

export interface BackgroundTaskManagerOptions {
	sessionId: string;
	cwd: string;
	sessionManager: SessionManager;
	monitorRuntime: MonitorRuntime;
	agentPool?: AgentPool;
	now?: () => number;
	scheduler?: BackgroundScheduler;
	processAdapter?: BackgroundProcessAdapter;
	progressReviewer?: BackgroundProgressReviewer;
	maxConcurrency?: number;
	polling?: boolean;
}

interface WakeDeliveryState {
	generation: number;
	eventIds: string[];
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function taskId(): string {
	return `bg-${randomUUID()}`;
}

function taskLogPath(cwd: string, sessionId: string, id: string): string {
	return resolve(cwd, ".beaupi", "background-logs", sessionId, `${id}.log`);
}

function shortText(text: string, max = 1_200): string {
	const normalized = text.replace(/\r\n/g, "\n").trim();
	return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function normalizeTriggers(input: readonly BackgroundTriggerInput[] | undefined): BackgroundTriggerV1[] {
	const source = input && input.length > 0 ? input : DEFAULT_TRIGGERS;
	const seen = new Set<string>();
	return source.map((trigger, index) => {
		if (trigger.type === "error-pattern") {
			if (!trigger.pattern) throw new Error("Background error-pattern trigger requires pattern");
			try {
				new RegExp(trigger.pattern, trigger.flags ?? "i");
			} catch (error) {
				throw new Error(
					`Invalid background error pattern: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		const id = `${trigger.type}:${trigger.pattern ?? ""}:${trigger.flags ?? ""}`;
		if (seen.has(id)) throw new Error(`Duplicate background trigger ${JSON.stringify(id)}`);
		seen.add(id);
		return {
			version: BACKGROUND_DETAILS_VERSION,
			id: `trigger-${index}-${hash(id).slice(0, 12)}`,
			type: trigger.type,
			enabled: true,
			pattern: trigger.pattern,
			flags: trigger.flags,
		};
	});
}

function normalizeReview(input: BackgroundProgressReviewInput | undefined): BackgroundProgressReviewConfigV1 {
	return {
		version: BACKGROUND_DETAILS_VERSION,
		enabled: input?.enabled ?? DEFAULT_REVIEW.enabled,
		minimumIntervalMs: input?.minimumIntervalMs ?? DEFAULT_REVIEW.minimumIntervalMs,
		maxReviews: input?.maxReviews ?? DEFAULT_REVIEW.maxReviews,
		maxInputCharacters: input?.maxInputCharacters ?? DEFAULT_REVIEW.maxInputCharacters,
		timeoutMs: input?.timeoutMs ?? DEFAULT_REVIEW.timeoutMs,
		maxOutputTokens: input?.maxOutputTokens ?? DEFAULT_REVIEW.maxOutputTokens,
	};
}

function triggerEnabled(task: BackgroundTaskV1, type: BackgroundWakeReason): BackgroundTriggerV1 | undefined {
	return task.triggers.find((trigger) => trigger.enabled && trigger.type === type);
}

function mapMonitorEventReason(event: MonitorLifecycleEvent): BackgroundWakeReason | undefined {
	if (event.status === "completed") return "completed";
	if (event.reason === "timeout") return "timeout";
	if (event.status === "stalled") return "stalled";
	if (event.status === "failed" || event.status === "lost") return "failed";
	return undefined;
}

function monitorStatusForTask(monitor: MonitorRecord | undefined): MonitorRecord["status"] {
	return monitor?.status ?? "lost";
}

function isTaskTerminal(task: BackgroundTaskSnapshotV1): boolean {
	return isMonitorTerminal(task.status);
}

function schedulerFrom(options: BackgroundTaskManagerOptions): RuntimeScheduler {
	if (!options.scheduler) return options.now ? { ...defaultScheduler, now: options.now } : defaultScheduler;
	const scheduler = options.scheduler;
	return {
		now: scheduler.now,
		setTimeout: scheduler.setTimeout,
		clearTimeout: scheduler.clearTimeout,
		sleep: (delayMs) =>
			new Promise<void>((resolvePromise) => {
				scheduler.setTimeout(resolvePromise, delayMs);
			}),
	};
}

/** Session-scoped background task runtime. MonitorRuntime remains authoritative for target facts. */
export class BackgroundTaskManager {
	readonly sessionId: string;
	readonly cwd: string;
	readonly monitorRuntime: MonitorRuntime;
	readonly processAdapter: BackgroundProcessAdapter;
	private readonly sessionManager: SessionManager;
	private readonly scheduler: RuntimeScheduler;
	private readonly maxConcurrency: number;
	private readonly progressReviewer?: BackgroundProgressReviewer;
	private readonly tasks = new Map<string, BackgroundTaskV1>();
	private readonly wakeEvents = new Map<string, BackgroundWakeEventV1>();
	private readonly consumedEventKeys = new Set<string>();
	private readonly listeners = new Set<BackgroundRuntimeListener>();
	private readonly pollingEnabled: boolean;
	private operationTail: Promise<void> = Promise.resolve();
	private monitorUnsubscribe: (() => void) | undefined;
	private wakeHost: BackgroundWakeHost | undefined;
	private wakeDelivery: WakeDeliveryState | undefined;
	private generation = 0;
	private pollTimer: unknown;
	private disposed = false;
	private initialized = false;

	constructor(options: BackgroundTaskManagerOptions) {
		this.sessionId = options.sessionId;
		this.cwd = options.cwd;
		this.sessionManager = options.sessionManager;
		this.monitorRuntime = options.monitorRuntime;
		this.scheduler = schedulerFrom(options);
		this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 4));
		this.pollingEnabled = options.polling !== false;
		this.processAdapter =
			options.processAdapter ?? new BackgroundProcessAdapter(this.monitorRuntime.getAdapter("process"));
		this.progressReviewer =
			options.progressReviewer ??
			(options.agentPool ? new AgentPoolProgressReviewer(options.agentPool, this.scheduler.now) : undefined);
		this.monitorRuntime.setAdapter("process", this.processAdapter);
		this.restore(options.sessionManager.getBranch());
		this.monitorUnsubscribe = this.monitorRuntime.subscribe((event) => {
			void this.enqueue(async () => {
				await this.observeTaskByMonitor(event.monitorId, mapMonitorEventReason(event));
				this.consumeWakeQueue();
			});
		});
	}

	bindWakeHost(host: BackgroundWakeHost): void {
		this.wakeHost = host;
		this.consumeWakeQueue();
	}

	subscribe(listener: BackgroundRuntimeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	getSummary(): BackgroundSummaryV1 {
		const summary: BackgroundSummaryV1 = {
			version: BACKGROUND_DETAILS_VERSION,
			total: this.tasks.size,
			waiting: 0,
			starting: 0,
			running: 0,
			stalled: 0,
			completed: 0,
			failed: 0,
			cancelled: 0,
			lost: 0,
			wakeQueued: 0,
		};
		for (const task of this.tasks.values()) {
			const snapshot = this.snapshot(task);
			if (snapshot.status === "healthy") summary.running++;
			else summary[snapshot.status]++;
			if (!isTaskTerminal(snapshot) && task.waitRequestedAt !== undefined) summary.waiting++;
		}
		for (const event of this.wakeEvents.values()) {
			if (event.state === "queued" || event.state === "delivered") summary.wakeQueued++;
		}
		return summary;
	}

	getSnapshot(): BackgroundRuntimeSnapshotV1 {
		return {
			version: BACKGROUND_DETAILS_VERSION,
			tasks: this.list({ includeTerminal: true }),
			wakeEvents: [...this.wakeEvents.values()].map((event) => structuredClone(event)),
			summary: this.getSummary(),
		};
	}

	list(options: { includeTerminal?: boolean } = {}): BackgroundTaskSnapshotV1[] {
		return [...this.tasks.values()]
			.map((task) => this.snapshot(task))
			.filter((task) => options.includeTerminal !== false || !isTaskTerminal(task));
	}

	get(taskId: string): BackgroundTaskSnapshotV1 | undefined {
		const task = this.tasks.get(taskId);
		return task ? this.snapshot(task) : undefined;
	}

	getWakeEvents(taskId?: string): BackgroundWakeEventV1[] {
		return [...this.wakeEvents.values()]
			.filter((event) => taskId === undefined || event.taskId === taskId)
			.map((event) => structuredClone(event));
	}

	async initialize(): Promise<void> {
		if (this.disposed || this.initialized) return;
		this.initialized = true;
		await this.enqueue(async () => {
			for (const task of this.tasks.values()) await this.observeTaskByMonitor(task.monitorId);
			this.emitSnapshot();
		});
		if (this.pollingEnabled) this.startPolling();
		this.consumeWakeQueue();
	}

	startPolling(): void {
		if (this.disposed || this.pollTimer !== undefined) return;
		this.schedulePoll(0);
	}

	stopPolling(): void {
		if (this.pollTimer === undefined) return;
		this.scheduler.clearTimeout(this.pollTimer);
		this.pollTimer = undefined;
	}

	async poll(): Promise<void> {
		if (this.disposed) return;
		await this.enqueue(async () => {
			await this.monitorRuntime.poll();
			for (const task of this.tasks.values()) {
				if (!this.disposed) await this.observeTaskByMonitor(task.monitorId);
			}
			this.emitSnapshot();
		});
		this.consumeWakeQueue();
	}

	async start(input: BackgroundStartInput, signal?: AbortSignal): Promise<BackgroundTaskSnapshotV1> {
		return this.enqueue(async () => {
			if (signal?.aborted) throw new DOMException("Background start cancelled", "AbortError");
			this.assertCapacity();
			const id = taskId();
			const cwd = resolve(this.cwd, input.cwd ?? ".");
			const logPath = taskLogPath(this.cwd, this.sessionId, id);
			const handle = await this.processAdapter.spawn(input.executable, input.args ?? [], cwd, logPath);
			if (signal?.aborted) {
				this.processAdapter.forceStopHandle(handle);
				throw new DOMException("Background start cancelled", "AbortError");
			}
			const monitor = this.monitorRuntime.attach({
				target: { kind: "process", pid: handle.pid, logPath },
				name: input.name ?? input.executable,
				taskSummary: input.goal ?? `Run ${input.executable}`,
				stallTimeoutMs: input.stallTimeoutMs,
				timeoutMs: input.timeoutMs,
			});
			this.processAdapter.register(monitor.id, handle);
			const task: BackgroundTaskV1 = {
				version: BACKGROUND_DETAILS_VERSION,
				id,
				sessionId: this.sessionId,
				monitorId: monitor.id,
				source: "started",
				name: input.name ?? input.executable,
				goal: input.goal,
				executable: input.executable,
				args: [...(input.args ?? [])],
				cwd,
				createdAt: this.scheduler.now(),
				triggers: normalizeTriggers(input.triggers),
				logCursor: 0,
				reviewCount: 0,
				progressReview: normalizeReview(input.progressReview),
				diagnostics: [],
			};
			this.tasks.set(id, task);
			this.persist();
			await this.monitorRuntime.poll();
			await this.observeTaskByMonitor(monitor.id);
			this.emitSnapshot();
			return this.snapshot(task);
		});
	}

	async attach(input: BackgroundAttachInput): Promise<BackgroundTaskSnapshotV1> {
		return this.enqueue(async () => {
			const existing = [...this.tasks.values()].find((task) => task.monitorId === input.monitorId);
			if (existing) return this.snapshot(existing);
			const monitor = this.monitorRuntime.status(input.monitorId);
			await this.monitorRuntime.poll();
			const confirmed = this.monitorRuntime.status(input.monitorId);
			if (confirmed.kind !== "process" && confirmed.kind !== "ssh-tmux") {
				throw new Error("background_attach only accepts local process or SSH/tmux Monitor targets");
			}
			if (monitor.status === "starting" && confirmed.status === "starting") {
				throw new Error("background_attach target state is not confirmed by its existing adapter");
			}
			this.assertCapacity();
			const id = taskId();
			const task: BackgroundTaskV1 = {
				version: BACKGROUND_DETAILS_VERSION,
				id,
				sessionId: this.sessionId,
				monitorId: input.monitorId,
				source: "attached",
				name: input.name ?? confirmed.name,
				goal: input.goal ?? confirmed.taskSummary,
				args: [],
				createdAt: this.scheduler.now(),
				triggers: normalizeTriggers(input.triggers),
				logCursor: confirmed.logCursor,
				logHash: confirmed.logHash,
				logPrefixHash: confirmed.logPrefixHash,
				reviewCount: 0,
				progressReview: normalizeReview(input.progressReview),
				diagnostics: [],
			};
			this.tasks.set(id, task);
			this.persist();
			await this.observeTaskByMonitor(input.monitorId);
			this.emitSnapshot();
			return this.snapshot(task);
		});
	}

	async status(
		taskId?: string,
		includeTerminal = true,
	): Promise<BackgroundTaskSnapshotV1 | BackgroundTaskSnapshotV1[]> {
		return this.enqueue(async () => {
			if (taskId) {
				const task = this.tasks.get(taskId);
				if (!task) throw new Error(`Unknown background task id ${JSON.stringify(taskId)}`);
				return this.snapshot(task);
			}
			return this.list({ includeTerminal });
		});
	}

	async logs(
		taskId: string,
		options: { cursor?: number; hash?: string; mode?: BackgroundLogResultV1["mode"]; maxCharacters?: number } = {},
	): Promise<{ task: BackgroundTaskSnapshotV1; logs: BackgroundLogResultV1 }> {
		return this.enqueue(async () => {
			const task = this.requireTask(taskId);
			if (options.hash && task.logHash && options.hash !== task.logHash) {
				this.addDiagnostic(task, "Supplied background log hash differs from the persisted consumer hash");
			}
			const mode = options.mode ?? "tail";
			const raw = await this.monitorRuntime.logs(task.monitorId, {
				cursor: options.cursor ?? task.logCursor,
				mode: mode === "full" ? "full" : "incremental",
			});
			const maxCharacters = options.maxCharacters ?? 12_000;
			const content =
				mode === "errors" ? errorLines(raw.content) : mode === "summary" ? summarizeLog(raw.content) : raw.content;
			const bounded = mode === "full" ? content.slice(0, maxCharacters) : content.slice(-maxCharacters);
			const result: BackgroundLogResultV1 = {
				mode,
				content: bounded,
				cursor: raw.cursor,
				hash: raw.hash,
				changed: raw.changed,
				truncated: raw.truncated || bounded.length !== content.length,
				rotated: raw.rotated,
				missing: raw.missing,
				logPath: raw.path || undefined,
				diagnostic: raw.diagnostic,
			};
			if (mode !== "full") {
				task.logCursor = raw.cursor;
				task.logHash = raw.hash || task.logHash;
				task.logPrefixHash = raw.prefixHash || task.logPrefixHash;
				if (raw.changed) task.lastLogActivityAt = this.scheduler.now();
				this.persist();
			}
			return { task: this.snapshot(task), logs: result };
		});
	}

	async wait(taskId: string, triggers?: readonly BackgroundTriggerInput[]): Promise<BackgroundTaskSnapshotV1> {
		return this.enqueue(async () => {
			const task = this.requireTask(taskId);
			if (triggers) task.triggers = normalizeTriggers(triggers);
			task.waitRequestedAt ??= this.scheduler.now();
			this.persist();
			await this.observeTaskByMonitor(task.monitorId);
			this.emitSnapshot();
			this.consumeWakeQueue();
			return this.snapshot(task);
		});
	}

	async cancel(
		taskId: string,
		graceMs = DEFAULT_GRACE_MS,
		signal?: AbortSignal,
	): Promise<{ task?: BackgroundTaskSnapshotV1; cancel: BackgroundCancelResultV1 }> {
		return this.enqueue(async () => {
			const task = this.tasks.get(taskId);
			if (!task) return { cancel: { accepted: false, reason: "task_not_found", forced: false } };
			const before = this.snapshot(task);
			if (isTaskTerminal(before)) {
				return { task: before, cancel: { accepted: false, reason: "already_terminal", forced: false } };
			}
			const stopped = await this.monitorRuntime.stop(task.monitorId, false);
			if (!stopped.result.accepted) {
				return { task: this.snapshot(task), cancel: { accepted: false, reason: "stop_rejected", forced: false } };
			}
			let forced = false;
			if (graceMs > 0) await this.sleepWithAbort(graceMs, signal);
			if (this.processAdapter.isRunning(task.monitorId)) {
				forced = this.processAdapter.forceStop(task.monitorId).accepted;
			}
			this.addDiagnostic(task, forced ? "Graceful cancellation escalated to SIGKILL" : "Cancellation requested");
			this.persist();
			this.emitSnapshot();
			return { task: this.snapshot(task), cancel: { accepted: true, reason: "cancel_requested", forced } };
		});
	}

	async rebuild(entries: readonly SessionEntry[] = this.sessionManager.getBranch()): Promise<void> {
		if (this.disposed) return;
		await this.enqueue(async () => {
			this.stopPolling();
			this.generation++;
			this.wakeDelivery = undefined;
			this.tasks.clear();
			this.wakeEvents.clear();
			this.consumedEventKeys.clear();
			this.restore(entries);
			for (const event of this.wakeEvents.values()) {
				if (event.state === "delivered") {
					event.state = "consumed";
					event.consumedAt = this.scheduler.now();
					this.consumedEventKeys.add(event.dedupeKey);
				}
			}
			this.persist();
			this.emitSnapshot();
		});
		if (this.pollingEnabled) this.startPolling();
		this.consumeWakeQueue();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.generation++;
		this.stopPolling();
		this.monitorUnsubscribe?.();
		this.monitorUnsubscribe = undefined;
		this.wakeHost = undefined;
		this.wakeDelivery = undefined;
		this.listeners.clear();
	}

	private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.operationTail.then(operation, operation);
		this.operationTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private schedulePoll(delayMs: number): void {
		if (this.disposed) return;
		this.pollTimer = this.scheduler.setTimeout(
			() => {
				this.pollTimer = undefined;
				void this.poll().finally(() => this.schedulePoll(this.nextPollDelay()));
			},
			Math.max(0, delayMs),
		);
	}

	private nextPollDelay(): number {
		const now = this.scheduler.now();
		let delay = 30_000;
		for (const task of this.tasks.values()) {
			const monitor = this.monitorRuntime.getRecord(task.monitorId);
			if (!monitor || isMonitorTerminal(monitor.status)) continue;
			const age = now - task.createdAt;
			const quiet = now - monitor.lastActivityAt;
			const candidate = age < 30_000 ? 2_000 : age < 300_000 ? 10_000 : quiet > 300_000 ? 60_000 : 30_000;
			delay = Math.min(delay, candidate);
		}
		return delay;
	}

	private assertCapacity(): void {
		const active = this.list({ includeTerminal: false }).length;
		if (active >= this.maxConcurrency)
			throw new Error(`Maximum background task concurrency (${this.maxConcurrency}) reached`);
	}

	private requireTask(id: string): BackgroundTaskV1 {
		const task = this.tasks.get(id);
		if (!task) throw new Error(`Unknown background task id ${JSON.stringify(id)}`);
		return task;
	}

	private snapshot(task: BackgroundTaskV1): BackgroundTaskSnapshotV1 {
		const monitor = this.monitorRuntime.getRecord(task.monitorId);
		const events = [...this.wakeEvents.values()].filter((event) => event.taskId === task.id);
		const lastWake = events.at(-1);
		return {
			...structuredClone(task),
			status: monitorStatusForTask(monitor),
			monitor,
			target: monitor?.target,
			wakeQueued: events.filter((event) => event.state === "queued" || event.state === "delivered").length,
			lastWakeReason: lastWake?.reason,
		};
	}

	private persist(): void {
		const snapshot: BackgroundStoreSnapshotV1 = {
			version: BACKGROUND_DETAILS_VERSION,
			sessionId: this.sessionId,
			tasks: [...this.tasks.values()].map((task) => structuredClone(task)),
			wakeEvents: [...this.wakeEvents.values()].map((event) => structuredClone(event)),
			consumedEventKeys: [...this.consumedEventKeys],
			updatedAt: this.scheduler.now(),
		};
		this.sessionManager.appendCustomEntry(
			BACKGROUND_SESSION_ENTRY_TYPE,
			JSON.parse(JSON.stringify(snapshot)) as BackgroundStoreSnapshotV1,
		);
	}

	private restore(entries: readonly SessionEntry[]): void {
		const parsed = backgroundStoreFromEntries(entries);
		if (!parsed || parsed.sessionId !== this.sessionId) return;
		const validated = parseBackgroundStore(parsed);
		if (!validated) return;
		for (const task of validated.tasks) this.tasks.set(task.id, structuredClone(task));
		for (const event of validated.wakeEvents) this.wakeEvents.set(event.id, structuredClone(event));
		for (const key of validated.consumedEventKeys) this.consumedEventKeys.add(key);
	}

	private addDiagnostic(task: BackgroundTaskV1, diagnostic: string): boolean {
		if (!diagnostic || task.diagnostics.includes(diagnostic)) return false;
		task.diagnostics.push(diagnostic);
		return true;
	}

	private async observeTaskByMonitor(monitorId: string, preferredReason?: BackgroundWakeReason): Promise<void> {
		const task = [...this.tasks.values()].find((candidate) => candidate.monitorId === monitorId);
		if (!task || this.disposed) return;
		const beforeTask = JSON.stringify(task);
		const monitor = this.monitorRuntime.getRecord(monitorId);
		if (!monitor) {
			if (this.addDiagnostic(task, "Monitor record unavailable; background task state is unconfirmed"))
				this.persist();
			return;
		}
		let logDelta = "";
		let log: BackgroundWakeLogV1 | undefined;
		const logPath = monitor.logPath ?? monitor.target.logPath;
		if (logPath || monitor.activityLog.length > 0) {
			const result = await this.monitorRuntime.logs(monitorId, { cursor: task.logCursor });
			if (result.missing) {
				if (monitor.status !== "completed" && monitor.status !== "cancelled")
					this.addDiagnostic(task, result.diagnostic ?? "Background log unavailable");
			} else {
				logDelta = result.content;
				if (result.changed) task.lastLogActivityAt = this.scheduler.now();
				task.logCursor = result.cursor;
				task.logHash = result.hash;
				task.logPrefixHash = result.prefixHash;
				log = {
					cursor: result.cursor,
					hash: result.hash,
					summary: summarizeLog(result.content),
					logPath: result.path || undefined,
					truncated: result.truncated,
					rotated: result.rotated,
				};
			}
		}
		for (const trigger of task.triggers.filter((item) => item.enabled && item.type === "error-pattern")) {
			if (logDelta && trigger.pattern && new RegExp(trigger.pattern, trigger.flags ?? "i").test(logDelta)) {
				this.enqueueWake(task, "error-pattern", monitor, log);
				break;
			}
		}
		const reason = preferredReason ?? this.reasonForStatus(monitor.status, monitor.exitReason);
		if (reason && triggerEnabled(task, reason)) this.enqueueWake(task, reason, monitor, log);
		if (logDelta && task.progressReview.enabled)
			await this.maybeReview(task, monitor, logDelta, log?.hash ?? task.logHash ?? "");
		if (beforeTask !== JSON.stringify(task)) this.persist();
	}

	private reasonForStatus(status: MonitorRecord["status"], exitReason?: string): BackgroundWakeReason | undefined {
		if (status === "completed") return "completed";
		if (status === "failed") return exitReason === "monitor_timeout" ? "timeout" : "failed";
		if (status === "stalled") return "stalled";
		if (status === "lost") return "failed";
		return undefined;
	}

	private enqueueWake(
		task: BackgroundTaskV1,
		reason: BackgroundWakeReason,
		monitor: MonitorRecord,
		log?: BackgroundWakeLogV1,
		review?: ProgressReviewV1,
	): void {
		if (task.waitRequestedAt === undefined) return;
		const logHash = log?.hash ?? task.logHash ?? "";
		const dedupeKey = `${task.id}:${reason}:${monitor.status}:${logHash}`;
		if (this.consumedEventKeys.has(dedupeKey)) return;
		if ([...this.wakeEvents.values()].some((event) => event.dedupeKey === dedupeKey && event.state !== "cancelled"))
			return;
		const event: BackgroundWakeEventV1 = {
			version: BACKGROUND_DETAILS_VERSION,
			id: `wake-${randomUUID()}`,
			dedupeKey,
			taskId: task.id,
			monitorId: task.monitorId,
			reason,
			monitorStatus: monitor.status,
			createdAt: this.scheduler.now(),
			state: "queued",
			log,
			progressReview: review,
		};
		this.wakeEvents.set(event.id, event);
		this.persist();
		this.emitSnapshot();
	}

	private async maybeReview(
		task: BackgroundTaskV1,
		monitor: MonitorRecord,
		newLog: string,
		logHash: string,
	): Promise<void> {
		if (
			task.waitRequestedAt === undefined ||
			!triggerEnabled(task, "progress-review") ||
			!task.progressReview.enabled
		)
			return;
		if (task.lastReviewHash === logHash) return;
		const now = this.scheduler.now();
		if (task.lastReviewAt !== undefined && now - task.lastReviewAt < task.progressReview.minimumIntervalMs) return;
		if (task.reviewCount >= task.progressReview.maxReviews) return;
		task.lastReviewHash = logHash;
		task.lastReviewAt = now;
		task.reviewCount++;
		this.persist();
		if (!this.progressReviewer) {
			this.addDiagnostic(task, "Progress Reviewer is enabled but no shared AgentPool is available");
			return;
		}
		try {
			const review = await this.progressReviewer.review(
				{
					taskId: task.id,
					goal: task.goal ?? task.name,
					previousSummary: task.lastReviewSummary,
					newLog: shortText(newLog, task.progressReview.maxInputCharacters),
					logHash,
					runtimeMs: now - task.createdAt,
					resources: monitor.resources,
					config: task.progressReview,
				},
				undefined,
			);
			task.lastReviewSummary = review.summary;
			if (review.shouldWakeCoordinator && triggerEnabled(task, "progress-review")) {
				this.enqueueWake(
					task,
					"progress-review",
					monitor,
					{
						cursor: task.logCursor,
						hash: logHash,
						summary: review.summary,
						logPath: monitor.logPath,
						truncated: false,
						rotated: false,
					},
					review,
				);
			}
		} catch (error) {
			this.addDiagnostic(
				task,
				`Progress Reviewer failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		this.persist();
	}

	private consumeWakeQueue(): void {
		if (this.disposed || this.wakeDelivery || !this.wakeHost) return;
		const queued = [...this.wakeEvents.values()]
			.filter((event) => event.state === "queued")
			.sort(
				(left, right) => wakePriority(left.reason) - wakePriority(right.reason) || left.createdAt - right.createdAt,
			);
		if (queued.length === 0) return;
		if (queued.every((event) => event.reason === "progress-review") && this.wakeHost.hasPendingUserMessages()) return;
		const tasks = queued
			.map((event) => this.tasks.get(event.taskId))
			.filter((task): task is BackgroundTaskV1 => task !== undefined)
			.map((task) => this.snapshot(task));
		const delivery: BackgroundWakeDeliveryV1 = {
			version: BACKGROUND_DETAILS_VERSION,
			eventIds: queued.map((event) => event.id),
			events: queued.map((event) => structuredClone(event)),
			tasks,
		};
		const generation = this.generation;
		for (const event of queued) {
			event.state = "delivered";
			event.deliveredAt = this.scheduler.now();
		}
		this.wakeDelivery = { generation, eventIds: delivery.eventIds };
		this.persist();
		this.emitSnapshot();
		const mode = this.wakeHost.isBusy() ? "followUp" : "trigger";
		void this.wakeHost.deliver(delivery, mode).then(
			() => {
				void this.enqueue(async () => this.finishWakeDelivery(generation, delivery.eventIds));
			},
			(error) => {
				void this.enqueue(async () => this.failWakeDelivery(generation, delivery.eventIds, error));
			},
		);
	}

	private finishWakeDelivery(generation: number, eventIds: readonly string[]): void {
		if (this.disposed || generation !== this.generation) return;
		for (const id of eventIds) {
			const event = this.wakeEvents.get(id);
			if (!event) continue;
			event.state = "consumed";
			event.consumedAt = this.scheduler.now();
			this.consumedEventKeys.add(event.dedupeKey);
		}
		this.wakeDelivery = undefined;
		this.persist();
		this.emitSnapshot();
		this.consumeWakeQueue();
	}

	private failWakeDelivery(generation: number, eventIds: readonly string[], error: unknown): void {
		if (this.disposed || generation !== this.generation) return;
		for (const id of eventIds) {
			const event = this.wakeEvents.get(id);
			if (!event) continue;
			event.state = "queued";
			event.diagnostic = `Wake delivery failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.wakeDelivery = undefined;
		this.persist();
		this.emitSnapshot();
	}

	private emitSnapshot(): void {
		if (this.disposed) return;
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) {
			try {
				listener(snapshot);
			} catch {
				// UI and Ledger projections are non-authoritative.
			}
		}
	}

	private async sleepWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
		if (!signal) {
			await this.scheduler.sleep(delayMs);
			return;
		}
		if (signal.aborted) throw new DOMException("Background cancellation aborted", "AbortError");
		await new Promise<void>((resolvePromise, reject) => {
			let handle: unknown;
			const onAbort = (): void => {
				if (handle !== undefined) this.scheduler.clearTimeout(handle);
				signal.removeEventListener("abort", onAbort);
				reject(new DOMException("Background cancellation aborted", "AbortError"));
			};
			handle = this.scheduler.setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolvePromise();
			}, delayMs);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}

export function formatBackgroundWakeMessage(delivery: BackgroundWakeDeliveryV1): string {
	const lines = ["[BACKGROUND TASK EVENTS]", `version: ${delivery.version}`];
	for (const event of delivery.events) {
		const task = delivery.tasks.find((candidate) => candidate.id === event.taskId);
		lines.push(
			[
				`task=${event.taskId}`,
				`monitor=${event.monitorId}`,
				`reason=${event.reason}`,
				`status=${event.monitorStatus}`,
				task?.monitor?.exitCode === undefined ? undefined : `exitCode=${task.monitor.exitCode}`,
				event.log?.summary ? `log=${shortText(event.log.summary, 500)}` : undefined,
				event.log?.logPath ? `logPath=${event.log.logPath}` : undefined,
			]
				.filter((item): item is string => item !== undefined)
				.join(" · "),
		);
	}
	lines.push(
		"Inspect these structured events and continue the current task. Read additional output with background_logs when needed.",
	);
	return lines.join("\n");
}

function wakePriority(reason: BackgroundWakeReason): number {
	return reason === "progress-review" ? 1 : 0;
}

function errorLines(content: string): string {
	return content
		.split(/\r\n|\r|\n/)
		.filter((line) => /error|failed|fatal|exception|warning|warn/i.test(line))
		.join("\n");
}

function summarizeLog(content: string): string {
	if (!content) return "No new log output.";
	const lines = content.split(/\r\n|\r|\n/).filter(Boolean);
	const errors = lines.filter((line) => /error|failed|fatal|exception|warning|warn/i.test(line)).length;
	return `${lines.length} new log line${lines.length === 1 ? "" : "s"}${errors ? ` · ${errors} error/warning line${errors === 1 ? "" : "s"}` : ""} · ${shortText(lines.at(-1) ?? "", 400)}`;
}

export { DEFAULT_REVIEW, DEFAULT_TRIGGERS, errorLines, normalizeReview, normalizeTriggers, shortText, taskLogPath };
