import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import type { MonitorAdapterSnapshot, MonitorRecord, MonitorStopResult } from "../monitor/types.ts";
import type { ExecutionTargetRegistry } from "./targets.ts";
import {
	type ExecutionTargetConfig,
	type RemoteCommandOptions,
	type RemoteCommandResult,
	RemoteExecutionError,
	type SshConnection,
	type SshTmuxAdapter,
	type TmuxCreateOptions,
	type TmuxStatus,
} from "./types.ts";

function safeDiagnosticText(text: string): string {
	return text
		.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted-key]")
		.replace(/(password|passphrase|token|secret|authorization|identityfile)\s*[=:]\s*[^\s]+/gi, "$1=[redacted]")
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(/[\r\n\t]+/g, " ")
		.trim()
		.slice(0, 500);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function targetKey(target: ExecutionTargetConfig): string {
	return JSON.stringify({
		alias: target.sshAlias,
		user: target.user,
		port: target.port,
	});
}

function controlPathFor(target: ExecutionTargetConfig): string {
	const digest = createHash("sha256").update(targetKey(target)).digest("hex").slice(0, 24);
	return join(tmpdir(), "beaupi-ssh", `ctl-${digest}`);
}

function targetArgs(target: ExecutionTargetConfig, controlPath: string): string[] {
	const persist = target.controlPersistSeconds ?? 60;
	const args = [
		"-o",
		"BatchMode=yes",
		"-o",
		`ConnectTimeout=${Math.max(1, Math.ceil((target.connectTimeoutMs ?? 15_000) / 1000))}`,
		"-o",
		"ControlMaster=auto",
		"-o",
		`ControlPersist=${persist}s`,
		"-o",
		`ControlPath=${controlPath}`,
	];
	if (target.user) args.push("-l", target.user);
	if (target.port) args.push("-p", String(target.port));
	args.push(target.sshAlias);
	return args;
}

