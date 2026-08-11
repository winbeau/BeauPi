import { createHash } from "node:crypto";
import type { AgentSessionEvent } from "../agent-session.ts";
import type { AgentLifecycleEvent, AgentPool } from "../agents/agent-pool.ts";
import type { SessionEntry, SessionManager } from "../session-manager.ts";
import {
	FakeProcessAdapter,
	NodeProcessMonitorAdapter,
	SubAgentMonitorAdapter,
	ToolMonitorAdapter,
	UnimplementedSshTmuxMonitorAdapter,
	WorkflowMonitorAdapter,
} from "./adapters.ts";
import { IncrementalLogReader, type IncrementalLogReadResult } from "./log-reader.ts";
import {
	isMonitorTerminal,
	MONITOR_ACTIVITY_LOG_LIMIT,
	MONITOR_RECORD_VERSION,
	MONITOR_SESSION_ENTRY_TYPE,
	type MonitorActivityEvent,
	type MonitorAdapter,
	type MonitorAdapterSnapshot,
	type MonitorEventReason,
	type MonitorKind,
	type MonitorLifecycleEvent,
	type MonitorLifecycleEventListener,
	type MonitorRecord,
	type MonitorRecordInput,
	type MonitorStatus,
	type MonitorStopResult,
	type MonitorSummary,
	monitorStatusForAgentEvent,
} from "./types.ts";

interface MonitorAgentSessionBinding {
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	getAbortSignal?: () => AbortSignal | undefined;
	agentPool?: AgentPool;
}

export interface MonitorRuntimeOptions {
	sessionId: string;
	cwd: string;
	sessionManager: SessionManager;
	now?: () => number;
	stallTimeoutMs?: number;
	/** Delay before an active bash Tool is automatically promoted into Monitor. */
	longRunningBashThresholdMs?: number;
	adapters?: Partial<Record<MonitorKind, MonitorAdapter>>;
	processAdapter?: MonitorAdapter;
	agentPool?: AgentPool;
}

export interface MonitorListOptions {
	kind?: MonitorKind;
	status?: MonitorStatus;
	includeTerminal?: boolean;
}

export interface MonitorLogOptions {
	cursor?: number;
	mode?: "incremental" | "full";
}

export interface MonitorLogResult extends IncrementalLogReadResult {
	monitor: MonitorRecord;
}

export interface MonitorRecordUpdate {
	status: MonitorStatus;
	reason: MonitorEventReason;
	timestamp?: number;
	exitReason?: string;
	exitCode?: number;
	diagnostic?: string;
	activity?: Omit<MonitorActivityEvent, "sequence">;
}

interface Waiter {
	resolve: (record: MonitorRecord) => void;
}

function monitorWaitAbortError(): DOMException {
	return new DOMException("Monitor wait cancelled", "AbortError");
}

interface PendingToolExecution {
	toolCallId: string;
	toolName: string;
	startedAt: number;
	lastActivityAt: number;
}

const DEFAULT_LONG_RUNNING_BASH_THRESHOLD_MS = 10_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asStatus(value: unknown): MonitorStatus | undefined {
	return value === "starting" ||
		value === "running" ||
		value === "healthy" ||
		value === "stalled" ||
		value === "completed" ||
		value === "failed" ||
		value === "cancelled" ||
		value === "lost"
		? value
		: undefined;
}

function asKind(value: unknown): MonitorKind | undefined {
	return value === "process" ||
		value === "tool" ||
		value === "sub-agent" ||
		value === "ssh-tmux" ||
		value === "workflow"
		? value
		: undefined;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function stableMonitorId(sessionId: string, target: MonitorRecordInput["target"]): string {
	const key = JSON.stringify({ sessionId, target });
	const digest = createHash("sha256").update(key).digest("hex").slice(0, 20);
	return `mon-${digest}`;
}

function defaultName(target: MonitorRecordInput["target"]): string {
	switch (target.kind) {
		case "process":
			return `process:${target.pid}`;
		case "tool":
			return target.toolName ? `${target.toolName}:${target.toolCallId}` : `tool:${target.toolCallId}`;
		case "sub-agent":
			return target.profile ? `agent:${target.profile}` : `agent:${target.taskId}`;
		case "ssh-tmux":
			return target.sessionId ? `ssh-tmux:${target.sessionId}` : "ssh-tmux";
		case "workflow":
			return target.nodeId ? `workflow:${target.workflowId}:${target.nodeId}` : `workflow:${target.workflowId}`;
	}
}

function defaultSummary(target: MonitorRecordInput["target"]): string {
	switch (target.kind) {
		case "process":
			return `Monitor local process ${target.pid}`;
		case "tool":
			return `Monitor Tool ${target.toolName ?? target.toolCallId}`;
		case "sub-agent":
			return `Monitor sub-agent ${target.profile ?? target.taskId}`;
		case "ssh-tmux":
			return "Monitor SSH/tmux target";
		case "workflow":
			return target.nodeId ? `Monitor Workflow node ${target.nodeId}` : `Monitor Workflow ${target.workflowId}`;
	}
}

function targetLogPath(target: MonitorRecordInput["target"]): string | undefined {
	return target.logPath;
}

function transitionAllowed(from: MonitorStatus, to: MonitorStatus): boolean {
	if (from === to) return true;
	if (isMonitorTerminal(from)) return false;
	if (from === "starting") return ["running", "healthy", "completed", "failed", "cancelled", "lost"].includes(to);
	if (from === "running") return ["healthy", "stalled", "completed", "failed", "cancelled", "lost"].includes(to);
	if (from === "healthy") return ["running", "stalled", "completed", "failed", "cancelled", "lost"].includes(to);
	if (from === "stalled") return ["running", "healthy", "completed", "failed", "cancelled", "lost"].includes(to);
	return false;
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, milliseconds) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = Math.floor(seconds % 60);
	return `${minutes}m${remainder.toString().padStart(2, "0")}s`;
}

