import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { MonitorRuntime } from "../monitor/monitor-runtime.ts";
import type { MonitorAdapterSnapshot } from "../monitor/types.ts";
import type { SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { BashOperations } from "../tools/bash.ts";
import type { EditOperations } from "../tools/edit.ts";
import type { ReadOperations } from "../tools/read.ts";
import type { WriteOperations } from "../tools/write.ts";
import { OpenSshTmuxAdapter } from "./adapter.ts";
import { ExecutionTargetRegistry } from "./targets.ts";
import {
	EXECUTION_TARGET_VERSION,
	type ExecutionTargetConfig,
	REMOTE_TARGET_SESSION_ENTRY_TYPE,
	type RemoteCommandResult,
	type RemoteDiagnostic,
	RemoteExecutionError,
	type SshConnection,
	type SshTmuxAdapter,
	type TmuxCreateOptions,
} from "./types.ts";

interface RemoteTerminalState {
	terminalId: string;
	targetId: string;
	monitorId: string;
	logPath: string;
	lastCapture: string;
	captureCursor: number;
}

export interface RemoteExecutionRuntimeOptions {
	cwd: string;
	sessionId: string;
	sessionManager?: Pick<SessionManager, "getBranch" | "appendCustomEntry">;
	settingsManager?: SettingsManager;
	monitorRuntime: MonitorRuntime;
	targets?: ExecutionTargetRegistry;
	adapter?: SshTmuxAdapter;
	now?: () => number;
}

export interface RemoteExecResult {
	command: string;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	monitorId: string;
	logPath: string;
	connectedTargetId: string;
	diagnostic?: RemoteDiagnostic;
}

export interface TerminalCreateResult {
	terminalId: string;
	monitorId: string;
	status: "running";
	logPath: string;
	targetId: string;
}

export interface TerminalCaptureResult {
	terminalId: string;
	monitorId: string;
	content: string;
	cursor: number;
	changed: boolean;
	logPath: string;
	status: string;
}

export interface TerminalStatusResult {
	terminalId: string;
	monitorId: string;
	status: string;
	exists: boolean;
	logPath: string;
}

function targetMonitorTarget(
	targetId: string,
	resource: "connection" | "command" | "terminal",
	operationId: string,
	sessionId?: string,
	logPath?: string,
): {
	kind: "ssh-tmux";
	targetId: string;
	resource: "connection" | "command" | "terminal";
	operationId: string;
	sessionId?: string;
	logPath?: string;
} {
	return { kind: "ssh-tmux", targetId, resource, operationId, sessionId, logPath };
}

function safeId(value: string, label: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value))
		throw new RemoteExecutionError({
			code: "terminal_invalid",
			message: `${label} must use safe session characters`,
		});
	return value;
}

function assertNormalUserCommand(command: string): void {
	if (/(^|[;&|\n]\s*|\s)(sudo|su|doas|pkexec|runuser|setpriv|nsenter|chroot|machinectl)(\s|$)/i.test(command)) {
		throw new RemoteExecutionError({
			code: "remote_command",
			message: "Privileged commands and root shells are not supported by M7",
		});
	}
}

function commandOperationId(): string {
	return `cmd-${randomUUID()}`;
}

function logPathFor(cwd: string, sessionId: string, operationId: string): string {
	return join(cwd, ".beaupi", "remote-logs", sessionId, `${operationId}.log`);
}

function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function incrementalCapture(previous: string, current: string): string {
	if (!current || current === previous) return "";
	if (!previous || current.startsWith(previous)) return current.slice(previous.length);
	const previousLines = previous.split("\n");
	const currentLines = current.split("\n");
	const maxOverlap = Math.min(previousLines.length, currentLines.length);
	for (let size = maxOverlap; size > 0; size--) {
		let matches = true;
		for (let index = 0; index < size; index++) {
			if (previousLines[previousLines.length - size + index] !== currentLines[index]) {
				matches = false;
				break;
			}
		}
		if (matches) return currentLines.slice(size).join("\n");
	}
	return current;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function restoredTargetId(
	entries: readonly { type: string; customType?: string; data?: unknown }[],
): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== REMOTE_TARGET_SESSION_ENTRY_TYPE) continue;
		const data = asRecord(entry.data);
		if (data?.version === EXECUTION_TARGET_VERSION && typeof data.targetId === "string") return data.targetId;
	}
	return undefined;
}

