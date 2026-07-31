import { existsSync, statSync } from "node:fs";
import { kill } from "node:process";
import type { AgentPool } from "../agents/agent-pool.ts";
import type { MonitorAdapter, MonitorAdapterSnapshot, MonitorKind, MonitorRecord, MonitorStopResult } from "./types.ts";

function processKey(record: MonitorRecord): string {
	if (record.target.kind !== "process") return record.id;
	return `pid:${record.target.pid}`;
}

function logActivity(record: MonitorRecord): number | undefined {
	const logPath = record.logPath ?? record.target.logPath;
	if (!logPath || !existsSync(logPath)) return undefined;
	try {
		return statSync(logPath).mtimeMs;
	} catch {
		return undefined;
	}
}

/**
 * Low-cost local process observation. An exited process cannot be classified as
 * successful because an arbitrary PID does not expose its exit code; it is
 * therefore reported as missing/lost unless a richer adapter confirms it.
 */
export class NodeProcessMonitorAdapter implements MonitorAdapter {
	readonly kind: MonitorKind = "process";

	poll(record: MonitorRecord): MonitorAdapterSnapshot {
		if (record.target.kind !== "process") {
			return { availability: "unknown", diagnostics: ["Process adapter received a non-process target"] };
		}

		try {
			kill(record.target.pid, 0);
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
			if (code === "EPERM") {
				return {
					availability: "confirmed",
					running: true,
					lastActivityAt: logActivity(record),
				};
			}
			return { availability: "missing", exitReason: "process_missing" };
		}

		return {
			availability: "confirmed",
			running: true,
			lastActivityAt: logActivity(record),
		};
	}

	stop(record: MonitorRecord, force: boolean): MonitorStopResult {
		if (record.target.kind !== "process") return { accepted: false, reason: "not_a_process" };
		try {
			kill(record.target.pid, force ? "SIGKILL" : "SIGTERM");
			return { accepted: true, reason: force ? "SIGKILL" : "SIGTERM" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { accepted: false, reason: message };
		}
	}
}

/** A process adapter with deterministic snapshots for unit and faux-provider tests. */
export class FakeProcessAdapter implements MonitorAdapter {
	readonly kind: MonitorKind = "process";
	private readonly snapshots = new Map<string, MonitorAdapterSnapshot>();
	private readonly stopResults = new Map<string, MonitorStopResult>();

	setSnapshot(key: string | number, snapshot: MonitorAdapterSnapshot): void {
		this.snapshots.set(typeof key === "number" ? `pid:${key}` : key, { ...snapshot });
	}

	setRunning(key: string | number, running: boolean, exitCode?: number): void {
		this.setSnapshot(key, {
			availability: "confirmed",
			running,
			healthy: running,
			exitCode,
			exitReason: running ? undefined : exitCode === 0 ? "exit_0" : "exit_nonzero",
		});
	}

	setStopResult(key: string | number, result: MonitorStopResult): void {
		this.stopResults.set(typeof key === "number" ? `pid:${key}` : key, result);
	}

	poll(record: MonitorRecord): MonitorAdapterSnapshot {
		return (
			this.snapshots.get(processKey(record)) ??
			this.snapshots.get(record.id) ?? {
				availability: "unknown",
			}
		);
	}

	stop(record: MonitorRecord, _force: boolean): MonitorStopResult {
		return (
			this.stopResults.get(processKey(record)) ??
			this.stopResults.get(record.id) ?? {
				accepted: true,
				reason: "fake_stop",
			}
		);
	}
}

/**
 * Event-driven Tool adapter. Tool state comes from AgentSession events; polling
 * deliberately does not infer business status from output text.
 */
export class ToolMonitorAdapter implements MonitorAdapter {
	readonly kind: MonitorKind = "tool";
	private readonly snapshots = new Map<string, MonitorAdapterSnapshot>();