function normalizeActivityLog(value: unknown): MonitorActivityEvent[] {
	if (!Array.isArray(value)) return [];
	const events: MonitorActivityEvent[] = [];
	for (const item of value) {
		const record = asRecord(item);
		if (
			!record ||
			typeof record.sequence !== "number" ||
			typeof record.timestamp !== "number" ||
			(record.kind !== "turn" && record.kind !== "tool" && record.kind !== "agent" && record.kind !== "workflow") ||
			(record.outcome !== "started" && record.outcome !== "succeeded" && record.outcome !== "failed") ||
			typeof record.message !== "string"
		) {
			continue;
		}
		events.push({
			sequence: record.sequence,
			timestamp: record.timestamp,
			kind: record.kind,
			turn: typeof record.turn === "number" ? record.turn : undefined,
			toolName: typeof record.toolName === "string" ? record.toolName : undefined,
			targetPath: typeof record.targetPath === "string" ? record.targetPath : undefined,
			outcome: record.outcome,
			message: record.message,
		});
	}
	return events.slice(-MONITOR_ACTIVITY_LOG_LIMIT);
}

function formatActivityEvent(event: MonitorActivityEvent): string {
	const context = [
		event.kind,
		event.turn === undefined ? undefined : `turn ${event.turn}`,
		event.toolName,
		event.targetPath,
		event.outcome,
	]
		.filter((value): value is string => value !== undefined && value !== "")
		.join(" · ");
	return `${new Date(event.timestamp).toISOString()} · ${context} · ${event.message}`;
}

function activityLogHash(events: readonly MonitorActivityEvent[]): string {
	return createHash("sha256").update(events.map(formatActivityEvent).join("\n")).digest("hex");
}

function snapshotFromEntry(entry: SessionEntry): MonitorRecord | undefined {
	if (entry.type !== "custom" || entry.customType !== MONITOR_SESSION_ENTRY_TYPE) return undefined;
	const data = asRecord(entry.data);
	if (data?.version !== MONITOR_RECORD_VERSION) return undefined;
	const raw = asRecord(data.record);
	if (!raw) return undefined;
	const kind = asKind(raw.kind);
	const status = asStatus(raw.status);
	const target = asRecord(raw.target);
	if (!kind || !status || !target || asKind(target.kind) !== kind) return undefined;
	if (
		typeof raw.id !== "string" ||
		typeof raw.sessionId !== "string" ||
		typeof raw.name !== "string" ||
		typeof raw.taskSummary !== "string" ||
		typeof raw.createdAt !== "number" ||
		typeof raw.lastActivityAt !== "number" ||
		typeof raw.durationMs !== "number" ||
		typeof raw.logCursor !== "number" ||
		!Array.isArray(raw.diagnostics)
	) {
		return undefined;
	}
	return clone({ ...raw, activityLog: normalizeActivityLog(raw.activityLog) } as unknown as MonitorRecord);
}

function isToolCancelled(
	event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>,
	signal?: AbortSignal,
): boolean {
	const details = asRecord(event.result)?.details;
	const ledger = asRecord(asRecord(details)?.taskLedger);
	return ledger?.status === "cancelled" || (event.isError && signal?.aborted === true);
}

/** Session-scoped index of Monitor records owned by one MonitorRuntime. */
export class MonitorRegistry {
	private readonly records = new Map<string, MonitorRecord>();

	get size(): number {
		return this.records.size;
	}

	get(monitorId: string): MonitorRecord | undefined {
		return this.records.get(monitorId);
	}

	set(record: MonitorRecord): void {
		this.records.set(record.id, record);
	}

	clear(): void {
		this.records.clear();
	}

	values(): IterableIterator<MonitorRecord> {
		return this.records.values();
	}
}