/** M7 remote execution facade. It owns no Agent, Session, or second monitor registry. */
export class RemoteExecutionRuntime {
	readonly cwd: string;
	readonly sessionId: string;
	readonly targets: ExecutionTargetRegistry;
	readonly adapter: SshTmuxAdapter;
	private readonly monitorRuntime: MonitorRuntime;
	private readonly sessionManager?: RemoteExecutionRuntimeOptions["sessionManager"];
	private readonly now: () => number;
	private readonly connections = new Map<string, Promise<SshConnection>>();
	private readonly connectionMonitors = new Map<string, string>();
	private readonly terminals = new Map<string, RemoteTerminalState>();
	private selectedTargetId?: string;

	constructor(options: RemoteExecutionRuntimeOptions) {
		this.cwd = options.cwd;
		this.sessionId = options.sessionId;
		this.monitorRuntime = options.monitorRuntime;
		this.sessionManager = options.sessionManager;
		this.now = options.now ?? (() => Date.now());
		this.targets = options.targets ?? new ExecutionTargetRegistry({ settingsManager: options.settingsManager });
		this.adapter = options.adapter ?? new OpenSshTmuxAdapter({ targets: this.targets });
		this.monitorRuntime.setAdapter("ssh-tmux", this.adapter);
		this.selectedTargetId = restoredTargetId(options.sessionManager?.getBranch() ?? []);
	}

	get selectedTarget(): ExecutionTargetConfig | undefined {
		return this.selectedTargetId ? this.getTarget(this.selectedTargetId) : undefined;
	}

	getTarget(targetId: string): ExecutionTargetConfig | undefined {
		const target = this.targets.get(targetId);
		return target ? structuredClone(target) : undefined;
	}

	listTargets(): ExecutionTargetConfig[] {
		return this.targets.list();
	}

	selectTarget(targetId: string): ExecutionTargetConfig {
		const target = this.targets.select(targetId, this.now());
		this.selectedTargetId = target.id;
		this.sessionManager?.appendCustomEntry(REMOTE_TARGET_SESSION_ENTRY_TYPE, {
			version: EXECUTION_TARGET_VERSION,
			targetId: target.id,
		});
		return target;
	}

	addSessionTarget(target: ExecutionTargetConfig): void {
		this.targets.addSessionTarget(target);
	}

	persistTarget(target: ExecutionTargetConfig): void {
		this.targets.setPersistedTarget(target);
	}

	async connect(targetId?: string, signal?: AbortSignal): Promise<SshConnection> {
		const target = this.assertTarget(targetId);
		const existing = this.connections.get(target.id);
		if (existing) return existing;
		const pending = this.adapter.connect(target, signal);
		this.connections.set(target.id, pending);
		try {
			const connection = await pending;
			if (!this.connectionMonitors.has(target.id)) {
				const monitor = this.monitorRuntime.attach({
					target: targetMonitorTarget(target.id, "connection", `conn-${target.id}`),
					name: `ssh:${target.id}`,
					taskSummary: "SSH connection",
				});
				this.connectionMonitors.set(target.id, monitor.id);
				this.setMonitorSnapshot(monitor.id, {
					availability: "confirmed",
					running: true,
					healthy: true,
					lastActivityAt: this.now(),
				});
				await this.monitorRuntime.poll();
			}
			return connection;
		} catch (error) {
			this.connections.delete(target.id);
			throw error;
		}
	}

	async close(targetId?: string): Promise<void> {
		const target = this.assertTarget(targetId);
		const pending = this.connections.get(target.id);
		this.connections.delete(target.id);
		if (pending) {
			const connection = await pending;
			await connection.close();
		}
		const connectionMonitorId = this.connectionMonitors.get(target.id);
		if (connectionMonitorId) {
			this.setMonitorSnapshot(connectionMonitorId, {
				availability: "confirmed",
				running: false,
				exitCode: 0,
				exitReason: "connection_closed",
			});
			await this.monitorRuntime.poll();
			this.connectionMonitors.delete(target.id);
		}
		const closeTarget = this.adapter as SshTmuxAdapter & { closeTarget?: (id: string) => Promise<void> };
		await closeTarget.closeTarget?.(target.id);
	}

