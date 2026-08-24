import { type ChildProcess, spawn } from "node:child_process";
import { kill as killProcess } from "node:process";
import type { Readable } from "node:stream";
import {
	type AgentDiagnosticV1,
	type ExecAcceptedV1,
	type ExecExitEventV1,
	type ExecOutputEventV1,
	type ExecStartRequestV1,
	REMOTE_AGENT_MAX_OUTPUT_CHUNK_BYTES,
} from "../core/remote-agent/protocol.ts";

export interface ExecServiceCallbacks {
	onOutput: (event: ExecOutputEventV1) => void;
	onExit: (event: ExecExitEventV1) => void;
}

export type ExecProcessFactory = (command: string, cwd: string) => ChildProcess;

export interface ExecServiceOptions {
	maxConcurrentExec?: number;
	maxQueuedExec?: number;
	terminationGraceMs?: number;
	now?: () => number;
	spawnProcess?: ExecProcessFactory;
	shell?: string;
}

interface QueuedOperation {
	request: ExecStartRequestV1;
	callbacks: ExecServiceCallbacks;
	resolve: (accepted: ExecAcceptedV1) => void;
	reject: (error: unknown) => void;
	state: "queued" | "starting" | "running" | "terminal";
}

interface ActiveOperation extends QueuedOperation {
	child: ChildProcess;
	startedAt: number;
	sequence: number;
	timedOut: boolean;
	cancelled: boolean;
	finished: boolean;
	terminationTimer?: NodeJS.Timeout;
	completion: Promise<void>;
	resolveCompletion: () => void;
}

export class ExecServiceError extends Error {
	readonly diagnostic: AgentDiagnosticV1;

	constructor(code: string, message: string, operationId?: string) {
		super(message);
		this.name = "ExecServiceError";
		this.diagnostic = {
			code,
			message: message.replace(/[\r\n\t]+/g, " ").slice(0, 500),
			retryable: code === "agent_busy",
			operationId,
			executionState: code === "agent_cancelled" ? "not_started" : undefined,
		};
	}
}

function defaultSpawn(command: string, cwd: string): ChildProcess {
	const shell = process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : "/bin/sh";
	return spawn(shell, ["-c", command], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});
}

function chunkBuffer(data: Buffer, size: number): Buffer[] {
	const chunks: Buffer[] = [];
	for (let offset = 0; offset < data.length; offset += size)
		chunks.push(data.subarray(offset, Math.min(data.length, offset + size)));
	return chunks;
}

function diagnosticForServiceError(error: unknown, operationId: string): AgentDiagnosticV1 {
	if (error instanceof ExecServiceError) return error.diagnostic;
	return {
		code: "agent_internal",
		message:
			error instanceof Error ? error.message.replace(/[\r\n\t]+/g, " ").slice(0, 500) : "Agent execution failed",
		retryable: false,
		operationId,
		executionState: "not_started",
	};
}

export class ExecService {
	private readonly maxConcurrentExec: number;
	private readonly maxQueuedExec: number;
	private readonly terminationGraceMs: number;
	private readonly now: () => number;
	private readonly spawnProcess: ExecProcessFactory;
	private readonly queued: QueuedOperation[] = [];
	private readonly active = new Map<string, ActiveOperation>();
	private readonly terminalOperations = new Map<string, "cancelled" | "completed">();
	private shuttingDown = false;

	constructor(options: ExecServiceOptions = {}) {
		this.maxConcurrentExec = Math.max(1, Math.floor(options.maxConcurrentExec ?? 4));
		this.maxQueuedExec = Math.max(0, Math.floor(options.maxQueuedExec ?? 64));
		this.terminationGraceMs = Math.max(1, Math.floor(options.terminationGraceMs ?? 1_000));
		this.now = options.now ?? (() => Date.now());
		this.spawnProcess = options.spawnProcess ?? defaultSpawn;
	}

