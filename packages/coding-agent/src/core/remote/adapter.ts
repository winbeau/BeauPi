import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripAnsi } from "../../utils/ansi.ts";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import type { MonitorAdapterSnapshot, MonitorRecord, MonitorStopResult } from "../monitor/types.ts";
import { LocalTmuxTransport } from "../terminal/local-tmux-transport.ts";
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
		.replace(/(password|passphrase|token|secret|authorization|identityfile)[ \t]*[=:][ \t]*[^\s]+/gi, "$1=[redacted]")
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

const TMUX_WAIT_POLL_MS = 50;
const TMUX_INTERRUPT_SETTLE_MS = 100;
const TMUX_READINESS_POLL_MS = 50;

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runProcess(
	binary: string,
	args: string[],
	options: RemoteCommandOptions,
	label: string,
	errorCode: "ssh_connection" | "tmux_unavailable",
): Promise<RemoteCommandResult> {
	const startedAt = Date.now();
	if (options.signal?.aborted) {
		throw new RemoteExecutionError({
			code: "remote_cancelled",
			message: `${label} operation was cancelled`,
			retryable: false,
		});
	}
	const child = spawnProcess(binary, args, {
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
	options.signal?.addEventListener("abort", onAbort, { once: true });
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
			throw new RemoteExecutionError({ code: "remote_cancelled", message: `${label} operation was cancelled` });
		}
		if (timedOut) {
			throw new RemoteExecutionError({
				code: "remote_timeout",
				message: `${label} operation timed out after ${Math.ceil((options.timeoutMs ?? 0) / 1000)} seconds`,
				retryable: true,
			});
		}
		return { stdout, stderr, exitCode, startedAt, completedAt: Date.now() };
	} catch (error) {
		if (error instanceof RemoteExecutionError) throw error;
		const message = safeDiagnosticText(error instanceof Error ? error.message : String(error));
		throw new RemoteExecutionError({
			code: errorCode,
			message: message || `${label} process failed`,
			retryable: errorCode === "ssh_connection",
		});
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

function runSsh(args: string[], options: RemoteCommandOptions = {}): Promise<RemoteCommandResult> {
	return runProcess("ssh", args, options, "Remote SSH", "ssh_connection");
}

function localTmuxSessionId(namespace: string, targetId: string, terminalId: string): string {
	const digest = createHash("sha256").update(`${namespace}\0${targetId}`).digest("hex").slice(0, 12);
	return `beaupi-${digest}-${terminalId}`;
}

function localTerminalTranscriptPath(namespace: string, targetId: string, terminalId: string): string {
	const digest = createHash("sha256").update(`${namespace}\0${targetId}\0${terminalId}`).digest("hex");
	return join(tmpdir(), "beaupi-terminal-transcripts", `${digest}.log`);
}

function remoteTerminalStartup(options: TmuxCreateOptions, readinessMarker: string): string {
	const cwd = `cd -- ${shellQuote(options.cwd)} || exit $?`;
	const ready = `printf '%s\\n' ${shellQuote(readinessMarker)}`;
	if (options.command) {
		return `${cwd}; ${ready}; exec "\${SHELL:-/bin/sh}" -lc ${shellQuote(options.command)}`;
	}
	return `${cwd}; ${ready}; exec "\${SHELL:-/bin/sh}" -l`;
}

function parseTerminalCommandCapture(
	capture: string,
	beginMarker: string,
	endMarker: string,
): { found: boolean; output: string; exitCode?: number } {
	const lines = capture
		.replaceAll("\r", "")
		.split("\n")
		.map((line) => line.trimEnd());
	const plainLines = lines.map((line) => stripAnsi(line).trimEnd());
	const beginIndex = plainLines.lastIndexOf(beginMarker);
	if (beginIndex === -1) return { found: false, output: "" };
	const outputLines = lines.slice(beginIndex + 1);
	const plainOutputLines = plainLines.slice(beginIndex + 1);
	const endIndex = plainOutputLines.findIndex((line) => line.startsWith(`${endMarker}:`));
	if (endIndex === -1) {
		while (outputLines.at(-1) === "") outputLines.pop();
		return { found: true, output: outputLines.join("\n") };
	}
	const status = plainOutputLines[endIndex]?.slice(endMarker.length + 1) ?? "";
	return {
		found: true,
		output: outputLines.slice(0, endIndex).join("\n"),
		exitCode: /^\d+$/.test(status) ? Number(status) : undefined,
	};
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
	private readonly sessionNamespace: string;
	private readonly localSessions: Set<string>;
	private readonly transcriptPaths: Map<string, string>;
	private readonly tmux: LocalTmuxTransport;
	private closed = false;

	constructor(
		target: ExecutionTargetConfig,
		controlPath: string,
		sessionNamespace: string,
		localSessions: Set<string>,
		transcriptPaths: Map<string, string>,
		tmux: LocalTmuxTransport,
	) {
		this.target = target;
		this.targetId = target.id;
		this.controlPath = controlPath;
		this.sessionNamespace = sessionNamespace;
		this.localSessions = localSessions;
		this.transcriptPaths = transcriptPaths;
		this.tmux = tmux;
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

	async tmuxCreate(
		options: TmuxCreateOptions,
		commandOptions: RemoteCommandOptions = {},
	): Promise<RemoteCommandResult> {
		const startedAt = Date.now();
		const sessionId = this.localSessionId(options.sessionId);
		const createArgs = ["new-session", "-d", "-s", sessionId];
		if (options.columns !== undefined) createArgs.push("-x", String(options.columns));
		if (options.rows !== undefined) createArgs.push("-y", String(options.rows));
		const created = await this.tmux.run(createArgs, commandOptions);
		if (created.exitCode !== 0) return created;
		const transcriptPath = localTerminalTranscriptPath(this.sessionNamespace, this.targetId, options.sessionId);
		await mkdir(dirname(transcriptPath), { recursive: true });
		await writeFile(transcriptPath, "", { encoding: "utf8", mode: 0o600 });
		this.transcriptPaths.set(sessionId, transcriptPath);
		try {
			const configured = await this.tmux.run(
				["set-option", "-t", sessionId, "remain-on-exit", "on"],
				commandOptions,
			);
			if (configured.exitCode !== 0) {
				await this.tmux.close(sessionId).catch(() => {});
				await this.removeTranscript(sessionId);
				return configured;
			}
			const piped = await this.tmux.run(
				["pipe-pane", "-t", sessionId, `cat >> ${shellQuote(transcriptPath)}`],
				commandOptions,
			);
			if (piped.exitCode !== 0) {
				await this.tmux.close(sessionId).catch(() => {});
				await this.removeTranscript(sessionId);
				return piped;
			}
			const readinessMarker = `__BEAUPI_READY_${randomUUID().replaceAll("-", "")}__`;
			const sshArgs = targetArgs(this.target, this.controlPath);
			sshArgs.splice(-1, 0, "-tt");
			sshArgs.push(remoteTerminalStartup(options, readinessMarker));
			const sshCommand = ["exec ssh", ...sshArgs.map(shellQuote)].join(" ");
			const respawned = await this.tmux.run(["respawn-pane", "-k", "-t", sessionId, sshCommand], commandOptions);
			if (respawned.exitCode !== 0) {
				await this.tmux.close(sessionId).catch(() => {});
				await this.removeTranscript(sessionId);
				return respawned;
			}
			const timeoutMs = this.target.connectTimeoutMs ?? 15_000;
			const deadline = Date.now() + timeoutMs;
			while (true) {
				if (commandOptions.signal?.aborted) {
					throw new RemoteExecutionError({
						code: "remote_cancelled",
						message: "Terminal SSH startup was cancelled",
						targetId: this.targetId,
					});
				}
				const capture = await this.tmuxCapture(options.sessionId, { signal: commandOptions.signal });
				const status = await this.tmuxStatus(options.sessionId, { signal: commandOptions.signal });
				if (capture.stdout.includes(readinessMarker) && status.exists) {
					this.localSessions.add(sessionId);
					if (status.paneId) this.transcriptPaths.set(status.paneId, transcriptPath);
					return { stdout: "", stderr: "", exitCode: 0, startedAt, completedAt: Date.now() };
				}
				if (!status.exists) {
					throw classifyConnectionFailure({ ...capture, stderr: capture.stdout, stdout: "" }, this.targetId);
				}
				if (Date.now() >= deadline) {
					throw new RemoteExecutionError({
						code: "ssh_timeout",
						message: `SSH terminal startup timed out for target ${this.targetId}`,
						targetId: this.targetId,
						retryable: true,
					});
				}
				await delay(TMUX_READINESS_POLL_MS);
			}
		} catch (error) {
			await this.tmux.close(sessionId).catch(() => {});
			await this.removeTranscript(sessionId);
			throw error;
		}
	}

	async tmuxSend(
		targetId: string,
		input: string,
		commandOptions: RemoteCommandOptions = {},
	): Promise<RemoteCommandResult> {
		return this.tmux.sendLiteral(this.localSessionId(targetId), input, commandOptions);
	}

	async tmuxSendSensitive(targetId: string, input: Buffer, commandOptions: RemoteCommandOptions = {}): Promise<void> {
		await this.tmux.sendSensitive(this.localSessionId(targetId), input, commandOptions);
	}

	tmuxSendKey(targetId: string, key: string, commandOptions: RemoteCommandOptions = {}): Promise<RemoteCommandResult> {
		return this.tmux.sendKey(this.localSessionId(targetId), key, commandOptions);
	}

	tmuxResize(
		targetId: string,
		columns: number,
		rows: number,
		commandOptions: RemoteCommandOptions = {},
	): Promise<RemoteCommandResult> {
		return this.tmux.resize(this.localSessionId(targetId), columns, rows, commandOptions);
	}

	async tmuxExecute(
		targetId: string,
		command: string,
		commandOptions: RemoteCommandOptions = {},
	): Promise<RemoteCommandResult> {
		const startedAt = Date.now();
		const token = randomUUID().replaceAll("-", "");
		const beginMarker = `__BEAUPI_BEGIN_${token}__`;
		const endMarker = `__BEAUPI_END_${token}__`;
		const encodedCommand = Buffer.from(command, "utf8").toString("base64");
		const wrapper = [
			`printf '\\n%s\\n' ${shellQuote(beginMarker)}`,
			`eval "$(printf %s ${shellQuote(encodedCommand)} | base64 -d)"`,
			"__beaupi_terminal_status=$?",
			`printf '\\n%s:%s\\n' ${shellQuote(endMarker)} "$__beaupi_terminal_status"`,
		].join("; ");
		const transcriptPath =
			this.transcriptPaths.get(targetId) ?? this.transcriptPaths.get(this.localSessionId(targetId));
		const transcriptOffset = transcriptPath ? (await stat(transcriptPath)).size : undefined;
		const sent = await this.tmuxSend(targetId, `${wrapper}\n`, { signal: commandOptions.signal });
		if (sent.exitCode !== 0) {
			throw new RemoteExecutionError({
				code: "terminal_session_lost",
				message: `Could not inject command into local tmux pane: ${safeDiagnosticText(sent.stderr) || "tmux send failed"}`,
				targetId: this.targetId,
				exitCode: sent.exitCode,
			});
		}
		const deadline =
			commandOptions.timeoutMs === undefined ? undefined : startedAt + Math.max(1, commandOptions.timeoutMs);
		let emittedOutput = "";
		const captureOutput = async (): Promise<{ output: string; exitCode?: number }> => {
			const capturedText =
				transcriptPath && transcriptOffset !== undefined
					? (await readFile(transcriptPath)).subarray(transcriptOffset).toString("utf8")
					: (await this.tmuxCapture(targetId)).stdout;
			const parsed = parseTerminalCommandCapture(capturedText, beginMarker, endMarker);
			if (!parsed.found) return { output: emittedOutput };
			const delta = parsed.output.startsWith(emittedOutput)
				? parsed.output.slice(emittedOutput.length)
				: parsed.output;
			if (delta) commandOptions.onData?.(Buffer.from(delta, "utf8"));
			emittedOutput = parsed.output;
			return { output: parsed.output, exitCode: parsed.exitCode };
		};
		while (true) {
			if (commandOptions.signal?.aborted) {
				await this.interruptTmuxPane(targetId);
				await delay(TMUX_INTERRUPT_SETTLE_MS);
				await captureOutput().catch(() => ({ output: emittedOutput }));
				throw new RemoteExecutionError({
					code: "remote_cancelled",
					message: "Terminal command was cancelled",
					targetId: this.targetId,
				});
			}
			if (deadline !== undefined && Date.now() >= deadline) {
				await this.interruptTmuxPane(targetId);
				await delay(TMUX_INTERRUPT_SETTLE_MS);
				await captureOutput().catch(() => ({ output: emittedOutput }));
				throw new RemoteExecutionError({
					code: "remote_timeout",
					message: `Terminal command timed out after ${Math.ceil((commandOptions.timeoutMs ?? 0) / 1000)} seconds`,
					targetId: this.targetId,
					retryable: true,
				});
			}
			const captured = await captureOutput();
			if (captured.exitCode !== undefined) {
				return {
					stdout: captured.output,
					stderr: "",
					exitCode: captured.exitCode,
					startedAt,
					completedAt: Date.now(),
				};
			}
			const status = await this.tmuxStatus(targetId);
			if (!status.exists) {
				const disconnected = /broken pipe|connection.*closed|closed by remote|connection reset/i.test(
					captured.output,
				);
				throw new RemoteExecutionError({
					code: disconnected ? "ssh_disconnected" : "terminal_session_lost",
					message: disconnected
						? `SSH disconnected: ${safeDiagnosticText(captured.output) || "connection closed"}`
						: "Local tmux pane disappeared while the terminal command was running",
					targetId: this.targetId,
					retryable: disconnected,
				});
			}
			await delay(TMUX_WAIT_POLL_MS);
		}
	}

	async tmuxCapture(targetId: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		return this.tmux.capture(this.localSessionId(targetId), commandOptions);
	}

	async tmuxCaptureStyled(targetId: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		return this.tmux.captureStyled(this.localSessionId(targetId), commandOptions);
	}

	async tmuxCaptureScreen(targetId: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		return this.tmux.captureScreen(this.localSessionId(targetId), commandOptions);
	}

	async tmuxStatus(targetId: string, commandOptions?: RemoteCommandOptions): Promise<TmuxStatus> {
		const status = await this.tmux.status(this.localSessionId(targetId), commandOptions);
		return { ...status, attached: false };
	}

	private async interruptTmuxPane(targetId: string): Promise<void> {
		await this.tmux.sendKey(this.localSessionId(targetId), "C-c", { timeoutMs: 2_000 }).catch(() => {});
	}

	private async removeTranscript(targetId: string): Promise<void> {
		const transcriptPath = this.transcriptPaths.get(targetId);
		if (!transcriptPath) return;
		for (const [key, path] of this.transcriptPaths) {
			if (path === transcriptPath) this.transcriptPaths.delete(key);
		}
		await rm(transcriptPath, { force: true }).catch(() => {});
	}

	private localSessionId(targetId: string): string {
		return targetId.startsWith("%") ? targetId : localTmuxSessionId(this.sessionNamespace, this.targetId, targetId);
	}

	async tmuxClose(sessionId: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		const localSessionId = this.localSessionId(sessionId);
		const result = await this.tmux.close(localSessionId, commandOptions);
		this.localSessions.delete(localSessionId);
		await this.removeTranscript(localSessionId);
		return result;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.localSessions.size > 0) return;
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
	/** Namespace used to avoid collisions between local tmux sessions from different Agent sessions. */
	sessionNamespace?: string;
}

/** Real adapter backed by the user's OpenSSH binary/configuration. */
export class OpenSshTmuxAdapter implements SshTmuxAdapter {
	readonly kind = "ssh-tmux" as const;
	private readonly targets: ExecutionTargetRegistry;
	private readonly sessionNamespace: string;
	private readonly localSessions = new Set<string>();
	private readonly transcriptPaths = new Map<string, string>();
	private readonly connections = new Map<string, Promise<OpenSshConnection>>();
	private readonly snapshots = new Map<string, MonitorAdapterSnapshot>();
	private readonly commandAbortControllers = new Map<string, AbortController>();
	private readonly tmux = new LocalTmuxTransport();

	constructor(options: OpenSshTmuxAdapterOptions) {
		this.targets = options.targets;
		this.sessionNamespace = options.sessionNamespace ?? process.env.PI_SESSION_ID ?? String(process.pid);
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
				return new OpenSshConnection(
					target,
					controlPath,
					this.sessionNamespace,
					this.localSessions,
					this.transcriptPaths,
					this.tmux,
				);
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
		for (const sessionId of this.localSessions) {
			await this.tmux.close(sessionId, { timeoutMs: 2_000 }).catch(() => {});
		}
		this.localSessions.clear();
		for (const transcriptPath of new Set(this.transcriptPaths.values())) {
			await rm(transcriptPath, { force: true }).catch(() => {});
		}
		this.transcriptPaths.clear();
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
		targetId: string,
		input: string,
		commandOptions?: RemoteCommandOptions,
	): Promise<RemoteCommandResult> {
		this.adapter.sendFakeTerminal(targetId, input);
		return this.execute(`tmux send-keys ${targetId}`, commandOptions);
	}

	async tmuxSendSensitive(targetId: string, input: Buffer, _commandOptions?: RemoteCommandOptions): Promise<void> {
		this.adapter.sendFakeSensitiveInput(targetId, input);
	}

	async tmuxSendKey(
		targetId: string,
		key: string,
		commandOptions?: RemoteCommandOptions,
	): Promise<RemoteCommandResult> {
		this.adapter.sendFakeKey(targetId, key);
		return this.execute(`tmux send-key ${targetId} ${key}`, commandOptions);
	}

	async tmuxResize(
		targetId: string,
		columns: number,
		rows: number,
		commandOptions?: RemoteCommandOptions,
	): Promise<RemoteCommandResult> {
		this.adapter.resizeFakeTerminal(targetId, columns, rows);
		return this.execute(`tmux resize-pane ${targetId}`, commandOptions);
	}

	tmuxExecute(targetId: string, command: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		return this.adapter.executeFakeTerminal(targetId, command, commandOptions);
	}

	async tmuxCapture(targetId: string, _commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		const output = this.adapter.captureFakeTerminal(targetId);
		return { stdout: output, stderr: "", exitCode: 0, startedAt: Date.now(), completedAt: Date.now() };
	}

	async tmuxCaptureStyled(targetId: string, _commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		const output = this.adapter.captureFakeTerminal(targetId);
		return { stdout: output, stderr: "", exitCode: 0, startedAt: Date.now(), completedAt: Date.now() };
	}

	async tmuxCaptureScreen(targetId: string, _commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		const output = this.adapter.captureFakeTerminal(targetId);
		return { stdout: output, stderr: "", exitCode: 0, startedAt: Date.now(), completedAt: Date.now() };
	}

	async tmuxStatus(targetId: string, commandOptions?: RemoteCommandOptions): Promise<TmuxStatus> {
		if (commandOptions?.signal?.aborted)
			throw new RemoteExecutionError({ code: "remote_cancelled", message: "Remote SSH operation was cancelled" });
		return this.adapter.statusFakeTerminal(targetId);
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
	private readonly terminalCommandResults = new Map<string, FakeCommand>();
	private readonly terminals = new Map<
		string,
		{ output: string; exists: boolean; paneId: string; currentCommand: string }
	>();
	private readonly snapshots = new Map<string, MonitorAdapterSnapshot>();
	private readonly stopResults = new Map<string, MonitorStopResult>();
	private readonly sensitiveInput: Buffer[] = [];
	private nextPaneId = 1;
	connectCalls = 0;
	commandCalls: string[] = [];
	terminalCommandCalls: Array<{ terminalId: string; command: string }> = [];
	tmuxCreateCalls: TmuxCreateOptions[] = [];
	tmuxKeyCalls: Array<{ terminalId: string; key: string }> = [];
	tmuxResizeCalls: Array<{ terminalId: string; columns: number; rows: number }> = [];
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

	setTerminalCommandResult(terminalId: string, command: string, result: Partial<FakeCommand>): void {
		this.terminalCommandResults.set(`${terminalId}\0${command}`, {
			stdout: "",
			stderr: "",
			exitCode: 0,
			...result,
		});
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
		this.commandCalls.push(command);
		const configured = this.commandResults.get(command) ?? { stdout: "ok\n", stderr: "", exitCode: 0 };
		return this.resolveFakeCommand(configured, options);
	}

	async executeFakeTerminal(
		targetId: string,
		command: string,
		options: RemoteCommandOptions = {},
	): Promise<RemoteCommandResult> {
		const entry = this.findFakeTerminal(targetId);
		if (!entry?.terminal.exists) {
			throw new RemoteExecutionError({
				code: "terminal_session_lost",
				message: `tmux target ${JSON.stringify(targetId)} is missing`,
			});
		}
		this.terminalCommandCalls.push({ terminalId: entry.terminalId, command });
		const configured = this.terminalCommandResults.get(`${entry.terminalId}\0${command}`) ?? {
			stdout: "ok\n",
			stderr: "",
			exitCode: 0,
		};
		const shellCommand = entry.terminal.currentCommand;
		entry.terminal.currentCommand = "bash";
		try {
			const result = await this.resolveFakeCommand(configured, options);
			entry.terminal.output += `${command}\n${result.stdout}${result.stderr}`;
			return result;
		} finally {
			entry.terminal.currentCommand = shellCommand;
		}
	}

	createFakeTerminal(options: TmuxCreateOptions): void {
		this.tmuxCreateCalls.push(structuredClone(options));
		this.terminals.set(options.sessionId, {
			output: options.command ? `${options.command}\n` : "",
			exists: true,
			paneId: `%${this.nextPaneId++}`,
			currentCommand: options.command ? options.command.split(/\s+/, 1)[0] || "sh" : "bash",
		});
	}

	sendFakeTerminal(targetId: string, input: string): void {
		const entry = this.findFakeTerminal(targetId);
		if (!entry?.terminal.exists) return;
		entry.terminal.output += input;
	}

	sendFakeSensitiveInput(targetId: string, input: Buffer): void {
		const entry = this.findFakeTerminal(targetId);
		if (!entry?.terminal.exists) return;
		this.sensitiveInput.push(Buffer.from(input));
	}

	getSensitiveInputForTest(): Buffer {
		return Buffer.concat(this.sensitiveInput.map((input) => Buffer.from(input)));
	}

	sendFakeKey(targetId: string, key: string): void {
		const entry = this.findFakeTerminal(targetId);
		if (!entry?.terminal.exists) return;
		this.tmuxKeyCalls.push({ terminalId: entry.terminalId, key });
		if (key === "C-u") {
			const newline = entry.terminal.output.lastIndexOf("\n");
			entry.terminal.output = newline === -1 ? "" : entry.terminal.output.slice(0, newline + 1);
		}
	}

	resizeFakeTerminal(targetId: string, columns: number, rows: number): void {
		const entry = this.findFakeTerminal(targetId);
		if (entry?.terminal.exists) this.tmuxResizeCalls.push({ terminalId: entry.terminalId, columns, rows });
	}

	captureFakeTerminal(targetId: string): string {
		const entry = this.findFakeTerminal(targetId);
		if (!entry?.terminal.exists)
			throw new RemoteExecutionError({
				code: "terminal_session_lost",
				message: `tmux target ${JSON.stringify(targetId)} is missing`,
			});
		return entry.terminal.output;
	}

	statusFakeTerminal(targetId: string): TmuxStatus {
		const entry = this.findFakeTerminal(targetId);
		if (!entry?.terminal.exists) return { exists: false, attached: false };
		return {
			exists: true,
			attached: false,
			paneId: entry.terminal.paneId,
			currentCommand: entry.terminal.currentCommand,
			cursorY: Math.max(0, entry.terminal.output.replaceAll("\r", "").split("\n").length - 1),
		};
	}

	hasFakeTerminal(targetId: string): boolean {
		return this.findFakeTerminal(targetId)?.terminal.exists === true;
	}

	closeFakeTerminal(sessionId: string): void {
		const terminal = this.terminals.get(sessionId);
		if (terminal) terminal.exists = false;
	}

	private findFakeTerminal(
		targetId: string,
	):
		| { terminalId: string; terminal: { output: string; exists: boolean; paneId: string; currentCommand: string } }
		| undefined {
		const direct = this.terminals.get(targetId);
		if (direct) return { terminalId: targetId, terminal: direct };
		for (const [terminalId, terminal] of this.terminals) {
			if (terminal.paneId === targetId) return { terminalId, terminal };
		}
		return undefined;
	}

	private async resolveFakeCommand(
		configured: FakeCommand,
		options: RemoteCommandOptions,
	): Promise<RemoteCommandResult> {
		if (options.signal?.aborted)
			throw new RemoteExecutionError({ code: "remote_cancelled", message: "Remote SSH operation was cancelled" });
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
}

export {
	classifyConnectionFailure,
	localTmuxSessionId,
	parseTerminalCommandCapture,
	remoteTerminalStartup,
	safeDiagnosticText,
	shellQuote,
};
