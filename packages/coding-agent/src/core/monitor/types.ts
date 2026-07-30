import type { AgentLifecycleEvent } from "../agents/agent-pool.ts";

export const MONITOR_RECORD_VERSION = 1;
export const MONITOR_SESSION_ENTRY_TYPE = "beaupi.monitor.record";

export type MonitorKind = "process" | "tool" | "sub-agent" | "ssh-tmux";

export type MonitorStatus =
	| "starting"
	| "running"
	| "healthy"
	| "stalled"
	| "completed"
	| "failed"
	| "cancelled"
	| "lost";

export type MonitorTerminalStatus = Extract<MonitorStatus, "completed" | "failed" | "cancelled" | "lost">;

export type MonitorEventReason =
	| "attached"
	| "started"
	| "activity"
	| "healthy"
	| "stalled"
	| "completed"
	| "failed"
	| "cancelled"
	| "timeout"
	| "target_lost"
	| "log_missing"
	| "stopped";

export interface MonitorResourceSnapshot {
	cpuPercent?: number;
	cpuTimeMs?: number;
	memoryBytes?: number;
	availableMemoryBytes?: number;
	processCount?: number;
}

export interface ProcessMonitorTarget {
	kind: "process";
	pid: number;
	logPath?: string;
}

export interface ToolMonitorTarget {
	kind: "tool";
	toolCallId: string;
	toolName?: string;
	logPath?: string;
}

export interface SubAgentMonitorTarget {
	kind: "sub-agent";
	taskId: string;
	profile?: string;
	logPath?: string;
}

export interface SshTmuxMonitorTarget {
	kind: "ssh-tmux";
	targetId?: string;
	/** M7 resource tracked by this record. M6 attachments may omit it. */
	resource?: "connection" | "command" | "terminal";
	/** Stable operation/terminal id, never an auth credential. */
	operationId?: string;
	sessionId?: string;
	logPath?: string;
}

export type MonitorTarget = ProcessMonitorTarget | ToolMonitorTarget | SubAgentMonitorTarget | SshTmuxMonitorTarget;

export interface MonitorRecord {
	version: typeof MONITOR_RECORD_VERSION;
	id: string;
	sessionId: string;
	target: MonitorTarget;
	kind: MonitorKind;
	name: string;
	taskSummary: string;
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
	durationMs: number;
	lastActivityAt: number;
	status: MonitorStatus;
	exitReason?: string;
	exitCode?: number;
	resources?: MonitorResourceSnapshot;
	logPath?: string;
	logCursor: number;
	logHash?: string;
	logPrefixHash?: string;
	stallTimeoutMs?: number;
	timeoutMs?: number;
	lastEventKey?: string;
	diagnostics: string[];
}

export interface MonitorRecordInput {
	id?: string;
	sessionId?: string;
	target: MonitorTarget;
	name?: string;
	taskSummary?: string;
	createdAt?: number;
	stallTimeoutMs?: number;
	timeoutMs?: number;
}

export interface MonitorLifecycleEvent {
	id: string;
	monitorId: string;
	sessionId: string;
	kind: MonitorKind;
	name: string;
	taskSummary: string;
	status: MonitorStatus;
	previousStatus?: MonitorStatus;
	reason: MonitorEventReason;
	timestamp: number;
	durationMs: number;
	exitReason?: string;
	exitCode?: number;
}

export type MonitorLifecycleEventListener = (event: MonitorLifecycleEvent) => void | Promise<void>;

export interface MonitorAdapterSnapshot {
	availability: "confirmed" | "missing" | "unknown";
	running?: boolean;
	healthy?: boolean;
	cancelled?: boolean;
	exitCode?: number;
	exitReason?: string;
	lastActivityAt?: number;
	resources?: MonitorResourceSnapshot;
	logPath?: string;
	diagnostics?: string[];
}

export interface MonitorStopResult {
	accepted: boolean;
	reason?: string;
}

export interface MonitorAdapter {
	readonly kind: MonitorKind;
	poll(record: MonitorRecord, now: number): Promise<MonitorAdapterSnapshot> | MonitorAdapterSnapshot;
	stop?(record: MonitorRecord, force: boolean): Promise<MonitorStopResult> | MonitorStopResult;
}

export interface MonitorSummary {
	total: number;
	starting: number;
	running: number;
	healthy: number;
	stalled: number;
	completed: number;
	failed: number;
	cancelled: number;
	lost: number;
}

export interface MonitorSessionEntryData {
	version: typeof MONITOR_RECORD_VERSION;
	record: MonitorRecord;
}

export function isMonitorTerminal(status: MonitorStatus): status is MonitorTerminalStatus {
	return status === "completed" || status === "failed" || status === "cancelled" || status === "lost";
}

export function monitorStatusLabel(status: MonitorStatus): string {
	return status;
}

export function monitorStatusForAgentEvent(event: AgentLifecycleEvent): {
	status: MonitorStatus;
	reason: MonitorEventReason;
	exitReason?: string;
} {
	switch (event.type) {
		case "started":
			return { status: "starting", reason: "attached" };
		case "running":
			return { status: "running", reason: "started" };
		case "progress":
			return { status: "healthy", reason: "activity" };
		case "completed":
			return { status: "completed", reason: "completed" };
		case "cancelled":
			return { status: "cancelled", reason: "cancelled", exitReason: event.error?.message ?? "cancelled" };
		case "timed_out":
			return { status: "failed", reason: "timeout", exitReason: event.error?.message ?? "timed out" };
		case "failed":
			return { status: "failed", reason: "failed", exitReason: event.error?.message ?? "agent failed" };
	}
}