	get activeCount(): number {
		return this.active.size;
	}

	get queueDepth(): number {
		return this.queued.length;
	}

	start(request: ExecStartRequestV1, callbacks: ExecServiceCallbacks): Promise<ExecAcceptedV1> {
		if (this.shuttingDown)
			return Promise.reject(
				new ExecServiceError("agent_disconnected", "Agent is shutting down", request.operationId),
			);
		if (
			this.active.has(request.operationId) ||
			this.queued.some((operation) => operation.request.operationId === request.operationId) ||
			this.terminalOperations.has(request.operationId)
		) {
			return Promise.reject(
				new ExecServiceError("duplicate_operation_id", "Operation ID is already active", request.operationId),
			);
		}
		if (this.active.size >= this.maxConcurrentExec) {
			if (this.queued.length >= this.maxQueuedExec)
				return Promise.reject(
					new ExecServiceError("agent_busy", "Agent execution queue is full", request.operationId),
				);
		}
		return new Promise<ExecAcceptedV1>((resolve, reject) => {
			const operation: QueuedOperation = { request, callbacks, resolve, reject, state: "queued" };
			if (this.active.size < this.maxConcurrentExec) {
				void this.launch(operation);
			} else {
				this.queued.push(operation);
			}
		});
	}

	cancel(operationId: string): "cancel_requested" | "cancelled" | "completed" {
		const queuedIndex = this.queued.findIndex((operation) => operation.request.operationId === operationId);
		if (queuedIndex >= 0) {
			const [operation] = this.queued.splice(queuedIndex, 1);
			if (operation) {
				operation.state = "terminal";
				this.rememberTerminal(operationId, "cancelled");
				operation.reject(
					new ExecServiceError("agent_cancelled", "Operation was cancelled before it started", operationId),
				);
			}
			return "cancelled";
		}
		const terminalStatus = this.terminalOperations.get(operationId);
		if (terminalStatus) return terminalStatus;
		const operation = this.active.get(operationId);
		if (!operation) throw new ExecServiceError("operation_not_found", "Operation was not found", operationId);
		if (operation.finished) return "completed";
		operation.cancelled = true;
		this.terminate(operation);
		return "cancel_requested";
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		for (const operation of this.queued.splice(0)) {
			operation.state = "terminal";
			this.rememberTerminal(operation.request.operationId, "cancelled");
			operation.reject(
				new ExecServiceError(
					"agent_cancelled",
					"Operation was cancelled during shutdown",
					operation.request.operationId,
				),
			);
		}
		const completions = [...this.active.values()].map((operation) => {
			this.terminate(operation);
			return operation.completion;
		});
		if (completions.length === 0) return;
		await Promise.race([
			Promise.all(completions).then(() => undefined),
			new Promise<void>((resolve) => setTimeout(resolve, this.terminationGraceMs + 250)),
		]);
	}

	private async launch(operation: QueuedOperation): Promise<void> {
		operation.state = "starting";
		let child: ChildProcess;
		try {
			child = this.spawnProcess(operation.request.command, operation.request.cwd);
		} catch (error) {
			operation.state = "terminal";
			operation.reject(
				new ExecServiceError(
					"agent_internal",
					error instanceof Error ? error.message : "Could not start command",
					operation.request.operationId,
				),
			);
			this.launchNext();
			return;
		}
		if (child.pid === undefined) {
			operation.state = "terminal";
			operation.reject(
				new ExecServiceError(
					"agent_internal",
					"Started command did not expose a process ID",
					operation.request.operationId,
				),
			);
			child.kill("SIGTERM");
			this.launchNext();
			return;
		}
		let resolveCompletion!: () => void;
		const active: ActiveOperation = {
			...operation,
			child,
			startedAt: this.now(),
			sequence: 0,
			timedOut: false,
			cancelled: false,
			finished: false,
			completion: new Promise<void>((resolve) => {
				resolveCompletion = resolve;
			}),
			resolveCompletion,
		};
		active.state = "running";
		this.active.set(operation.request.operationId, active);
		this.attachOutput(active, child.stdout, "stdout");
		this.attachOutput(active, child.stderr, "stderr");
		child.once("error", (error) => {
			if (!active.finished) {
				active.cancelled = false;
				this.finish(active, null, undefined, diagnosticForServiceError(error, active.request.operationId));
			}
		});
		child.once("close", (exitCode, signal) => this.finish(active, exitCode, signal ?? undefined));
		if (operation.request.timeoutMs !== undefined) {
			active.terminationTimer = setTimeout(() => {
				if (active.finished) return;
				active.timedOut = true;
				this.terminate(active);
			}, operation.request.timeoutMs);
			active.terminationTimer.unref?.();
		}
		operation.resolve({ operationId: operation.request.operationId, pid: child.pid, startedAt: active.startedAt });
	}