	async remoteExec(
		command: string,
		options: { timeoutMs?: number; signal?: AbortSignal; targetId?: string } = {},
	): Promise<RemoteExecResult> {
		if (!command.trim() || command.includes("\0"))
			throw new RemoteExecutionError({
				code: "remote_command",
				message: "remote_exec requires a non-empty command without NUL bytes",
			});
		assertNormalUserCommand(command);
		const target = this.assertTarget(options.targetId);
		const operationId = commandOperationId();
		const logPath = logPathFor(this.cwd, this.sessionId, operationId);
		await mkdir(dirname(logPath), { recursive: true });
		const monitor = this.monitorRuntime.attach({
			target: targetMonitorTarget(target.id, "command", operationId, undefined, logPath),
			name: `ssh:${target.id}`,
			taskSummary: "Remote command",
			timeoutMs: options.timeoutMs,
		});
		const monitorId = monitor.id;
		const outputChunks: Buffer[] = [];
		const controller = new AbortController();
		const forwardAbort = (): void => controller.abort();
		options.signal?.addEventListener("abort", forwardAbort, { once: true });
		if (options.signal?.aborted) controller.abort();
		const adapterWithAbort = this.adapter as SshTmuxAdapter & {
			registerCommandAbort?: (id: string, controller: AbortController) => void;
			unregisterCommandAbort?: (id: string) => void;
		};
		adapterWithAbort.registerCommandAbort?.(monitorId, controller);
		this.setMonitorSnapshot(monitorId, {
			availability: "confirmed",
			running: true,
			healthy: true,
			lastActivityAt: this.now(),
		});
		await this.monitorRuntime.poll();
		try {
			const connection = await this.connect(target.id, controller.signal);
			const result = await connection.execute(commandInRemoteCwd(command, target), {
				signal: controller.signal,
				timeoutMs: options.timeoutMs,
				onData: (data) => outputChunks.push(Buffer.from(data)),
			});
			await writeFile(logPath, redactOutput(Buffer.concat(outputChunks).toString("utf8")), "utf8");
			await this.finishRemoteCommand(
				monitorId,
				logPath,
				result.exitCode,
				result.exitCode === 0 ? "exit_0" : "exit_nonzero",
			);
			return {
				command: redactCommand(command),
				stdout: redactOutput(result.stdout),
				stderr: redactOutput(result.stderr),
				exitCode: result.exitCode,
				monitorId,
				logPath,
				connectedTargetId: target.id,
				diagnostic:
					result.exitCode === 0
						? undefined
						: {
								code: "remote_command",
								message: `Remote command exited with code ${result.exitCode}`,
								targetId: target.id,
								operationId,
								exitCode: result.exitCode,
							},
			};
		} catch (error) {
			const diagnostic = diagnosticForError(error, target.id, operationId);
			if (diagnostic.code === "ssh_disconnected") await this.markConnectionLost(target.id, diagnostic.message);
			if (outputChunks.length > 0)
				await writeFile(logPath, redactOutput(Buffer.concat(outputChunks).toString("utf8")), "utf8");
			await this.finishRemoteCommand(
				monitorId,
				logPath,
				diagnostic.exitCode ?? null,
				diagnostic.code,
				diagnostic.code === "remote_cancelled",
			);
			throw new RemoteExecutionError(diagnostic);
		} finally {
			options.signal?.removeEventListener("abort", forwardAbort);
			adapterWithAbort.unregisterCommandAbort?.(monitorId);
		}
	}

	async terminalCreate(options: {
		terminalId?: string;
		command?: string;
		cwd?: string;
		columns?: number;
		rows?: number;
		targetId?: string;
		signal?: AbortSignal;
	}): Promise<TerminalCreateResult> {
		const target = this.assertTarget(options.targetId);
		const terminalId = safeId(options.terminalId ?? `term-${randomUUID().slice(0, 12)}`, "terminalId");
		if (options.command) assertNormalUserCommand(options.command);
		const operationId = terminalId;
		const logPath = logPathFor(this.cwd, this.sessionId, operationId);
		await mkdir(dirname(logPath), { recursive: true });
		await writeFile(logPath, "", "utf8");
		const monitor = this.monitorRuntime.attach({
			target: targetMonitorTarget(target.id, "terminal", operationId, terminalId, logPath),
			name: `tmux:${terminalId}`,
			taskSummary: "Remote tmux terminal",
		});
		const tmuxOptions: TmuxCreateOptions = {
			sessionId: terminalId,
			cwd: options.cwd ?? target.remoteCwd ?? ".",
			command: options.command,
			columns: options.columns,
			rows: options.rows,
		};
		try {
			const connection = await this.connect(target.id, options.signal);
			const result = await connection.tmuxCreate(tmuxOptions, { signal: options.signal });
			if (result.exitCode !== 0) throw this.tmuxError(result, target.id, terminalId, "terminal_invalid");
			await this.initializeTerminalLog(monitor.id, logPath);
			this.terminals.set(terminalId, {
				terminalId,
				targetId: target.id,
				monitorId: monitor.id,
				logPath,
				lastCapture: "",
				captureCursor: 0,
			});
			this.setMonitorSnapshot(monitor.id, {
				availability: "confirmed",
				running: true,
				healthy: true,
				lastActivityAt: this.now(),
				logPath,
			});
			await this.monitorRuntime.poll();
			return { terminalId, monitorId: monitor.id, status: "running", logPath, targetId: target.id };
		} catch (error) {
			const diagnostic = diagnosticForError(error, target.id, terminalId);
			if (diagnostic.code === "ssh_disconnected") await this.markConnectionLost(target.id, diagnostic.message);
			const missing = diagnostic.code === "terminal_session_lost";
			this.setMonitorSnapshot(monitor.id, {
				availability: missing ? "missing" : "confirmed",
				running: false,
				exitReason: diagnostic.code,
				diagnostics: [diagnostic.message],
			});
			await this.monitorRuntime.poll();
			throw new RemoteExecutionError(diagnostic);
		}
	}

