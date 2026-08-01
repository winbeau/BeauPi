import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { MonitorRuntime } from "../monitor/monitor-runtime.ts";
import type { MonitorAdapterSnapshot } from "../monitor/types.ts";
import { hasPotentialShellPrivilege } from "../policy/index.ts";
import {
	isPrivilegeAuthenticationPrompt,
	type PrivilegeCommandResultV1,
	type PrivilegeCommandSession,
	type PrivilegeRequestV1,
	type PrivilegeTerminalFrameV1,
} from "../privilege/types.ts";
import type { SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { BashOperations } from "../tools/bash.ts";
import type { EditOperations } from "../tools/edit.ts";
import type { ReadOperations } from "../tools/read.ts";
import type { WriteOperations } from "../tools/write.ts";
import { OpenSshTmuxAdapter, parseTerminalCommandCapture } from "./adapter.ts";
import {
	deterministicTerminalReport,
	lineCount,
	successfulTerminalReport,
	type TerminalOutputReviewer,
	type TerminalReviewInput,
	withLogPath,
} from "./output-reviewer.ts";
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

const REMOTE_PRIVILEGE_START_TIMEOUT_MS = 5_000;

interface RemoteTerminalState {
	terminalId: string;
	targetId: string;
	monitorId: string;
	logPath: string;
	paneId: string;
	shellCommand?: string;
	interactive: boolean;
	busy: boolean;
	lastCapture: string;
	captureCursor: number;
	pendingInput: string;
	pendingInputOpaque: boolean;
}

export interface RemoteExecutionRuntimeOptions {
	cwd: string;
	sessionId: string;
	sessionManager?: Pick<SessionManager, "getBranch" | "appendCustomEntry">;
	settingsManager?: SettingsManager;
	monitorRuntime: MonitorRuntime;
	targets?: ExecutionTargetRegistry;
	adapter?: SshTmuxAdapter;
	outputReviewer?: TerminalOutputReviewer;
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

export interface TerminalBashResult {
	ok: boolean;
	terminalId: string;
	monitorId: string;
	command: string;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	logPath: string;
	durationMs: number;
	report: string;
	review: {
		model?: string;
		status: "completed" | "fallback" | "skipped";
		inputTruncated: boolean;
		error?: string;
	};
	usage?: Usage;
	diagnostic?: RemoteDiagnostic;
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

function containsPotentialPrivilege(command: string): boolean {
	return hasPotentialShellPrivilege(command);
}

function applyTerminalInput(current: string, currentOpaque: boolean, input: string): { line: string; opaque: boolean } {
	let line = current;
	let opaque = currentOpaque;
	for (const character of input) {
		if (character === "\u0003" || character === "\u0015") {
			line = "";
			opaque = false;
		} else if (character === "\b" || character === "\u007f") {
			line = [...line].slice(0, -1).join("");
		} else if (character === "\u0017") {
			line = line.replace(/\s*\S+\s*$/, "");
		} else if (character === "\t" || character === "\u001b" || character < " ") {
			opaque = true;
		} else {
			line += character;
		}
	}
	return { line, opaque };
}

function assertNoPrivilegeChange(command: string): void {
	if (containsPotentialPrivilege(command)) {
		throw new RemoteExecutionError({
			code: "terminal_required",
			message: "Privilege-changing remote commands require an existing interactive terminal and PrivilegeRuntime",
		});
	}
}

function commandOperationId(): string {
	return `cmd-${randomUUID()}`;
}

function remoteCommandLogPath(cwd: string, sessionId: string, operationId: string): string {
	return resolve(cwd, ".beaupi", "remote-logs", sessionId, `${operationId}.log`);
}

function terminalLogPath(cwd: string, sessionId: string, terminalId: string): string {
	return resolve(cwd, ".beaupi", "terminal-logs", sessionId, terminalId, "工作日志.log");
}

function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function privilegeTerminalWrapper(
	command: string,
	stageMarker: string,
	beginMarker: string,
	endMarker: string,
): string {
	const encoded = Buffer.from(command, "utf8").toString("base64");
	return [
		"__beaupi_restore_echo(){ stty echo >/dev/null 2>&1; }",
		"trap '__beaupi_restore_echo || true' EXIT HUP INT TERM",
		`printf '\\n%s\\n' ${shellQuote(stageMarker)}`,
		`printf '$ %s' "$(printf %s ${shellQuote(encoded)} | base64 -d)"`,
		"if IFS= read -r __beaupi_execute; then stty -echo; __beaupi_echo_status=$?; printf '\\n%s\\n' " +
			shellQuote(beginMarker) +
			`; if [ "$__beaupi_echo_status" -ne 0 ]; then printf '%s\\n' 'Unable to disable terminal echo'; __beaupi_privilege_status=125; else eval "$(printf %s ${shellQuote(encoded)} | base64 -d)"; __beaupi_privilege_status=$?; if ! __beaupi_restore_echo; then __beaupi_privilege_status=125; printf '%s\\n' 'Unable to restore terminal echo'; fi; fi; else __beaupi_privilege_status=130; fi`,
		"trap - EXIT HUP INT TERM",
		`printf '\\n%s:%s\\n' ${shellQuote(endMarker)} "$__beaupi_privilege_status"`,
	].join("; ");
}

function stagedCommandCapture(capture: string, stageMarker: string): string | undefined {
	const lines = capture
		.replaceAll("\r", "")
		.split("\n")
		.map((line) => line.trimEnd());
	const index = lines.lastIndexOf(stageMarker);
	if (index === -1) return undefined;
	const output = lines.slice(index + 1);
	while (output.at(-1) === "") output.pop();
	return output.join("\n");
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
	private outputReviewer?: TerminalOutputReviewer;
	private selectedTargetId?: string;

	constructor(options: RemoteExecutionRuntimeOptions) {
		this.cwd = options.cwd;
		this.sessionId = options.sessionId;
		this.monitorRuntime = options.monitorRuntime;
		this.sessionManager = options.sessionManager;
		this.now = options.now ?? (() => Date.now());
		this.targets = options.targets ?? new ExecutionTargetRegistry({ settingsManager: options.settingsManager });
		this.adapter =
			options.adapter ?? new OpenSshTmuxAdapter({ targets: this.targets, sessionNamespace: options.sessionId });
		this.outputReviewer = options.outputReviewer;
		this.monitorRuntime.setAdapter("ssh-tmux", this.adapter);
		this.selectedTargetId = restoredTargetId(options.sessionManager?.getBranch() ?? []);
	}

	setOutputReviewerIfUnset(reviewer: TerminalOutputReviewer): void {
		this.outputReviewer ??= reviewer;
	}

	get selectedTarget(): ExecutionTargetConfig | undefined {
		return this.selectedTargetId ? this.getTarget(this.selectedTargetId) : undefined;
	}

	getTarget(targetId: string): ExecutionTargetConfig | undefined {
		const target = this.targets.get(targetId);
		return target ? structuredClone(target) : undefined;
	}

	isRootTarget(targetId: string | undefined): boolean {
		const resolved = targetId ?? this.selectedTargetId;
		return resolved ? this.targets.get(resolved)?.user === "root" : false;
	}

	listTargets(): ExecutionTargetConfig[] {
		return this.targets.list();
	}

	getTerminalContext(terminalId: string): { targetId: string; monitorId: string; logPath: string } {
		const terminal = this.assertTerminal(terminalId);
		return { targetId: terminal.targetId, monitorId: terminal.monitorId, logPath: terminal.logPath };
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
		assertNoPrivilegeChange(command);
		const target = this.assertTarget(options.targetId);
		const operationId = commandOperationId();
		const logPath = remoteCommandLogPath(this.cwd, this.sessionId, operationId);
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
		if (options.command) assertNoPrivilegeChange(options.command);
		const operationId = terminalId;
		const logPath = terminalLogPath(this.cwd, this.sessionId, terminalId);
		await mkdir(dirname(logPath), { recursive: true });
		await writeFile(logPath, "", { encoding: "utf8", mode: 0o600 });
		await chmod(logPath, 0o600);
		const monitor = this.monitorRuntime.attach({
			target: targetMonitorTarget(target.id, "terminal", operationId, terminalId, logPath),
			name: `tmux:${terminalId}`,
			taskSummary: "Local tmux SSH terminal",
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
			const status = await connection.tmuxStatus(terminalId, { signal: options.signal });
			if (!status.exists || !status.paneId) {
				throw new RemoteExecutionError({
					code: "terminal_session_lost",
					message: `Local tmux session ${JSON.stringify(terminalId)} did not expose a controllable pane`,
					targetId: target.id,
					operationId: terminalId,
				});
			}
			await this.initializeTerminalLog(monitor.id, logPath);
			const initialCapture = await connection
				.tmuxCapture(status.paneId, { signal: options.signal, timeoutMs: 2_000 })
				.catch(() => undefined);
			this.terminals.set(terminalId, {
				terminalId,
				targetId: target.id,
				monitorId: monitor.id,
				logPath,
				paneId: status.paneId,
				shellCommand: status.currentCommand,
				interactive: options.command === undefined,
				busy: false,
				lastCapture: initialCapture?.exitCode === 0 ? initialCapture.stdout : "",
				captureCursor: 0,
				pendingInput: "",
				pendingInputOpaque: false,
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
		if (terminal.busy) {
			throw new RemoteExecutionError({
				code: "terminal_busy",
				message: `Terminal ${JSON.stringify(terminalId)} is already running a controlled command`,
				operationId: terminalId,
			});
		}
		const target = this.assertTarget(terminal.targetId);
		const connection = await this.connect(target.id, signal);
		if (input.includes("\0")) {
			throw new RemoteExecutionError({
				code: "terminal_invalid",
				message: "terminal_send input cannot contain NUL bytes",
				operationId: terminalId,
			});
		}
		const parts = input.split(/(\r\n|\r|\n)/);
		for (let index = 0; index < parts.length; index += 2) {
			const segment = parts[index] ?? "";
			const delimiter = parts[index + 1];
			if (delimiter !== undefined) {
				const pending = applyTerminalInput(terminal.pendingInput, terminal.pendingInputOpaque, segment);
				if (pending.opaque || containsPotentialPrivilege(pending.line)) {
					await connection.tmuxSendKey(terminal.paneId, "C-u", { signal }).catch(() => undefined);
					terminal.pendingInput = "";
					terminal.pendingInputOpaque = false;
					throw new RemoteExecutionError({
						code: "terminal_required",
						message: "Blocked a pending privilege-changing terminal line; use terminal_bash or privileged_exec",
						targetId: target.id,
						operationId: terminalId,
					});
				}
				const result = await connection.tmuxSend(terminal.paneId, `${segment}${delimiter}`, { signal });
				if (result.exitCode !== 0) throw this.tmuxError(result, target.id, terminalId, "terminal_session_lost");
				terminal.pendingInput = "";
				terminal.pendingInputOpaque = false;
				continue;
			}
			if (!segment) continue;
			const pending = applyTerminalInput(terminal.pendingInput, terminal.pendingInputOpaque, segment);
			if (pending.opaque) {
				await connection.tmuxSendKey(terminal.paneId, "C-u", { signal }).catch(() => undefined);
				terminal.pendingInput = "";
				terminal.pendingInputOpaque = false;
				throw new RemoteExecutionError({
					code: "terminal_required",
					message: "Blocked opaque terminal input before it reached the shell",
					targetId: target.id,
					operationId: terminalId,
				});
			}
			const result = await connection.tmuxSend(terminal.paneId, segment, { signal });
			if (result.exitCode !== 0) throw this.tmuxError(result, target.id, terminalId, "terminal_session_lost");
			terminal.pendingInput = pending.line;
			terminal.pendingInputOpaque = false;
		}
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

	async createPrivilegeCommandSession(
		request: PrivilegeRequestV1,
		signal?: AbortSignal,
	): Promise<PrivilegeCommandSession> {
		const terminalId = request.target.terminalId;
		if (!terminalId)
			throw new RemoteExecutionError({
				code: "terminal_not_found",
				message: "Privilege request requires terminalId",
			});
		const terminal = this.assertTerminal(terminalId);
		if (!terminal.interactive) {
			throw new RemoteExecutionError({
				code: "terminal_busy",
				message: `Terminal ${JSON.stringify(terminalId)} is not an interactive shell`,
				operationId: terminalId,
			});
		}
		if (terminal.busy || terminal.pendingInput.length > 0 || terminal.pendingInputOpaque) {
			throw new RemoteExecutionError({
				code: "terminal_busy",
				message: `Terminal ${JSON.stringify(terminalId)} is busy or has pending input`,
				operationId: terminalId,
			});
		}
		const target = this.assertTarget(terminal.targetId);
		const connection = await this.connect(target.id, signal);
		const token = randomUUID().replaceAll("-", "");
		const stageMarker = `__BEAUPI_PRIV_STAGE_${token}__`;
		const beginMarker = `__BEAUPI_PRIV_BEGIN_${token}__`;
		const endMarker = `__BEAUPI_PRIV_END_${token}__`;
		const controller = new AbortController();
		const forwardAbort = (): void => controller.abort();
		if (signal?.aborted) controller.abort();
		else signal?.addEventListener("abort", forwardAbort, { once: true });
		let startAttempted = false;
		let prepared = false;
		let executionReleased = false;
		let executed = false;
		let startedAt: number | undefined;
		let completed = false;
		let disposed = false;
		let finalized = false;
		let reusable = true;
		let lastOutput = "";
		const finalize = async (
			result: PrivilegeCommandResultV1,
			remoteDiagnostic?: RemoteDiagnostic,
		): Promise<PrivilegeCommandResultV1> => {
			if (!finalized) {
				finalized = true;
				reusable = !/Unable to (?:disable|restore) terminal echo/.test(result.output);
				terminal.busy = !reusable;
				const output = redactOutput(result.output);
				await this.recordTerminalCommandOutput(terminal, connection, {
					command: request.command,
					output,
					exitCode: result.exitCode,
					diagnostic: remoteDiagnostic,
					startedAt: result.startedAt,
					completedAt: result.completedAt,
				});
				result.output = output;
			}
			return result;
		};
		let restorePromise: Promise<boolean> | undefined;
		const restoreEcho = (): Promise<boolean> => {
			restorePromise ??= (async () => {
				await connection.tmuxSendKey(terminal.paneId, "C-c", { timeoutMs: 2_000 }).catch(() => undefined);
				const deadline = this.now() + 2_000;
				while (this.now() < deadline) {
					const capture = await connection
						.tmuxCapture(terminal.paneId, { timeoutMs: 2_000 })
						.catch(() => undefined);
					if (!capture || capture.exitCode !== 0) return false;
					const parsed = parseTerminalCommandCapture(capture.stdout, beginMarker, endMarker);
					if (parsed.exitCode !== undefined)
						return !/Unable to (?:disable|restore) terminal echo/.test(parsed.output);
					await delay(50);
				}
				return false;
			})();
			return restorePromise;
		};
		return {
			start: async () => {
				if (startAttempted) throw new Error("Remote privilege command already started");
				startAttempted = true;
				const status = await connection.tmuxStatus(terminal.paneId, { signal: controller.signal });
				if (!status.exists) {
					throw new RemoteExecutionError({
						code: "terminal_session_lost",
						message: `Local tmux pane for terminal ${JSON.stringify(terminalId)} no longer exists`,
						targetId: target.id,
						operationId: terminalId,
					});
				}
				if (terminal.shellCommand && status.currentCommand && status.currentCommand !== terminal.shellCommand) {
					throw new RemoteExecutionError({
						code: "terminal_busy",
						message: `Terminal ${JSON.stringify(terminalId)} is currently running another command`,
						targetId: target.id,
						operationId: terminalId,
					});
				}
				terminal.busy = true;
				const sent = await connection.tmuxSend(
					terminal.paneId,
					`${privilegeTerminalWrapper(request.command, stageMarker, beginMarker, endMarker)}\n`,
					{ signal: controller.signal },
				);
				if (sent.exitCode !== 0) {
					reusable = false;
					terminal.busy = true;
					throw this.tmuxError(sent, target.id, terminalId, "terminal_session_lost");
				}
				const deadline = this.now() + REMOTE_PRIVILEGE_START_TIMEOUT_MS;
				while (true) {
					const capture = await connection.tmuxCapture(terminal.paneId, { signal: controller.signal });
					if (capture.exitCode !== 0) {
						reusable = false;
						terminal.busy = true;
						throw this.tmuxError(capture, target.id, terminalId, "terminal_session_lost");
					}
					if (stagedCommandCapture(capture.stdout, stageMarker) !== undefined) break;
					if (this.now() >= deadline) {
						reusable = false;
						terminal.busy = true;
						throw new RemoteExecutionError({
							code: "terminal_busy",
							message: "Privilege command staging timed out",
							targetId: target.id,
							operationId: terminalId,
						});
					}
					await delay(50);
				}
				prepared = true;
			},
			execute: async () => {
				if (!prepared || executed || completed)
					throw new Error("Remote privilege command is not waiting for execution");
				const executionStartedAt = this.now();
				executionReleased = true;
				const sent = await connection.tmuxSendKey(terminal.paneId, "Enter", { signal: controller.signal });
				if (sent.exitCode !== 0) throw this.tmuxError(sent, target.id, terminalId, "terminal_session_lost");
				const deadline = this.now() + REMOTE_PRIVILEGE_START_TIMEOUT_MS;
				while (true) {
					const capture = await connection.tmuxCapture(terminal.paneId, { signal: controller.signal });
					if (capture.exitCode !== 0)
						throw this.tmuxError(capture, target.id, terminalId, "terminal_session_lost");
					const parsed = parseTerminalCommandCapture(capture.stdout, beginMarker, endMarker);
					if (parsed.output.includes("Unable to disable terminal echo")) {
						reusable = false;
						terminal.busy = true;
						throw new RemoteExecutionError({
							code: "terminal_busy",
							message: "Privilege terminal echo could not be disabled",
							targetId: target.id,
							operationId: terminalId,
						});
					}
					if (parsed.found) break;
					if (this.now() >= deadline) {
						reusable = false;
						terminal.busy = true;
						throw new RemoteExecutionError({
							code: "terminal_busy",
							message: "Privilege terminal echo handshake timed out",
							targetId: target.id,
							operationId: terminalId,
						});
					}
					await delay(50);
				}
				executed = true;
				startedAt = executionStartedAt;
			},
			sendSensitive: async (input) => {
				if (!executed || startedAt === undefined || completed)
					throw new Error("Remote privilege terminal is not accepting input");
				await connection.tmuxSendSensitive(terminal.paneId, Buffer.from(input), { signal: controller.signal });
			},
			capture: async (): Promise<PrivilegeTerminalFrameV1> => {
				if (!prepared) return { content: "", state: "starting" };
				const [capture, screen, status] = await Promise.all([
					connection.tmuxCapture(terminal.paneId, { signal: controller.signal }),
					connection.tmuxCaptureScreen(terminal.paneId, { signal: controller.signal }),
					connection.tmuxStatus(terminal.paneId, { signal: controller.signal }),
				]);
				if (capture.exitCode !== 0 || screen.exitCode !== 0 || !status.exists) {
					return { content: "", state: "lost" };
				}
				const parsed = parseTerminalCommandCapture(capture.stdout, beginMarker, endMarker);
				const content = executed
					? parsed.found
						? redactOutput(parsed.output)
						: ""
					: (stagedCommandCapture(capture.stdout, stageMarker) ?? "");
				if (!executed) return { content, state: "waiting_for_user" };
				const authenticating =
					status.cursorY === undefined
						? /(?:password|passphrase)[^:\r\n]*:/i.test(content)
						: isPrivilegeAuthenticationPrompt(screen.stdout, status.cursorY);
				return {
					content,
					state: parsed.exitCode !== undefined ? "complete" : authenticating ? "authenticating" : "running",
				};
			},
			resize: async (columns, rows) => {
				if (completed) return;
				const result = await connection.tmuxResize(terminal.paneId, columns, rows, { signal: controller.signal });
				if (result.exitCode !== 0) throw this.tmuxError(result, target.id, terminalId, "terminal_session_lost");
			},
			cancel: async () => {
				if (completed) return;
				controller.abort();
				if (!executionReleased) {
					await connection.tmuxSendKey(terminal.paneId, "C-c", { timeoutMs: 2_000 }).catch(() => undefined);
					reusable = true;
					terminal.busy = false;
					return;
				}
				reusable = await restoreEcho();
				terminal.busy = !reusable;
			},
			wait: async () => {
				if (!executed || startedAt === undefined) throw new Error("Remote privilege command has not started");
				const deadline = request.timeoutMs === undefined ? undefined : startedAt + request.timeoutMs;
				while (true) {
					try {
						const capture = await connection.tmuxCapture(terminal.paneId);
						const parsed = parseTerminalCommandCapture(capture.stdout, beginMarker, endMarker);
						if (parsed.found) lastOutput = parsed.output;
						if (parsed.exitCode !== undefined) {
							completed = true;
							const echoFailure = /Unable to (?:disable|restore) terminal echo/.test(lastOutput);
							return finalize({
								output: lastOutput,
								exitCode: parsed.exitCode,
								startedAt,
								completedAt: this.now(),
								monitorId: terminal.monitorId,
								logPath: terminal.logPath,
								diagnostic: echoFailure
									? { code: "echo_recovery_failed", message: "Privilege terminal echo could not be secured" }
									: undefined,
							});
						}
					} catch (error) {
						const remoteIssue = diagnosticForError(error, target.id, terminalId);
						completed = true;
						return finalize(
							{
								output: lastOutput,
								exitCode: null,
								startedAt,
								completedAt: this.now(),
								monitorId: terminal.monitorId,
								logPath: terminal.logPath,
								diagnostic: { code: "terminal_lost", message: remoteIssue.message },
							},
							remoteIssue,
						);
					}
					if (controller.signal.aborted) {
						reusable = await restoreEcho();
						completed = true;
						const remoteIssue: RemoteDiagnostic = {
							code: "remote_cancelled",
							message: "Privileged terminal command cancelled",
							targetId: target.id,
							operationId: terminalId,
						};
						return finalize(
							{
								output: lastOutput,
								exitCode: null,
								cancelled: true,
								startedAt,
								completedAt: this.now(),
								monitorId: terminal.monitorId,
								logPath: terminal.logPath,
								diagnostic: reusable
									? { code: "cancelled", message: remoteIssue.message }
									: { code: "echo_recovery_failed", message: "Privilege terminal echo recovery failed" },
							},
							remoteIssue,
						);
					}
					if (deadline !== undefined && this.now() >= deadline) {
						reusable = await restoreEcho();
						completed = true;
						const remoteIssue: RemoteDiagnostic = {
							code: "remote_timeout",
							message: "Privileged terminal command timed out",
							targetId: target.id,
							operationId: terminalId,
						};
						return finalize(
							{
								output: lastOutput,
								exitCode: null,
								timedOut: true,
								startedAt,
								completedAt: this.now(),
								monitorId: terminal.monitorId,
								logPath: terminal.logPath,
								diagnostic: reusable
									? { code: "timeout", message: remoteIssue.message }
									: { code: "echo_recovery_failed", message: "Privilege terminal echo recovery failed" },
							},
							remoteIssue,
						);
					}
					const status = await connection
						.tmuxStatus(terminal.paneId)
						.catch(() => ({ exists: false, attached: false }));
					if (!status.exists) {
						completed = true;
						const remoteIssue: RemoteDiagnostic = {
							code: "terminal_session_lost",
							message: "Privilege terminal pane was lost",
							targetId: target.id,
							operationId: terminalId,
						};
						return finalize(
							{
								output: lastOutput,
								exitCode: null,
								startedAt,
								completedAt: this.now(),
								monitorId: terminal.monitorId,
								logPath: terminal.logPath,
								diagnostic: { code: "terminal_lost", message: remoteIssue.message },
							},
							remoteIssue,
						);
					}
					await delay(50);
				}
			},
			dispose: async () => {
				if (disposed) return;
				disposed = true;
				signal?.removeEventListener("abort", forwardAbort);
				if (prepared && !executionReleased && !completed) {
					await connection.tmuxSendKey(terminal.paneId, "C-c", { timeoutMs: 2_000 }).catch(() => undefined);
					reusable = true;
				} else if (executionReleased && !completed) reusable = await restoreEcho();
				terminal.busy = !reusable;
			},
		};
	}

	async terminalBash(
		terminalId: string,
		command: string,
		options: { timeoutMs?: number; signal?: AbortSignal; onData?: (data: Buffer) => void } = {},
	): Promise<TerminalBashResult> {
		if (!command.trim() || command.includes("\0")) {
			throw new RemoteExecutionError({
				code: "remote_command",
				message: "terminal_bash requires a non-empty command without NUL bytes",
				operationId: terminalId,
			});
		}
		assertNoPrivilegeChange(command);
		const terminal = this.assertTerminal(terminalId);
		if (!terminal.interactive) {
			throw new RemoteExecutionError({
				code: "terminal_busy",
				message: `Terminal ${JSON.stringify(terminalId)} was created with a fixed command, not an interactive shell`,
				operationId: terminalId,
			});
		}
		if (terminal.busy || terminal.pendingInput.length > 0 || terminal.pendingInputOpaque) {
			throw new RemoteExecutionError({
				code: "terminal_busy",
				message: `Terminal ${JSON.stringify(terminalId)} is already running a command or has pending input`,
				operationId: terminalId,
			});
		}
		const target = this.assertTarget(terminal.targetId);
		const startedAt = this.now();
		const outputChunks: Buffer[] = [];
		let connection: SshConnection | undefined;
		let stdout = "";
		let stderr = "";
		let exitCode: number | null = null;
		let diagnostic: RemoteDiagnostic | undefined;
		terminal.busy = true;
		try {
			connection = await this.connect(target.id, options.signal);
			const status = await connection.tmuxStatus(terminal.paneId, { signal: options.signal });
			if (!status.exists) {
				throw new RemoteExecutionError({
					code: "terminal_session_lost",
					message: `Local tmux pane for terminal ${JSON.stringify(terminalId)} no longer exists`,
					targetId: target.id,
					operationId: terminalId,
				});
			}
			if (terminal.shellCommand && status.currentCommand && status.currentCommand !== terminal.shellCommand) {
				throw new RemoteExecutionError({
					code: "terminal_busy",
					message: `Terminal ${JSON.stringify(terminalId)} is currently running ${JSON.stringify(status.currentCommand)}`,
					targetId: target.id,
					operationId: terminalId,
				});
			}
			const result = await connection.tmuxExecute(terminal.paneId, command, {
				signal: options.signal,
				timeoutMs: options.timeoutMs,
				onData: (data) => {
					outputChunks.push(Buffer.from(data));
					options.onData?.(data);
				},
			});
			stdout = result.stdout;
			stderr = result.stderr;
			exitCode = result.exitCode;
			if (result.exitCode !== 0) {
				diagnostic = {
					code: "remote_command",
					message: `Terminal command exited with code ${result.exitCode ?? "unknown"}`,
					targetId: target.id,
					operationId: terminalId,
					exitCode: result.exitCode,
				};
			}
		} catch (error) {
			diagnostic = diagnosticForError(error, target.id, terminalId);
			const partialOutput = Buffer.concat(outputChunks).toString("utf8");
			stdout = partialOutput;
			stderr = "";
			exitCode = diagnostic.exitCode ?? null;
			if (diagnostic.code === "ssh_disconnected") await this.markConnectionLost(target.id, diagnostic.message);
		} finally {
			terminal.busy = false;
		}
		const completedAt = this.now();
		stdout = redactOutput(stdout);
		stderr = redactOutput(stderr);
		const output = `${stdout}${stderr}`;
		await this.recordTerminalCommandOutput(terminal, connection, {
			command,
			output,
			exitCode,
			diagnostic,
			startedAt,
			completedAt,
		});
		const reviewInput: TerminalReviewInput = {
			command: redactCommand(command),
			output,
			exitCode,
			diagnosticCode: diagnostic?.code,
			diagnosticMessage: diagnostic?.message,
			durationMs: Math.max(0, completedAt - startedAt),
			logPath: terminal.logPath,
		};
		const shouldReview =
			diagnostic?.code !== "remote_cancelled" &&
			(diagnostic !== undefined || exitCode !== 0 || lineCount(output) > 100);
		let report: string;
		let review: TerminalBashResult["review"];
		let usage: Usage | undefined;
		if (shouldReview && this.outputReviewer) {
			try {
				const reviewed = await this.outputReviewer.review(reviewInput, options.signal);
				report = withLogPath(reviewed.text, terminal.logPath);
				review = {
					model: reviewed.model,
					status: reviewed.status,
					inputTruncated: reviewed.inputTruncated,
					error: reviewed.error,
				};
				usage = reviewed.usage;
			} catch (error) {
				const fallback = deterministicTerminalReport(reviewInput);
				report = fallback.text;
				review = {
					status: "fallback",
					inputTruncated: fallback.inputTruncated,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		} else if (shouldReview) {
			const fallback = deterministicTerminalReport(reviewInput);
			report = fallback.text;
			review = { status: "fallback", inputTruncated: fallback.inputTruncated };
		} else if (diagnostic) {
			const fallback = deterministicTerminalReport(reviewInput);
			report = fallback.text;
			review = { status: "skipped", inputTruncated: fallback.inputTruncated };
		} else {
			report = successfulTerminalReport(redactCommand(command), terminal.logPath);
			review = { status: "skipped", inputTruncated: false };
		}
		return {
			ok: diagnostic === undefined && exitCode === 0,
			terminalId,
			monitorId: terminal.monitorId,
			command: redactCommand(command),
			stdout,
			stderr,
			exitCode,
			logPath: terminal.logPath,
			durationMs: reviewInput.durationMs,
			report,
			review,
			usage,
			diagnostic,
		};
	}

	async terminalCapture(terminalId: string, signal?: AbortSignal, cursor?: number): Promise<TerminalCaptureResult> {
		const terminal = this.assertTerminal(terminalId);
		const target = this.assertTarget(terminal.targetId);
		const connection = await this.connect(target.id, signal);
		let result: RemoteCommandResult;
		try {
			result = await connection.tmuxCapture(terminal.paneId, { signal });
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
			const status = await connection.tmuxStatus(terminal.paneId, { signal });
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

	private async recordTerminalCommandOutput(
		terminal: RemoteTerminalState,
		connection: SshConnection | undefined,
		record: {
			command: string;
			output: string;
			exitCode: number | null;
			diagnostic?: RemoteDiagnostic;
			startedAt: number;
			completedAt: number;
		},
	): Promise<void> {
		const output = record.output ? `${record.output}${record.output.endsWith("\n") ? "" : "\n"}` : "(no output)\n";
		const block = [
			`[${new Date(record.startedAt).toISOString()}] terminal=${terminal.terminalId} target=${terminal.targetId}`,
			`command=${redactCommand(record.command)}`,
			`exit=${record.diagnostic?.code ?? record.exitCode ?? "unknown"} durationMs=${Math.max(0, record.completedAt - record.startedAt)}`,
			"--- output ---",
			output.trimEnd(),
			"--- end ---",
			"",
		].join("\n");
		await appendFile(terminal.logPath, block, "utf8");
		terminal.captureCursor += Buffer.byteLength(block, "utf8");
		let exists = connection !== undefined;
		if (connection) {
			await delay(25);
			try {
				const capture = await connection.tmuxCapture(terminal.paneId, { timeoutMs: 2_000 });
				if (capture.exitCode === 0) terminal.lastCapture = capture.stdout;
				const status = await connection.tmuxStatus(terminal.paneId, { timeoutMs: 2_000 });
				exists = status.exists;
			} catch {
				exists = false;
			}
		}
		await this.monitorRuntime.logs(terminal.monitorId);
		const lost =
			record.diagnostic?.code === "ssh_disconnected" ||
			record.diagnostic?.code === "terminal_session_lost" ||
			!exists;
		this.setMonitorSnapshot(
			terminal.monitorId,
			lost
				? {
						availability: "missing",
						exitReason: record.diagnostic?.code ?? "tmux_session_missing",
						diagnostics: record.diagnostic ? [record.diagnostic.message] : undefined,
						logPath: terminal.logPath,
					}
				: {
						availability: "confirmed",
						running: true,
						healthy: true,
						lastActivityAt: this.now(),
						logPath: terminal.logPath,
					},
		);
		await this.monitorRuntime.poll();
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
		await chmod(logPath, 0o600);
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
			message: `tmux operation failed: ${redactOutput(result.stderr) || "local tmux returned a non-zero exit code"}`,
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
	return command
		.replace(/(password|passphrase|token|secret|authorization|identityfile)[ \t]*[=:][ \t]*[^\s]+/gi, "$1=[redacted]")
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
}

function redactOutput(output: string): string {
	return output
		.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted-key]")
		.replace(/(password|passphrase|token|secret|authorization)[ \t]*[=:][ \t]*[^\s]+/gi, "$1=[redacted]")
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
}

function diagnosticForError(error: unknown, targetId: string, operationId: string): RemoteDiagnostic {
	if (error instanceof RemoteExecutionError)
		return {
			...error.diagnostic,
			message: redactOutput(error.diagnostic.message),
			targetId: error.diagnostic.targetId ?? targetId,
			operationId: error.diagnostic.operationId ?? operationId,
		};
	return {
		code: "ssh_connection",
		message: redactOutput(error instanceof Error ? error.message : "Remote operation failed"),
		targetId,
		operationId,
		retryable: true,
	};
}

export { incrementalCapture, redactCommand, redactOutput };