/**
 * The single observation layer for process, Tool and in-process sub-agent
 * execution. It owns no Agent, Session, ResourceLoader or model loop.
 */
export class MonitorRuntime {
	readonly sessionId: string;
	readonly cwd: string;
	private readonly sessionManager: SessionManager;
	private readonly now: () => number;
	private readonly defaultStallTimeoutMs: number;
	private readonly longRunningBashThresholdMs: number;
	private readonly adapters: Map<MonitorKind, MonitorAdapter>;
	readonly registry = new MonitorRegistry();
	private readonly restoredRecordIds = new Set<string>();
	private get records(): MonitorRegistry {
		return this.registry;
	}
	private readonly waiters = new Map<string, Set<Waiter>>();
	private readonly listeners = new Set<MonitorLifecycleEventListener>();
	private readonly pendingToolExecutions = new Map<string, PendingToolExecution>();
	private readonly logReader = new IncrementalLogReader();
	private eventQueue: Promise<void> = Promise.resolve();
	private pollQueue: Promise<void> = Promise.resolve();
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private sessionUnsubscribe: (() => void) | undefined;
	private poolUnsubscribe: (() => void) | undefined;
	private initialized = false;
	private disposed = false;

	constructor(options: MonitorRuntimeOptions) {
		this.sessionId = options.sessionId;
		this.cwd = options.cwd;
		this.sessionManager = options.sessionManager;
		this.now = options.now ?? (() => Date.now());
		this.defaultStallTimeoutMs = options.stallTimeoutMs ?? 60_000;
		this.longRunningBashThresholdMs = Math.max(
			0,
			Math.floor(options.longRunningBashThresholdMs ?? DEFAULT_LONG_RUNNING_BASH_THRESHOLD_MS),
		);
		const processAdapter = options.processAdapter ?? new NodeProcessMonitorAdapter();
		this.adapters = new Map<MonitorKind, MonitorAdapter>([
			["process", processAdapter],
			["tool", options.adapters?.tool ?? new ToolMonitorAdapter()],
			["sub-agent", options.adapters?.["sub-agent"] ?? new SubAgentMonitorAdapter(options.agentPool)],
			["ssh-tmux", options.adapters?.["ssh-tmux"] ?? new UnimplementedSshTmuxMonitorAdapter()],
			["workflow", options.adapters?.workflow ?? new WorkflowMonitorAdapter()],
		]);
		for (const [kind, adapter] of Object.entries(options.adapters ?? {}) as Array<[MonitorKind, MonitorAdapter]>) {
			if (adapter) this.adapters.set(kind, adapter);
		}
		this.restoreRecords(this.sessionManager.getBranch());
	}

	get size(): number {
		return this.records.size;
	}

	/** Read the installed adapter so a higher-level runtime can extend observation without copying the registry. */
	getAdapter(kind: MonitorKind): MonitorAdapter {
		const adapter = this.adapters.get(kind);
		if (!adapter) throw new Error(`Monitor adapter unavailable for ${kind}`);
		return adapter;
	}

	/** Replace one adapter before or during M7 runtime binding without creating another registry. */
	setAdapter(kind: MonitorKind, adapter: MonitorAdapter): void {
		if (adapter.kind !== kind)
			throw new Error(`Monitor adapter kind mismatch: expected ${kind}, got ${adapter.kind}`);
		this.adapters.set(kind, adapter);
	}

	getSummary(): MonitorSummary {
		const summary: MonitorSummary = {
			total: this.records.size,
			starting: 0,
			running: 0,
			healthy: 0,
			stalled: 0,
			completed: 0,
			failed: 0,
			cancelled: 0,
			lost: 0,
		};
		for (const record of this.records.values()) summary[record.status]++;
		return summary;
	}

	getRecord(monitorId: string): MonitorRecord | undefined {
		const record = this.records.get(monitorId);
		return record ? this.snapshot(record) : undefined;
	}

	list(options: MonitorListOptions = {}): MonitorRecord[] {
		return [...this.records.values()]
			.filter((record) => options.kind === undefined || record.kind === options.kind)
			.filter((record) => options.status === undefined || record.status === options.status)
			.filter((record) => options.includeTerminal !== false || !isMonitorTerminal(record.status))
			.map((record) => this.snapshot(record));
	}

