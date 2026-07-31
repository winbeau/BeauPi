import type { ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { spawnProcess } from "../../utils/child-process.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import { NodeProcessMonitorAdapter } from "../monitor/adapters.ts";
import type { MonitorAdapter, MonitorAdapterSnapshot, MonitorRecord, MonitorStopResult } from "../monitor/types.ts";

interface ProcessState {
	child: ChildProcess;
	pid: number;
	exitCode?: number;
	exitReason?: string;
	cancelled: boolean;
	running: boolean;
}

export interface BackgroundChildHandle {
	pid: number;
	child: ChildProcess;
	state: ProcessState;
}

/**
 * Monitor adapter for processes started by BackgroundTaskManager. It retains
 * exit facts after the PID disappears and delegates unknown process targets to
 * the existing Monitor process adapter.
 */
export class BackgroundProcessAdapter implements MonitorAdapter {
	readonly kind = "process" as const;
	private readonly fallback: MonitorAdapter;
	private readonly states = new Map<string, ProcessState>();

	constructor(fallback: MonitorAdapter = new NodeProcessMonitorAdapter()) {
		this.fallback = fallback;
	}

	async spawn(executable: string, args: string[], cwd: string, logPath: string): Promise<BackgroundChildHandle> {
		await mkdir(dirname(logPath), { recursive: true });
		const file = await open(logPath, "a", 0o600);
		const child = spawnProcess(executable, args, {
			cwd,
			detached: process.platform !== "win32",
			shell: false,
			stdio: ["ignore", file.fd, file.fd],
			windowsHide: true,
		});
		const state: ProcessState = { child, pid: child.pid ?? 0, cancelled: false, running: true };
		child.once("exit", (code, signal) => {
			state.running = false;
			state.exitCode = code ?? (signal ? 1 : 0);
			state.exitReason = signal ? `signal_${signal}` : code === 0 ? "exit_0" : "exit_nonzero";
			if (state.pid > 0) untrackDetachedChildPid(state.pid);
		});
		try {
			await new Promise<void>((resolveSpawn, rejectSpawn) => {
				const onSpawn = (): void => {
					child.removeListener("error", onError);
					resolveSpawn();
				};
				const onError = (error: Error): void => {
					child.removeListener("spawn", onSpawn);
					state.running = false;
					state.exitCode = 1;
					state.exitReason = error.message;
					rejectSpawn(error);
				};
				child.once("spawn", onSpawn);
				child.once("error", onError);
			});
		} finally {
			await file.close();
		}
		if (!child.pid) throw new Error(`Unable to start background executable ${JSON.stringify(executable)}`);
		state.pid = child.pid;
		trackDetachedChildPid(child.pid);
		return { pid: child.pid, child, state };
	}

	register(monitorId: string, handle: BackgroundChildHandle): void {
		this.states.set(monitorId, handle.state);
	}

	unregister(monitorId: string): void {
		this.states.delete(monitorId);
	}

	isRunning(monitorId: string): boolean {
		return this.states.get(monitorId)?.running ?? false;
	}

	poll(record: MonitorRecord, now: number): MonitorAdapterSnapshot | Promise<MonitorAdapterSnapshot> {
		if (record.target.kind !== "process") return { availability: "unknown" };
		const state = this.states.get(record.id);
		if (!state) return this.fallback.poll(record, now);
		if (!state.running) {
			return {
				availability: "confirmed",
				running: false,
				cancelled: state.cancelled,
				exitCode: state.exitCode,
				exitReason: state.exitReason,
				lastActivityAt: fileActivity(record),
			};
		}
		return { availability: "confirmed", running: true, healthy: true, lastActivityAt: fileActivity(record) };
	}

	async stop(record: MonitorRecord, force: boolean): Promise<MonitorStopResult> {
		if (record.target.kind !== "process") return { accepted: false, reason: "not_a_process" };
		const state = this.states.get(record.id);
		if (!state) return (await this.fallback.stop?.(record, force)) ?? { accepted: false, reason: "not_cancellable" };
		if (!state.running) return { accepted: false, reason: "already_exited" };
		state.cancelled = true;
		if (force) killProcessTree(state.pid);
		else terminateProcessGroup(state.pid, state.child);
		return { accepted: true, reason: force ? "SIGKILL" : "SIGTERM" };
	}

	forceStop(monitorId: string): MonitorStopResult {
		const state = this.states.get(monitorId);
		if (!state || !state.running) return { accepted: false, reason: "already_exited" };
		return this.forceStopState(state);
	}

	forceStopHandle(handle: BackgroundChildHandle): MonitorStopResult {
		return handle.state.running ? this.forceStopState(handle.state) : { accepted: false, reason: "already_exited" };
	}

	private forceStopState(state: ProcessState): MonitorStopResult {
		state.cancelled = true;
		killProcessTree(state.pid);
		return { accepted: true, reason: "SIGKILL" };
	}
}

function terminateProcessGroup(pid: number, child: ChildProcess): void {
	try {
		if (process.platform === "win32") child.kill("SIGTERM");
		else process.kill(-pid, "SIGTERM");
	} catch {
		try {
			child.kill("SIGTERM");
		} catch {
			// The process exited between observation and signal delivery.
		}
	}
}

function fileActivity(record: MonitorRecord): number | undefined {
	const path = record.logPath ?? record.target.logPath;
	if (!path) return undefined;
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}