	setSnapshot(toolCallId: string, snapshot: MonitorAdapterSnapshot): void {
		this.snapshots.set(toolCallId, { ...snapshot });
	}

	poll(record: MonitorRecord): MonitorAdapterSnapshot {
		if (record.target.kind !== "tool") return { availability: "unknown" };
		return this.snapshots.get(record.target.toolCallId) ?? { availability: "unknown" };
	}
}

/** Deterministic Tool adapter used by MonitorRuntime tests. */
export class FakeToolAdapter extends ToolMonitorAdapter {
	stop(): MonitorStopResult {
		return { accepted: true, reason: "fake_tool_stop" };
	}
}

/**
 * Event-driven sub-agent adapter. AgentPool lifecycle events are authoritative;
 * this adapter only supplies cancellation and optional test snapshots.
 */
export class SubAgentMonitorAdapter implements MonitorAdapter {
	readonly kind: MonitorKind = "sub-agent";
	private readonly snapshots = new Map<string, MonitorAdapterSnapshot>();
	private readonly pool?: AgentPool;

	constructor(pool?: AgentPool) {
		this.pool = pool;
	}

	setSnapshot(taskId: string, snapshot: MonitorAdapterSnapshot): void {
		this.snapshots.set(taskId, { ...snapshot });
	}

	poll(record: MonitorRecord): MonitorAdapterSnapshot {
		if (record.target.kind !== "sub-agent") return { availability: "unknown" };
		return this.snapshots.get(record.target.taskId) ?? { availability: "unknown" };
	}

	stop(record: MonitorRecord): MonitorStopResult {
		if (record.target.kind !== "sub-agent") return { accepted: false, reason: "not_a_sub_agent" };
		if (!this.pool) return { accepted: false, reason: "agent_pool_unavailable" };
		return this.pool.cancelTask(record.target.taskId)
			? { accepted: true, reason: "agent_cancel_requested" }
			: { accepted: false, reason: "agent_task_not_active" };
	}
}

export class FakeSubAgentAdapter extends SubAgentMonitorAdapter {
	stop(): MonitorStopResult {
		return { accepted: true, reason: "fake_agent_stop" };
	}
}

export interface WorkflowMonitorSource {
	poll(workflowId: string, nodeId: string | undefined): MonitorAdapterSnapshot;
	cancel(workflowId: string): boolean;
}

/** Event-driven Workflow adapter backed by the existing Workflow Runtime. */
export class WorkflowMonitorAdapter implements MonitorAdapter {
	readonly kind = "workflow" as const;
	private readonly source?: WorkflowMonitorSource;

	constructor(source?: WorkflowMonitorSource) {
		this.source = source;
	}

	poll(record: MonitorRecord): MonitorAdapterSnapshot {
		if (record.target.kind !== "workflow") return { availability: "unknown" };
		return this.source?.poll(record.target.workflowId, record.target.nodeId) ?? { availability: "unknown" };
	}

	stop(record: MonitorRecord): MonitorStopResult {
		if (record.target.kind !== "workflow") return { accepted: false, reason: "not_a_workflow" };
		if (!this.source) return { accepted: false, reason: "workflow_runtime_unavailable" };
		return this.source.cancel(record.target.workflowId)
			? { accepted: true, reason: "workflow_cancel_requested" }
			: { accepted: false, reason: "workflow_not_active" };
	}
}

/** Reserved M7 adapter shape. M6 never opens a remote connection. */
export interface SshTmuxMonitorAdapter extends MonitorAdapter {
	readonly kind: "ssh-tmux";
}

export class UnimplementedSshTmuxMonitorAdapter implements SshTmuxMonitorAdapter {
	readonly kind = "ssh-tmux" as const;

	poll(): MonitorAdapterSnapshot {
		return {
			availability: "unknown",
			diagnostics: ["SSH/tmux monitoring is reserved for M7"],
		};
	}

	stop(): MonitorStopResult {
		return { accepted: false, reason: "ssh_tmux_not_implemented" };
	}
}