	private attachOutput(active: ActiveOperation, stream: Readable | null, outputStream: "stdout" | "stderr"): void {
		stream?.on("data", (data: Buffer | string) => {
			if (active.finished) return;
			const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
			for (const chunk of chunkBuffer(buffer, REMOTE_AGENT_MAX_OUTPUT_CHUNK_BYTES)) {
				active.callbacks.onOutput({
					operationId: active.request.operationId,
					sequence: active.sequence++,
					stream: outputStream,
					dataBase64: chunk.toString("base64"),
				});
			}
		});
	}

	private terminate(operation: ActiveOperation): void {
		if (operation.finished) return;
		const pid = operation.child.pid;
		try {
			if (pid !== undefined && process.platform !== "win32") killProcess(-pid, "SIGTERM");
			else operation.child.kill("SIGTERM");
		} catch {
			try {
				operation.child.kill("SIGTERM");
			} catch {
				// The process may already have exited.
			}
		}
		if (operation.terminationTimer) clearTimeout(operation.terminationTimer);
		operation.terminationTimer = setTimeout(() => {
			if (operation.finished) return;
			try {
				if (pid !== undefined && process.platform !== "win32") killProcess(-pid, "SIGKILL");
				else operation.child.kill("SIGKILL");
			} catch {
				// The process may already have exited.
			}
		}, this.terminationGraceMs);
		operation.terminationTimer.unref?.();
	}

	private finish(
		active: ActiveOperation,
		exitCode: number | null,
		signal?: string,
		diagnostic?: AgentDiagnosticV1,
	): void {
		if (active.finished) return;
		active.finished = true;
		active.state = "terminal";
		if (active.terminationTimer) clearTimeout(active.terminationTimer);
		this.active.delete(active.request.operationId);
		this.rememberTerminal(active.request.operationId, active.cancelled ? "cancelled" : "completed");
		const exitEvent: ExecExitEventV1 = {
			operationId: active.request.operationId,
			exitCode,
			...(signal === undefined ? {} : { signal }),
			startedAt: active.startedAt,
			completedAt: this.now(),
			timedOut: active.timedOut,
			cancelled: active.cancelled,
			...(diagnostic === undefined ? {} : { diagnostic }),
		};
		active.callbacks.onExit(exitEvent);
		active.resolveCompletion();
		this.launchNext();
	}

	private rememberTerminal(operationId: string, status: "cancelled" | "completed"): void {
		this.terminalOperations.delete(operationId);
		this.terminalOperations.set(operationId, status);
		while (this.terminalOperations.size > 2_048) {
			const first = this.terminalOperations.keys().next().value as string | undefined;
			if (first === undefined) break;
			this.terminalOperations.delete(first);
		}
	}

	private launchNext(): void {
		while (!this.shuttingDown && this.active.size < this.maxConcurrentExec && this.queued.length > 0) {
			const next = this.queued.shift();
			if (next) void this.launch(next);
		}
	}
}