	async terminalSend(
		terminalId: string,
		input: string,
		signal?: AbortSignal,
	): Promise<{ terminalId: string; monitorId: string; status: string }> {
		const terminal = this.assertTerminal(terminalId);
		assertNormalUserCommand(input);
		const target = this.assertTarget(terminal.targetId);
		const connection = await this.connect(target.id, signal);
		const result = await connection.tmuxSend(terminalId, input, { signal });
		if (result.exitCode !== 0) throw this.tmuxError(result, target.id, terminalId, "terminal_session_lost");
		this.setMonitorSnapshot(terminal.monitorId, {
			availability: "confirmed",
			running: true,
			healthy: true,
			lastActivityAt: this.now(),
			logPath: terminal.logPath,
		});
		await this.monitorRuntime.poll();
		return {
			terminalId,
			monitorId: terminal.monitorId,
			status: this.monitorRuntime.status(terminal.monitorId).status,
		};
	}

	async terminalCapture(terminalId: string, signal?: AbortSignal, cursor?: number): Promise<TerminalCaptureResult> {
		const terminal = this.assertTerminal(terminalId);
		const target = this.assertTarget(terminal.targetId);
		const connection = await this.connect(target.id, signal);
		let result: RemoteCommandResult;
		try {
			result = await connection.tmuxCapture(terminalId, { signal });
		} catch (error) {
			const diagnostic = diagnosticForError(error, target.id, terminalId);
			if (diagnostic.code === "ssh_disconnected") await this.markConnectionLost(target.id, diagnostic.message);
			this.setMonitorSnapshot(terminal.monitorId, {
				availability: "missing",
				exitReason: diagnostic.code,
				diagnostics: [diagnostic.message],
			});
			await this.monitorRuntime.poll();
			throw new RemoteExecutionError(diagnostic);
		}
		if (result.exitCode !== 0) {
			const diagnostic = this.tmuxError(result, target.id, terminalId, "terminal_session_lost").diagnostic;
			this.setMonitorSnapshot(terminal.monitorId, {
				availability: "missing",
				exitReason: diagnostic.code,
				diagnostics: [diagnostic.message],
			});
			await this.monitorRuntime.poll();
			throw new RemoteExecutionError(diagnostic);
		}
		const delta = incrementalCapture(terminal.lastCapture, result.stdout);
		const changed = hashText(result.stdout) !== hashText(terminal.lastCapture);
		terminal.lastCapture = result.stdout;
		if (delta) {
			await appendFile(terminal.logPath, redactOutput(delta), "utf8");
			terminal.captureCursor += Buffer.byteLength(delta, "utf8");
		}
		const logs = await this.monitorRuntime.logs(terminal.monitorId, {
			cursor: cursor ?? this.monitorRuntime.status(terminal.monitorId).logCursor,
		});
		this.setMonitorSnapshot(terminal.monitorId, {
			availability: "confirmed",
			running: true,
			healthy: true,
			lastActivityAt: changed ? this.now() : undefined,
			logPath: terminal.logPath,
		});
		await this.monitorRuntime.poll();
		return {
			terminalId,
			monitorId: terminal.monitorId,
			content: logs.content,
			cursor: logs.cursor,
			changed: logs.changed && logs.content.length > 0,
			logPath: terminal.logPath,
			status: this.monitorRuntime.status(terminal.monitorId).status,
		};
	}