async function runSsh(args: string[], options: RemoteCommandOptions = {}): Promise<RemoteCommandResult> {
	const startedAt = Date.now();
	if (options.signal?.aborted) {
		throw new RemoteExecutionError({
			code: "remote_cancelled",
			message: "Remote SSH operation was cancelled",
			retryable: false,
		});
	}
	const child = spawnProcess("ssh", args, {
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let cancelled = false;
	let timeoutHandle: NodeJS.Timeout | undefined;
	const kill = (): void => {
		if (child.exitCode !== null) return;
		if (options.signal?.aborted) cancelled = true;
		child.kill("SIGTERM");
		setTimeout(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
		}, 1_000).unref();
	};
	const onAbort = (): void => {
		cancelled = true;
		kill();
	};
	child.stdout?.on("data", (data: Buffer) => {
		stdout += data.toString("utf8");
		options.onData?.(data);
	});
	child.stderr?.on("data", (data: Buffer) => {
		stderr += data.toString("utf8");
		options.onData?.(data);
	});
	if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
	if (options.timeoutMs !== undefined) {
		timeoutHandle = setTimeout(
			() => {
				timedOut = true;
				kill();
			},
			Math.max(1, Math.floor(options.timeoutMs)),
		);
	}
	try {
		const exitCode = await waitForChildProcess(child);
		if (cancelled || options.signal?.aborted) {
			throw new RemoteExecutionError({ code: "remote_cancelled", message: "Remote SSH operation was cancelled" });
		}
		if (timedOut) {
			throw new RemoteExecutionError({
				code: "remote_timeout",
				message: `Remote SSH operation timed out after ${Math.ceil((options.timeoutMs ?? 0) / 1000)} seconds`,
				retryable: true,
			});
		}
		return { stdout, stderr, exitCode, startedAt, completedAt: Date.now() };
	} catch (error) {
		if (error instanceof RemoteExecutionError) throw error;
		const message = safeDiagnosticText(error instanceof Error ? error.message : String(error));
		throw new RemoteExecutionError({
			code: "ssh_connection",
			message: message || "SSH process failed",
			retryable: true,
		});
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

function classifyConnectionFailure(result: RemoteCommandResult, targetId: string): RemoteExecutionError {
	const text = safeDiagnosticText(`${result.stderr}\n${result.stdout}`);
	const lower = text.toLowerCase();
	let code: "ssh_authentication" | "ssh_host_key" | "ssh_timeout" | "ssh_connection" = "ssh_connection";
	if (lower.includes("permission denied") || lower.includes("authentication failed")) code = "ssh_authentication";
	else if (lower.includes("host key verification failed") || lower.includes("remote host identification has changed"))
		code = "ssh_host_key";
	else if (lower.includes("connection timed out") || lower.includes("connecttimeout")) code = "ssh_timeout";
	return new RemoteExecutionError({
		code,
		message: `${code}: ${text || "OpenSSH could not connect"}`,
		targetId,
		retryable: code !== "ssh_host_key" && code !== "ssh_authentication",
	});
}

class OpenSshConnection implements SshConnection {
	readonly connectionId = randomUUID();
	readonly targetId: string;
	private readonly target: ExecutionTargetConfig;
	private readonly controlPath: string;
	private closed = false;

	constructor(target: ExecutionTargetConfig, controlPath: string) {
		this.target = target;
		this.targetId = target.id;
		this.controlPath = controlPath;
	}

	async execute(command: string, options?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		if (this.closed)
			throw new RemoteExecutionError({
				code: "ssh_disconnected",
				message: "SSH connection is closed",
				targetId: this.targetId,
			});
		const result = await runSsh([...targetArgs(this.target, this.controlPath), command], options);
		if (result.exitCode === 255 && /connection|broken pipe|closed by remote|no route/i.test(result.stderr)) {
			throw new RemoteExecutionError({
				code: "ssh_disconnected",
				message: `SSH disconnected: ${safeDiagnosticText(result.stderr) || "connection closed"}`,
				targetId: this.targetId,
				retryable: true,
			});
		}
		return result;
	}

	async tmuxCreate(options: TmuxCreateOptions, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		const parts = ["tmux new-session -d -s", shellQuote(options.sessionId), "-c", shellQuote(options.cwd)];
		if (options.columns !== undefined) parts.push("-x", String(options.columns));
		if (options.rows !== undefined) parts.push("-y", String(options.rows));
		if (options.command) parts.push(shellQuote(options.command));
		return this.execute(parts.join(" "), commandOptions);
	}

	async tmuxSend(
		sessionId: string,
		input: string,
		commandOptions?: RemoteCommandOptions,
	): Promise<RemoteCommandResult> {
		const target = shellQuote(sessionId);
		const segments = input.split(/\r\n|\r|\n/);
		const commands: string[] = [];
		for (let index = 0; index < segments.length; index++) {
			const segment = segments[index] ?? "";
			if (segment) commands.push(`tmux send-keys -t ${target} -l ${shellQuote(segment)}`);
			if (index < segments.length - 1) commands.push(`tmux send-keys -t ${target} Enter`);
		}
		return this.execute(
			commands.length > 0 ? commands.join(" && ") : `tmux send-keys -t ${target} -l ''`,
			commandOptions,
		);
	}

	async tmuxCapture(sessionId: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		return this.execute(`tmux capture-pane -p -S - -t ${shellQuote(sessionId)}`, commandOptions);
	}

	async tmuxStatus(sessionId: string, commandOptions?: RemoteCommandOptions): Promise<TmuxStatus> {
		const result = await this.execute(`tmux has-session -t ${shellQuote(sessionId)}`, commandOptions);
		if (result.exitCode === 0) return { exists: true, attached: false };
		if (
			result.stderr.toLowerCase().includes("unknown command") ||
			result.stderr.toLowerCase().includes("not found")
		) {
			throw new RemoteExecutionError({
				code: "tmux_unavailable",
				message: "tmux is not available on the remote target",
				targetId: this.targetId,
			});
		}
		return { exists: false, attached: false };
	}

	async tmuxClose(sessionId: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		return this.execute(`tmux kill-session -t ${shellQuote(sessionId)}`, commandOptions);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			const args = targetArgs(this.target, this.controlPath);
			const host = args.pop();
			if (host) args.push("-O", "exit", host);
			await runSsh(args, { timeoutMs: 5_000 });
		} catch {
			// Explicit close is best effort. The control path is not an auth store.
		}
	}
}

export interface OpenSshTmuxAdapterOptions {
	targets: ExecutionTargetRegistry;
}

/** Real adapter backed by the user's OpenSSH binary/configuration. */
export class OpenSshTmuxAdapter implements SshTmuxAdapter {
	readonly kind = "ssh-tmux" as const;
	private readonly targets: ExecutionTargetRegistry;
	private readonly connections = new Map<string, Promise<OpenSshConnection>>();
	private readonly snapshots = new Map<string, MonitorAdapterSnapshot>();
	private readonly commandAbortControllers = new Map<string, AbortController>();

	constructor(options: OpenSshTmuxAdapterOptions) {
		this.targets = options.targets;
	}

	async connect(target: ExecutionTargetConfig, signal?: AbortSignal): Promise<SshConnection> {
		const existing = this.connections.get(target.id);
		if (existing) return existing;
		const controlPath = controlPathFor(target);
		const pending = (async () => {
			await mkdir(join(tmpdir(), "beaupi-ssh"), { recursive: true });
			try {
				const result = await runSsh([...targetArgs(target, controlPath), "true"], {
					signal,
					timeoutMs: target.connectTimeoutMs ?? 15_000,
				});
				if (result.exitCode !== 0) throw classifyConnectionFailure(result, target.id);
				return new OpenSshConnection(target, controlPath);
			} catch (error) {
				if (error instanceof RemoteExecutionError && error.diagnostic.code === "remote_timeout") {
					throw new RemoteExecutionError({
						...error.diagnostic,
						code: "ssh_timeout",
						message: `SSH connection timed out for target ${target.id}`,
						targetId: target.id,
					});
				}
				throw error;
			}
		})();
		this.connections.set(target.id, pending);
		try {
			return await pending;
		} catch (error) {
			this.connections.delete(target.id);
			throw error;
		}
	}

	setSnapshot(monitorId: string, snapshot: MonitorAdapterSnapshot): void {
		this.snapshots.set(monitorId, structuredClone(snapshot));
	}

	async poll(record: MonitorRecord): Promise<MonitorAdapterSnapshot> {
		const known = this.snapshots.get(record.id);
		if (known) return structuredClone(known);
		if (record.target.kind !== "ssh-tmux") return { availability: "unknown" };
		const targetId = record.target.targetId;
		const target = targetId ? this.targets.get(targetId) : undefined;
		if (!target) return { availability: "unknown", diagnostics: ["Remote target is not available after restore"] };
		if (record.target.resource === "command") return { availability: "unknown" };
		try {
			const connection = await this.connect(target);
			if (record.target.resource === "connection") {
				return { availability: "confirmed", running: true, healthy: true, lastActivityAt: Date.now() };
			}
			if (!record.target.sessionId) return { availability: "unknown" };
			const status = await connection.tmuxStatus(record.target.sessionId);
			return status.exists
				? { availability: "confirmed", running: true, healthy: true, lastActivityAt: Date.now() }
				: { availability: "missing", exitReason: "tmux_session_missing" };
		} catch (error) {
			if (error instanceof RemoteExecutionError) {
				return {
					availability: error.diagnostic.code === "ssh_disconnected" ? "missing" : "unknown",
					exitReason: error.diagnostic.code,
					diagnostics: [error.diagnostic.message],
				};
			}
			return { availability: "unknown", diagnostics: ["Remote monitor poll failed"] };
		}
	}

	async stop(record: MonitorRecord, force: boolean): Promise<MonitorStopResult> {
		const controller = this.commandAbortControllers.get(record.id);
		if (controller) {
			controller.abort();
			return { accepted: true, reason: force ? "remote_command_force_cancel" : "remote_command_cancel" };
		}
		if (record.target.kind !== "ssh-tmux") return { accepted: false, reason: "not_remote_target" };
		if (record.target.resource === "terminal" && record.target.sessionId && record.target.targetId) {
			try {
				const target = this.targets.get(record.target.targetId);
				if (!target) return { accepted: false, reason: "target_not_found" };
				const connection = await this.connect(target);
				await connection.tmuxClose(record.target.sessionId);
				this.setSnapshot(record.id, {
					availability: "confirmed",
					running: false,
					exitCode: 0,
					exitReason: "terminal_closed",
				});
				return { accepted: true, reason: "terminal_closed" };
			} catch (error) {
				return {
					accepted: false,
					reason: error instanceof Error ? safeDiagnosticText(error.message) : "terminal_close_failed",
				};
			}
		}
		return { accepted: false, reason: force ? "remote_target_not_cancellable" : "remote_target_not_cancellable" };
	}

	registerCommandAbort(monitorId: string, controller: AbortController): void {
		this.commandAbortControllers.set(monitorId, controller);
	}

	unregisterCommandAbort(monitorId: string): void {
		this.commandAbortControllers.delete(monitorId);
	}

	async closeTarget(targetId: string): Promise<void> {
		const pending = this.connections.get(targetId);
		this.connections.delete(targetId);
		if (!pending) return;
		try {
			const connection = await pending;
			await connection.close();
		} finally {
			await rm(
				controlPathFor(this.targets.get(targetId) ?? { id: targetId, sshAlias: targetId, scope: "session" }),
				{ force: true },
			).catch(() => {});
		}
	}

	async dispose(): Promise<void> {
		for (const targetId of [...this.connections.keys()]) await this.closeTarget(targetId);
		this.commandAbortControllers.clear();
		this.snapshots.clear();
	}
}

interface FakeCommand {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	delayMs?: number;
}

class FakeSshConnection implements SshConnection {
	readonly connectionId = randomUUID();
	readonly targetId: string;
	private readonly adapter: FakeSshTmuxAdapter;
	private closed = false;

	constructor(targetId: string, adapter: FakeSshTmuxAdapter) {
		this.targetId = targetId;
		this.adapter = adapter;
	}

	execute(command: string, options?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		if (this.closed)
			throw new RemoteExecutionError({
				code: "ssh_disconnected",
				message: "Fake SSH connection is closed",
				targetId: this.targetId,
			});
		return this.adapter.executeFake(command, options);
	}

	async tmuxCreate(options: TmuxCreateOptions, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		this.adapter.createFakeTerminal(options);
		return this.execute(`tmux new-session ${options.sessionId}`, commandOptions);
	}

	async tmuxSend(
		sessionId: string,
		input: string,
		commandOptions?: RemoteCommandOptions,
	): Promise<RemoteCommandResult> {
		this.adapter.sendFakeTerminal(sessionId, input);
		return this.execute(`tmux send-keys ${sessionId}`, commandOptions);
	}

	async tmuxCapture(sessionId: string, _commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		const output = this.adapter.captureFakeTerminal(sessionId);
		return { stdout: output, stderr: "", exitCode: 0, startedAt: Date.now(), completedAt: Date.now() };
	}

	async tmuxStatus(sessionId: string, commandOptions?: RemoteCommandOptions): Promise<TmuxStatus> {
		if (commandOptions?.signal?.aborted)
			throw new RemoteExecutionError({ code: "remote_cancelled", message: "Remote SSH operation was cancelled" });
		return { exists: this.adapter.hasFakeTerminal(sessionId), attached: false };
	}

	async tmuxClose(sessionId: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		this.adapter.closeFakeTerminal(sessionId);
		return this.execute(`tmux kill-session ${sessionId}`, commandOptions);
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

/** Deterministic adapter used by M7 unit tests and faux-provider tests. */
export class FakeSshTmuxAdapter implements SshTmuxAdapter {
	readonly kind = "ssh-tmux" as const;
	private readonly connections = new Map<string, FakeSshConnection>();
	private readonly commandResults = new Map<string, FakeCommand>();
	private readonly terminals = new Map<string, { output: string; exists: boolean }>();
	private readonly snapshots = new Map<string, MonitorAdapterSnapshot>();
	private readonly stopResults = new Map<string, MonitorStopResult>();
	connectCalls = 0;
	commandCalls: string[] = [];
	tmuxCreateCalls: TmuxCreateOptions[] = [];
	closeCalls = 0;
	failConnect?: RemoteExecutionError;

	async connect(target: ExecutionTargetConfig): Promise<SshConnection> {
		const existing = this.connections.get(target.id);
		if (existing) return existing;
		if (this.failConnect) throw this.failConnect;
		this.connectCalls++;
		const connection = new FakeSshConnection(target.id, this);
		this.connections.set(target.id, connection);
		return connection;
	}

	setCommandResult(command: string, result: Partial<FakeCommand>): void {
		this.commandResults.set(command, { stdout: "", stderr: "", exitCode: 0, ...result });
	}

	setSnapshot(monitorId: string, snapshot: MonitorAdapterSnapshot): void {
		this.snapshots.set(monitorId, structuredClone(snapshot));
	}

	setStopResult(monitorId: string, result: MonitorStopResult): void {
		this.stopResults.set(monitorId, result);
	}

	poll(record: MonitorRecord): MonitorAdapterSnapshot {
		return this.snapshots.get(record.id) ?? { availability: "unknown" };
	}

	stop(record: MonitorRecord): MonitorStopResult {
		return this.stopResults.get(record.id) ?? { accepted: true, reason: "fake_remote_stop" };
	}

	async closeTarget(targetId: string): Promise<void> {
		if (this.connections.delete(targetId)) this.closeCalls++;
	}

	async dispose(): Promise<void> {
		for (const targetId of [...this.connections.keys()]) await this.closeTarget(targetId);
	}

	async executeFake(command: string, options: RemoteCommandOptions = {}): Promise<RemoteCommandResult> {
		if (options.signal?.aborted)
			throw new RemoteExecutionError({ code: "remote_cancelled", message: "Remote SSH operation was cancelled" });
		this.commandCalls.push(command);
		const configured = this.commandResults.get(command) ?? { stdout: "ok\n", stderr: "", exitCode: 0 };
		if (configured.delayMs && configured.delayMs > 0) {
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const finish = (error?: RemoteExecutionError): void => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					if (timeout) clearTimeout(timeout);
					options.signal?.removeEventListener("abort", onAbort);
					error ? reject(error) : resolve();
				};
				const onAbort = (): void =>
					finish(
						new RemoteExecutionError({ code: "remote_cancelled", message: "Remote SSH operation was cancelled" }),
					);
				const timer = setTimeout(() => finish(), configured.delayMs);
				const timeout =
					options.timeoutMs === undefined
						? undefined
						: setTimeout(
								() =>
									finish(
										new RemoteExecutionError({
											code: "remote_timeout",
											message: "Remote SSH operation timed out",
										}),
									),
								Math.max(1, options.timeoutMs),
							);
				options.signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
		if (configured.stdout) options.onData?.(Buffer.from(configured.stdout));
		if (configured.stderr) options.onData?.(Buffer.from(configured.stderr));
		return { ...configured, startedAt: Date.now(), completedAt: Date.now() };
	}

	createFakeTerminal(options: TmuxCreateOptions): void {
		this.tmuxCreateCalls.push(structuredClone(options));
		this.terminals.set(options.sessionId, { output: options.command ? `${options.command}\n` : "", exists: true });
	}

	sendFakeTerminal(sessionId: string, input: string): void {
		const terminal = this.terminals.get(sessionId);
		if (terminal?.exists) terminal.output += input;
	}

	captureFakeTerminal(sessionId: string): string {
		const terminal = this.terminals.get(sessionId);
		if (!terminal?.exists)
			throw new RemoteExecutionError({
				code: "terminal_session_lost",
				message: `tmux session ${JSON.stringify(sessionId)} is missing`,
			});
		return terminal.output;
	}

	hasFakeTerminal(sessionId: string): boolean {
		return this.terminals.get(sessionId)?.exists === true;
	}

	closeFakeTerminal(sessionId: string): void {
		const terminal = this.terminals.get(sessionId);
		if (terminal) terminal.exists = false;
	}
}

export { classifyConnectionFailure, safeDiagnosticText, shellQuote };