	subscribe(listener: MonitorLifecycleEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Bind one AgentSession and its existing AgentPool; no second runtime is created. */
	bindAgentSession(binding: MonitorAgentSessionBinding): void {
		this.sessionUnsubscribe?.();
		this.poolUnsubscribe?.();
		this.pendingToolExecutions.clear();
		this.sessionUnsubscribe = binding.subscribe((event) => this.handleAgentEvent(event, binding.getAbortSignal?.()));
		if (binding.agentPool) {
			this.poolUnsubscribe = binding.agentPool.subscribe((event) => this.handleAgentLifecycleEvent(event));
		}
	}

	async initialize(): Promise<void> {
		if (this.initialized || this.disposed) return;
		this.initialized = true;
		for (const monitorId of this.restoredRecordIds) {
			const record = this.records.get(monitorId);
			if (!record || isMonitorTerminal(record.status)) continue;
			const adapter = this.adapters.get(record.kind);
			if (!adapter) {
				this.transition(record, "lost", "target_lost", { exitReason: "adapter_unavailable" });
				continue;
			}
			const snapshot = await adapter.poll(record, this.now());
			if (snapshot.availability === "missing" || snapshot.availability === "unknown") {
				this.transition(record, "lost", "target_lost", {
					exitReason: snapshot.exitReason ?? "state_unconfirmed_after_restore",
				});
			} else {
				const timestamp = this.now();
				this.applyAdapterSnapshot(record, snapshot, timestamp);
				this.checkStalled(record, timestamp);
			}
		}
		await this.flushEvents();
	}

	startPolling(intervalMs = 2_000): void {
		if (this.pollTimer || this.disposed) return;
		const interval = Math.max(50, Math.floor(intervalMs));
		this.pollTimer = setInterval(() => {
			void this.poll();
		}, interval);
		this.pollTimer.unref?.();
	}

	stopPolling(): void {
		if (!this.pollTimer) return;
		clearInterval(this.pollTimer);
		this.pollTimer = undefined;
	}

	async poll(): Promise<void> {
		this.pollQueue = this.pollQueue
			.then(() => this.pollOnce())
			.catch(() => {
				// An adapter failure must not stop later low-cost polling cycles.
			});
		await this.pollQueue;
	}

	async rebuild(entries: readonly SessionEntry[] = this.sessionManager.getBranch()): Promise<void> {
		if (this.disposed) return;
		this.records.clear();
		this.restoredRecordIds.clear();
		this.pendingToolExecutions.clear();
		this.logReader.clear();
		this.initialized = false;
		this.restoreRecords(entries);
		await this.initialize();
	}

	private async pollOnce(): Promise<void> {
		if (this.disposed) return;
		const timestamp = this.now();
		for (const pending of this.pendingToolExecutions.values()) this.promoteLongRunningBash(pending, timestamp);
		for (const record of this.records.values()) {
			if (isMonitorTerminal(record.status)) continue;
			if (record.timeoutMs !== undefined && timestamp - (record.startedAt ?? record.createdAt) >= record.timeoutMs) {
				const adapter = this.adapters.get(record.kind);
				await adapter?.stop?.(record, true);
				this.transition(record, "failed", "timeout", { exitReason: "monitor_timeout" }, timestamp);
				continue;
			}
			const adapter = this.adapters.get(record.kind);
			if (!adapter) continue;
			const snapshot = await adapter.poll(record, timestamp);
			if (snapshot.availability === "missing") {
				this.transition(
					record,
					"lost",
					"target_lost",
					{
						exitReason: snapshot.exitReason ?? "target_missing",
					},
					timestamp,
				);
				continue;
			}
			if (snapshot.availability === "confirmed") this.applyAdapterSnapshot(record, snapshot, timestamp);
			this.checkStalled(record, timestamp);
		}
		await this.flushEvents();
	}

	attach(input: MonitorRecordInput): MonitorRecord {
		if (this.disposed) throw new Error("Monitor runtime is disposed");
		if (input.sessionId !== undefined && input.sessionId !== this.sessionId) {
			throw new Error("Monitor target belongs to a different session");
		}
		const timestamp = input.createdAt ?? this.now();
		const id = input.id ?? stableMonitorId(this.sessionId, input.target);
		const existing = this.records.get(id);
		if (existing) return this.snapshot(existing);
		const logPath = targetLogPath(input.target);
		const record: MonitorRecord = {
			version: MONITOR_RECORD_VERSION,
			id,
			sessionId: this.sessionId,
			target: clone(input.target),
			kind: input.target.kind,
			name: input.name?.trim() || defaultName(input.target),
			taskSummary: input.taskSummary?.trim() || defaultSummary(input.target),
			createdAt: timestamp,
			durationMs: 0,
			lastActivityAt: timestamp,
			status: "starting",
			logPath,
			logCursor: 0,
			stallTimeoutMs: input.stallTimeoutMs ?? this.defaultStallTimeoutMs,
			timeoutMs: input.timeoutMs,
			activityLog: [],
			diagnostics: [],
		};
		this.records.set(record);
		this.transition(record, "starting", "attached", {}, timestamp);
		return this.snapshot(record);
	}

	register(input: MonitorRecordInput): MonitorRecord {
		return this.attach(input);
	}

	update(monitorId: string, update: MonitorRecordUpdate): MonitorRecord {
		const record = this.requireRecord(monitorId);
		let factsChanged = false;
		if (update.diagnostic) factsChanged = this.addDiagnostic(record, update.diagnostic) || factsChanged;
		if (update.activity) this.appendActivity(record, update.activity);
		const changed = this.transition(
			record,
			update.status,
			update.reason,
			{ exitReason: update.exitReason, exitCode: update.exitCode },
			update.timestamp ?? this.now(),
		);
		if (factsChanged && !changed) this.persist(record);
		return this.snapshot(record);
	}

	status(monitorId: string): MonitorRecord {
		const record = this.requireRecord(monitorId);
		return this.snapshot(record);
	}

	async wait(monitorId: string, timeoutMs?: number, signal?: AbortSignal): Promise<MonitorRecord> {
		if (signal?.aborted) throw monitorWaitAbortError();
		const record = this.requireRecord(monitorId);
		if (isMonitorTerminal(record.status)) return this.snapshot(record);
		await this.poll();
		if (signal?.aborted) throw monitorWaitAbortError();
		const current = this.requireRecord(monitorId);
		if (isMonitorTerminal(current.status)) return this.snapshot(current);
		const result = await new Promise<MonitorRecord>((resolve, reject) => {
			const waiters = this.waiters.get(monitorId) ?? new Set<Waiter>();
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = (): void => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				waiters.delete(waiter);
				if (waiters.size === 0) this.waiters.delete(monitorId);
			};
			const settle = (callback: () => void): void => {
				if (settled) return;
				settled = true;
				cleanup();
				callback();
			};
			const waiter: Waiter = {
				resolve: (nextRecord) => settle(() => resolve(nextRecord)),
			};
			const onAbort = (): void => settle(() => reject(monitorWaitAbortError()));
			waiters.add(waiter);
			this.waiters.set(monitorId, waiters);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) {
				onAbort();
				return;
			}
			if (timeoutMs !== undefined) {
				timer = setTimeout(
					() => settle(() => reject(new Error(`Timed out waiting for monitor ${monitorId}`))),
					Math.max(1, Math.floor(timeoutMs)),
				);
			}
		});
		return this.snapshot(result);
	}

	async stop(monitorId: string, force = false): Promise<{ record: MonitorRecord; result: MonitorStopResult }> {
		const record = this.requireRecord(monitorId);
		if (isMonitorTerminal(record.status))
			return { record: this.snapshot(record), result: { accepted: false, reason: "terminal" } };
		const adapter = this.adapters.get(record.kind);
		const result = adapter?.stop ? await adapter.stop(record, force) : { accepted: false, reason: "not_cancellable" };
		if (result.accepted) this.transition(record, "cancelled", "stopped", { exitReason: result.reason });
		await this.flushEvents();
		return { record: this.snapshot(record), result };
	}

	async logs(monitorId: string, options: MonitorLogOptions = {}): Promise<MonitorLogResult> {
		const record = this.requireRecord(monitorId);
		const path = record.logPath ?? record.target.logPath;
		if (!path && record.activityLog.length > 0) {
			const firstSequence = record.activityLog[0]?.sequence ?? 1;
			const requestedCursor = options.mode === "full" ? 0 : (options.cursor ?? record.logCursor);
			const truncated = requestedCursor < firstSequence - 1;
			const effectiveCursor = truncated ? firstSequence - 1 : requestedCursor;
			const events =
				options.mode === "full"
					? record.activityLog
					: record.activityLog.filter((event) => event.sequence > effectiveCursor);
			const content = events.length > 0 ? `${events.map(formatActivityEvent).join("\n")}\n` : "";
			const cursor = events.at(-1)?.sequence ?? effectiveCursor;
			const hash = activityLogHash(record.activityLog);
			if (options.mode !== "full" && (events.length > 0 || truncated)) {
				record.logCursor = cursor;
				record.logHash = hash;
				record.logPrefixHash = hash;
				if (truncated) this.addDiagnostic(record, "Monitor activity log was truncated by its bounded buffer");
				this.persist(record);
			}
			return {
				monitor: this.snapshot(record),
				path: `monitor:${record.id}:activity`,
				content,
				cursor,
				hash,
				prefixHash: hash,
				changed: events.length > 0,
				truncated,
				rotated: false,
				missing: false,
				diagnostic: truncated ? "Monitor activity log was truncated by its bounded buffer" : undefined,
			};
		}
		if (!path) {
			return {
				monitor: this.snapshot(record),
				path: "",
				content: "",
				cursor: record.logCursor,
				hash: record.logHash ?? "",
				prefixHash: record.logPrefixHash ?? "",
				changed: false,
				truncated: false,
				rotated: false,
				missing: true,
				diagnostic: "Monitor has no log path or activity events",
			};
		}
		const result = await this.logReader.read({
			monitorId,
			path,
			cursor: options.cursor ?? record.logCursor,
			hash: record.logHash,
			prefixHash: record.logPrefixHash,
			mode: options.mode,
		});
		if (options.mode !== "full") {
			const changed = record.logCursor !== result.cursor || record.logHash !== result.hash;
			record.logCursor = result.cursor;
			record.logHash = result.hash;
			record.logPrefixHash = result.prefixHash;
			if (result.path && record.logPath !== result.path) record.logPath = result.path;
			if (result.diagnostic) this.addDiagnostic(record, result.diagnostic);
			if (result.truncated) this.addDiagnostic(record, "Log file was truncated; cursor restarted at zero");
			if (result.rotated) this.addDiagnostic(record, "Log file was rotated; cursor restarted at zero");
			if (changed) this.persist(record);
		}
		return { ...result, monitor: this.snapshot(record) };
	}

	async flushEvents(): Promise<void> {
		await this.eventQueue;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopPolling();
		this.sessionUnsubscribe?.();
		this.poolUnsubscribe?.();
		this.sessionUnsubscribe = undefined;
		this.poolUnsubscribe = undefined;
		for (const [monitorId, waiters] of this.waiters) {
			const record = this.records.get(monitorId);
			if (!record) continue;
			const snapshot = this.snapshot(record);
			for (const waiter of waiters) waiter.resolve(snapshot);
		}
		this.waiters.clear();
		this.listeners.clear();
		this.pendingToolExecutions.clear();
		this.logReader.clear();
	}

	private shouldRestoreRecord(record: MonitorRecord): boolean {
		if (record.kind !== "tool" || record.target.kind !== "tool") return true;
		if (record.target.attachment === "explicit" || record.target.attachment === "long-running") return true;
		const legacyAutomaticSummary = `${record.target.toolName ?? "tool"} Tool execution`;
		if (record.taskSummary !== legacyAutomaticSummary) return true;
		return record.target.toolName === "bash" && record.durationMs >= this.longRunningBashThresholdMs;
	}

	private restoreRecords(entries: readonly SessionEntry[]): void {
		for (const entry of entries) {
			const record = snapshotFromEntry(entry);
			if (!record || record.sessionId !== this.sessionId || !this.shouldRestoreRecord(record)) continue;
			this.records.set(record);
			if (!isMonitorTerminal(record.status)) this.restoredRecordIds.add(record.id);
		}
	}

	private snapshot(record: MonitorRecord | undefined): MonitorRecord {
		if (!record) throw new Error("Monitor record is unavailable");
		const result = clone(record);
		const timestamp = this.now();
		result.durationMs = Math.max(0, (record.completedAt ?? timestamp) - (record.startedAt ?? record.createdAt));
		return result;
	}

	private requireRecord(monitorId: string): MonitorRecord {
		const record = this.records.get(monitorId);
		if (!record) throw new Error(`Unknown monitor id ${JSON.stringify(monitorId)}`);
		return record;
	}

	private persist(record: MonitorRecord): void {
		this.sessionManager.appendCustomEntry(MONITOR_SESSION_ENTRY_TYPE, {
			version: MONITOR_RECORD_VERSION,
			record: this.snapshot(record),
		});
	}

	private addDiagnostic(record: MonitorRecord, diagnostic: string): boolean {
		if (!diagnostic || record.diagnostics.includes(diagnostic)) return false;
		record.diagnostics.push(diagnostic);
		return true;
	}

	private appendActivity(record: MonitorRecord, activity: Omit<MonitorActivityEvent, "sequence">): void {
		const sequence = (record.activityLog.at(-1)?.sequence ?? 0) + 1;
		record.activityLog.push({ ...activity, sequence });
		if (record.activityLog.length > MONITOR_ACTIVITY_LOG_LIMIT) {
			record.activityLog.splice(0, record.activityLog.length - MONITOR_ACTIVITY_LOG_LIMIT);
		}
		record.lastActivityAt = Math.max(record.lastActivityAt, activity.timestamp);
		this.persist(record);
	}

	private applyAdapterSnapshot(record: MonitorRecord, snapshot: MonitorAdapterSnapshot, timestamp: number): void {
		let factsChanged = false;
		if (snapshot.logPath && record.logPath !== snapshot.logPath) {
			record.logPath = snapshot.logPath;
			record.target = { ...record.target, logPath: snapshot.logPath };
			factsChanged = true;
		}
		if (snapshot.resources && JSON.stringify(record.resources) !== JSON.stringify(snapshot.resources)) {
			record.resources = clone(snapshot.resources);
			factsChanged = true;
		}
		for (const diagnostic of snapshot.diagnostics ?? []) {
			factsChanged = this.addDiagnostic(record, diagnostic) || factsChanged;
		}
		if (snapshot.lastActivityAt !== undefined && snapshot.lastActivityAt > record.lastActivityAt) {
			record.lastActivityAt = snapshot.lastActivityAt;
			factsChanged = true;
		}
		if (snapshot.running === false) {
			const status = snapshot.cancelled ? "cancelled" : snapshot.exitCode === 0 ? "completed" : "failed";
			const stateChanged = this.transition(
				record,
				status,
				status === "cancelled" ? "cancelled" : status === "completed" ? "completed" : "failed",
				{
					exitCode: snapshot.exitCode,
					exitReason: snapshot.exitReason ?? (status === "completed" ? "exit_0" : "exit_nonzero"),
				},
				timestamp,
			);
			if (factsChanged && !stateChanged) this.persist(record);
			return;
		}
		if (snapshot.running !== true) {
			if (factsChanged) this.persist(record);
			return;
		}
		if (
			record.status === "stalled" &&
			(snapshot.lastActivityAt === undefined || snapshot.lastActivityAt <= record.lastActivityAt)
		) {
			if (factsChanged) this.persist(record);
			return;
		}
		const nextStatus: MonitorStatus = snapshot.healthy === true ? "healthy" : "running";
		const stateChanged = this.transition(
			record,
			nextStatus,
			snapshot.healthy === true ? "healthy" : "started",
			{},
			timestamp,
		);
		if (factsChanged && !stateChanged) this.persist(record);
	}

	private checkStalled(record: MonitorRecord, timestamp: number): void {
		if (isMonitorTerminal(record.status) || record.stallTimeoutMs === undefined) return;
		if (timestamp - record.lastActivityAt >= record.stallTimeoutMs) {
			this.transition(record, "stalled", "stalled", { exitReason: "no_activity" }, timestamp);
		} else if (record.status === "stalled") {
			this.transition(record, "healthy", "activity", {}, timestamp);
		}
	}

	private transition(
		record: MonitorRecord,
		status: MonitorStatus,
		reason: MonitorEventReason,
		extra: { exitReason?: string; exitCode?: number },
		timestamp = this.now(),
	): boolean {
		if (!transitionAllowed(record.status, status)) return false;
		const previousStatus = record.status === status ? undefined : record.status;
		const changed = previousStatus !== undefined;
		if (status === "running" || status === "healthy") {
			const firstStart = record.startedAt === undefined;
			record.startedAt ??= timestamp;
			if (firstStart || reason === "activity") record.lastActivityAt = Math.max(record.lastActivityAt, timestamp);
		}
		if (extra.exitReason !== undefined) record.exitReason = extra.exitReason;
		if (extra.exitCode !== undefined) record.exitCode = extra.exitCode;
		if (changed) record.status = status;
		if (isMonitorTerminal(status)) {
			record.completedAt ??= timestamp;
			record.durationMs = Math.max(0, record.completedAt - (record.startedAt ?? record.createdAt));
		}
		const eventKey = `${status}:${reason}:${record.exitReason ?? ""}:${record.exitCode ?? ""}`;
		const shouldEmit = record.lastEventKey !== eventKey && (changed || status === "starting");
		if (shouldEmit) {
			record.lastEventKey = eventKey;
			this.persist(record);
			this.emitStatus(record, previousStatus, reason, timestamp);
		}
		if (!changed && !shouldEmit && extra.exitReason === undefined && extra.exitCode === undefined) return false;
		if (isMonitorTerminal(status)) this.resolveWaiters(record);
		return changed;
	}

	private emitStatus(
		record: MonitorRecord,
		previousStatus: MonitorStatus | undefined,
		reason: MonitorEventReason,
		timestamp: number,
	): void {
		const event: MonitorLifecycleEvent = {
			id: `${record.id}:${record.lastEventKey ?? `${record.status}:${reason}`}`,
			monitorId: record.id,
			sessionId: record.sessionId,
			kind: record.kind,
			name: record.name,
			taskSummary: record.taskSummary,
			status: record.status,
			previousStatus,
			reason,
			timestamp,
			durationMs: record.durationMs,
			exitReason: record.exitReason,
			exitCode: record.exitCode,
		};
		this.eventQueue = this.eventQueue
			.then(async () => {
				for (const listener of this.listeners) await listener(event);
			})
			.catch(() => {
				// Observers are non-authoritative and cannot break monitoring.
			});
	}

	private resolveWaiters(record: MonitorRecord): void {
		const waiters = this.waiters.get(record.id);
		if (!waiters) return;
		this.waiters.delete(record.id);
		const snapshot = this.snapshot(record);
		for (const waiter of waiters) waiter.resolve(snapshot);
	}

	private async handleAgentEvent(event: AgentSessionEvent, signal?: AbortSignal): Promise<void> {
		if (this.disposed) return;
		if (event.type === "tool_execution_start") {
			const record = this.findTool(event.toolCallId);
			if (record) {
				this.transition(record, "running", "started", {});
				return;
			}
			if (event.toolName === "bash") {
				const timestamp = this.now();
				this.pendingToolExecutions.set(event.toolCallId, {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					startedAt: timestamp,
					lastActivityAt: timestamp,
				});
			}
			return;
		}
		if (event.type === "tool_execution_update") {
			const timestamp = this.now();
			const pending = this.pendingToolExecutions.get(event.toolCallId);
			if (pending) pending.lastActivityAt = timestamp;
			const record =
				this.findTool(event.toolCallId) ?? (pending ? this.promoteLongRunningBash(pending, timestamp) : undefined);
			if (!record) return;
			record.lastActivityAt = timestamp;
			this.transition(record, "healthy", "activity", {});
			return;
		}
		if (event.type === "tool_execution_end") {
			const timestamp = this.now();
			const pending = this.pendingToolExecutions.get(event.toolCallId);
			this.pendingToolExecutions.delete(event.toolCallId);
			const record =
				this.findTool(event.toolCallId) ?? (pending ? this.promoteLongRunningBash(pending, timestamp) : undefined);
			if (!record) return;
			const cancelled = isToolCancelled(event, signal);
			this.transition(
				record,
				cancelled ? "cancelled" : event.isError ? "failed" : "completed",
				cancelled ? "cancelled" : event.isError ? "failed" : "completed",
				{ exitReason: cancelled ? "cancelled" : event.isError ? "tool_error" : "tool_completed" },
				timestamp,
			);
		}
	}

	private promoteLongRunningBash(pending: PendingToolExecution, timestamp: number): MonitorRecord | undefined {
		if (timestamp - pending.startedAt < this.longRunningBashThresholdMs) return this.findTool(pending.toolCallId);
		const existing = this.findTool(pending.toolCallId);
		const record =
			existing ??
			this.requireRecord(
				this.attach({
					target: {
						kind: "tool",
						toolCallId: pending.toolCallId,
						toolName: pending.toolName,
						attachment: "long-running",
					},
					name: pending.toolName,
					taskSummary: `${pending.toolName} long-running Tool execution`,
					createdAt: pending.startedAt,
				}).id,
			);
		this.transition(record, "running", "started", {}, pending.startedAt);
		if (pending.lastActivityAt > record.lastActivityAt) {
			record.lastActivityAt = pending.lastActivityAt;
			this.transition(record, "healthy", "activity", {}, pending.lastActivityAt);
		}
		return record;
	}

	private async handleAgentLifecycleEvent(event: AgentLifecycleEvent): Promise<void> {
		if (this.disposed) return;
		const mapped = monitorStatusForAgentEvent(event);
		const attached = this.attach({
			target: { kind: "sub-agent", taskId: event.taskId, profile: event.profile },
			name: `Agent(${event.profile})`,
			taskSummary: event.taskSummary,
		});
		const record = this.requireRecord(attached.id);
		if (event.type === "progress" && event.message) {
			this.appendActivity(record, {
				timestamp: event.timestamp,
				kind: event.toolName ? "tool" : "turn",
				turn: event.turn,
				toolName: event.toolName,
				targetPath: event.targetPath,
				outcome: event.outcome ?? "started",
				message: event.message,
			});
			const adapter = this.adapters.get("sub-agent");
			if (adapter instanceof SubAgentMonitorAdapter)
				adapter.setSnapshot(event.taskId, { availability: "confirmed", running: true });
		}
		if (event.budget) {
			record.agentTask = {
				errorCode: event.error?.code,
				turnsUsed: event.budget.turnsUsed,
				maxTurns: event.budget.maxTurns,
				tokensUsed: event.budget.tokensUsed,
				maxTokens: event.budget.maxTokens,
				timeoutMs: event.budget.timeoutMs,
				idleTimeoutMs: event.budget.idleTimeoutMs,
				lastToolName: event.lastActivity?.toolName,
				lastTargetPath: event.lastActivity?.targetPath,
			};
			if (event.error?.message) this.addDiagnostic(record, event.error.message);
			this.appendActivity(record, {
				timestamp: event.timestamp,
				kind: "agent",
				turn: event.budget.turnsUsed,
				toolName: event.lastActivity?.toolName,
				targetPath: event.lastActivity?.targetPath,
				outcome: event.type === "completed" ? "succeeded" : "failed",
				message: event.error?.code ?? event.type,
			});
		}
		this.transition(record, mapped.status, mapped.reason, { exitReason: mapped.exitReason }, event.timestamp);
	}

	private findTool(toolCallId: string): MonitorRecord | undefined {
		return [...this.records.values()].find(
			(record) => record.kind === "tool" && record.target.kind === "tool" && record.target.toolCallId === toolCallId,
		);
	}
}

export { FakeProcessAdapter, formatDuration, stableMonitorId };