	async terminalStatus(terminalId: string, signal?: AbortSignal): Promise<TerminalStatusResult> {
		const terminal = this.assertTerminal(terminalId);
		const target = this.assertTarget(terminal.targetId);
		try {
			const connection = await this.connect(target.id, signal);
			const status = await connection.tmuxStatus(terminalId, { signal });
			this.setMonitorSnapshot(
				terminal.monitorId,
				status.exists
					? {
							availability: "confirmed",
							running: true,
							healthy: true,
							lastActivityAt: this.now(),
							logPath: terminal.logPath,
						}
					: { availability: "missing", exitReason: "tmux_session_missing", logPath: terminal.logPath },
			);
			await this.monitorRuntime.poll();
			const monitor = this.monitorRuntime.status(terminal.monitorId);
			return {
				terminalId,
				monitorId: terminal.monitorId,
				status: monitor.status,
				exists: status.exists,
				logPath: terminal.logPath,
			};
		} catch (error) {
			const diagnostic = diagnosticForError(error, target.id, terminalId);
			if (diagnostic.code === "ssh_disconnected") await this.markConnectionLost(target.id, diagnostic.message);
			this.setMonitorSnapshot(terminal.monitorId, {
				availability: "missing",
				exitReason: diagnostic.code,
				diagnostics: [diagnostic.message],
				logPath: terminal.logPath,
			});
			await this.monitorRuntime.poll();
			throw new RemoteExecutionError(diagnostic);
		}
	}

	async terminalClose(
		terminalId: string,
		signal?: AbortSignal,
	): Promise<{ terminalId: string; monitorId: string; status: string }> {
		const terminal = this.assertTerminal(terminalId);
		const target = this.assertTarget(terminal.targetId);
		const connection = await this.connect(target.id, signal);
		const result = await connection.tmuxClose(terminalId, { signal });
		if (result.exitCode !== 0 && !result.stderr.toLowerCase().includes("can't find session"))
			throw this.tmuxError(result, target.id, terminalId, "terminal_session_lost");
		this.setMonitorSnapshot(terminal.monitorId, {
			availability: "confirmed",
			running: false,
			exitCode: 0,
			exitReason: "terminal_closed",
			logPath: terminal.logPath,
		});
		await this.monitorRuntime.poll();
		return {
			terminalId,
			monitorId: terminal.monitorId,
			status: this.monitorRuntime.status(terminal.monitorId).status,
		};
	}

	createReadOperations(): ReadOperations {
		return {
			readFile: async (path) => {
				const result = await this.remoteExec(`cat -- ${shellQuote(this.remotePath(path))}`);
				return Buffer.from(result.stdout, "utf8");
			},
			access: async (path) => {
				const result = await this.remoteExec(`test -r -- ${shellQuote(this.remotePath(path))}`);
				if (result.exitCode !== 0) throw new Error(`Remote file is not readable: ${path}`);
			},
		};
	}

	createWriteOperations(): WriteOperations {
		return {
			mkdir: async (path) => {
				const result = await this.remoteExec(`mkdir -p -- ${shellQuote(this.remotePath(path))}`);
				if (result.exitCode !== 0) throw new Error(`Remote directory creation failed: ${path}`);
			},
			writeFile: async (path, content) => {
				const encoded = Buffer.from(content, "utf8").toString("base64");
				const result = await this.remoteExec(
					`printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(this.remotePath(path))}`,
				);
				if (result.exitCode !== 0) throw new Error(`Remote file write failed: ${path}`);
			},
		};
	}

	createEditOperations(): EditOperations {
		const read = this.createReadOperations();
		const write = this.createWriteOperations();
		return {
			readFile: read.readFile,
			access: async (path) => {
				await read.access(path);
				const result = await this.remoteExec(`test -w -- ${shellQuote(this.remotePath(path))}`);
				if (result.exitCode !== 0) throw new Error(`Remote file is not writable: ${path}`);
			},
			writeFile: write.writeFile,
		};
	}

	createBashOperations(): BashOperations {
		return {
			exec: async (command, _cwd, options) => {
				const result = await this.remoteExec(command, {
					signal: options.signal,
					timeoutMs: options.timeout ? options.timeout * 1000 : undefined,
				});
				if (result.stdout) options.onData(Buffer.from(result.stdout, "utf8"));
				if (result.stderr) options.onData(Buffer.from(result.stderr, "utf8"));
				return { exitCode: result.exitCode };
			},
		};
	}

	async dispose(): Promise<void> {
		const adapter = this.adapter as SshTmuxAdapter & { dispose?: () => Promise<void> };
		await adapter.dispose?.();
		this.connections.clear();
		this.connectionMonitors.clear();
		this.terminals.clear();
	}

	private assertTarget(targetId?: string): ExecutionTargetConfig {
		const resolvedTargetId = targetId ?? this.selectedTargetId;
		if (!resolvedTargetId)
			throw new RemoteExecutionError({
				code: "target_not_selected",
				message: "Select a trusted execution target or provide targetId before remote operations",
			});
		if (targetId === undefined && this.targets.getSelected()) this.targets.assertSelected(resolvedTargetId);
		const target = this.targets.get(resolvedTargetId);
		if (!target)
			throw new RemoteExecutionError({
				code: "target_not_found",
				message: `Execution target ${JSON.stringify(resolvedTargetId)} is not configured or trusted`,
				targetId: resolvedTargetId,
			});
		return structuredClone(target);
	}

	private assertTerminal(terminalId: string): RemoteTerminalState {
		const terminal = this.terminals.get(terminalId);
		if (!terminal)
			throw new RemoteExecutionError({
				code: "terminal_not_found",
				message: `Unknown terminal ${JSON.stringify(terminalId)}`,
				operationId: terminalId,
			});
		return terminal;
	}

	private remotePath(localPath: string): string {
		this.assertTarget();
		const relativePath = relative(this.cwd, localPath);
		if (!relativePath) return ".";
		if (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath)) {
			return relativePath.split(sep).join("/");
		}
		return localPath.split(sep).join("/");
	}

	private async markConnectionLost(targetId: string, message: string): Promise<void> {
		const monitorId = this.connectionMonitors.get(targetId);
		if (!monitorId) return;
		this.setMonitorSnapshot(monitorId, {
			availability: "missing",
			exitReason: "ssh_disconnected",
			diagnostics: [message],
		});
		await this.monitorRuntime.poll();
	}

	private async initializeTerminalLog(monitorId: string, logPath: string): Promise<void> {
		await mkdir(dirname(logPath), { recursive: true });
		await writeFile(logPath, "", "utf8");
		this.setMonitorSnapshot(monitorId, { availability: "confirmed", running: true, healthy: true, logPath });
	}

	private setMonitorSnapshot(monitorId: string, snapshot: MonitorAdapterSnapshot): void {
		this.adapter.setSnapshot(monitorId, snapshot);
	}

	private async finishRemoteCommand(
		monitorId: string,
		logPath: string,
		exitCode: number | null,
		exitReason: string,
		cancelled = false,
	): Promise<void> {
		await mkdir(dirname(logPath), { recursive: true });
		this.setMonitorSnapshot(monitorId, {
			availability: "confirmed",
			running: false,
			cancelled,
			exitCode: exitCode === null ? undefined : exitCode,
			exitReason,
			logPath,
		});
		await this.monitorRuntime.poll();
	}

	private tmuxError(
		result: RemoteCommandResult,
		targetId: string,
		operationId: string,
		code: RemoteDiagnostic["code"],
	): RemoteExecutionError {
		return new RemoteExecutionError({
			code,
			message: `tmux operation failed: ${redactOutput(result.stderr) || "remote tmux returned a non-zero exit code"}`,
			targetId,
			operationId,
			exitCode: result.exitCode,
		});
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandInRemoteCwd(command: string, target: ExecutionTargetConfig): string {
	return target.remoteCwd ? `cd ${shellQuote(target.remoteCwd)} && ${command}` : command;
}

function redactCommand(command: string): string {
	return command.replace(/(password|passphrase|token|secret)\s*[=:]\s*[^\s]+/gi, "$1=[redacted]");
}

function redactOutput(output: string): string {
	return output
		.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted-key]")
		.replace(/(password|passphrase|token|secret|authorization)\s*[=:]\s*[^\s]+/gi, "$1=[redacted]")
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
}

function diagnosticForError(error: unknown, targetId: string, operationId: string): RemoteDiagnostic {
	if (error instanceof RemoteExecutionError)
		return {
			...error.diagnostic,
			targetId: error.diagnostic.targetId ?? targetId,
			operationId: error.diagnostic.operationId ?? operationId,
		};
	return {
		code: "ssh_connection",
		message: error instanceof Error ? error.message : "Remote operation failed",
		targetId,
		operationId,
		retryable: true,
	};
}

export { incrementalCapture, redactCommand, redactOutput };
