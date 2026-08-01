import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { getShellConfig } from "../../utils/shell.ts";
import { parseTerminalCommandCapture } from "../remote/adapter.ts";
import { LocalTmuxTransport } from "../terminal/local-tmux-transport.ts";
import { TerminalTransportError } from "../terminal/types.ts";
import type {
	PrivilegeCommandResultV1,
	PrivilegeCommandSession,
	PrivilegeRequestV1,
	PrivilegeTerminalAdapter,
	PrivilegeTerminalFrameV1,
} from "./types.ts";

const POLL_MS = 50;
const START_TIMEOUT_MS = 5_000;

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function sessionIdFor(request: PrivilegeRequestV1): string {
	const digest = createHash("sha256").update(request.requestId).digest("hex").slice(0, 24);
	return `beaupi-priv-${digest}`;
}

function minimalEnvironment(): string {
	const values: Record<string, string | undefined> = {
		HOME: process.env.HOME,
		USER: process.env.USER,
		LOGNAME: process.env.LOGNAME,
		PATH: process.env.PATH,
		SHELL: process.env.SHELL,
		TERM: process.env.TERM ?? "xterm-256color",
	};
	const entries = Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string");
	return ["env", "-i", ...entries.map(([name, value]) => `${name}=${shellQuote(value)}`)].join(" ");
}

function wrapper(command: string, beginMarker: string, endMarker: string): string {
	const encoded = Buffer.from(command, "utf8").toString("base64");
	return [
		"__beaupi_restore_echo(){ stty echo >/dev/null 2>&1; }",
		"trap '__beaupi_restore_echo || true' EXIT HUP INT TERM",
		`if ! stty -echo; then printf '\\n%s\\n' ${shellQuote(beginMarker)}; printf '%s\\n' 'Unable to disable terminal echo'; printf '\\n%s:%s\\n' ${shellQuote(endMarker)} 125; exit 125; fi`,
		`printf '\\n%s\\n' ${shellQuote(beginMarker)}`,
		`eval "$(printf %s ${shellQuote(encoded)} | base64 -d)"`,
		"__beaupi_privilege_status=$?",
		"if ! __beaupi_restore_echo; then __beaupi_privilege_status=125; printf '%s\\n' 'Unable to restore terminal echo'; fi",
		"trap - EXIT HUP INT TERM",
		`printf '\\n%s:%s\\n' ${shellQuote(endMarker)} "$__beaupi_privilege_status"`,
		'exit "$__beaupi_privilege_status"',
	].join("; ");
}

export interface RemotePrivilegeSessionHost {
	createPrivilegeCommandSession(request: PrivilegeRequestV1, signal?: AbortSignal): Promise<PrivilegeCommandSession>;
}

export interface TmuxPrivilegeTerminalAdapterOptions {
	remoteHost?: RemotePrivilegeSessionHost;
	shellPath?: string;
	transport?: LocalTmuxTransport;
	now?: () => number;
}

class LocalPrivilegeCommandSession implements PrivilegeCommandSession {
	private readonly request: PrivilegeRequestV1;
	private readonly shellPath: string | undefined;
	private readonly transport: LocalTmuxTransport;
	private readonly now: () => number;
	private readonly sessionId: string;
	private readonly beginMarker: string;
	private readonly endMarker: string;
	private readonly controller = new AbortController();
	private readonly sourceSignal: AbortSignal | undefined;
	private paneId: string | undefined;
	private startAttempted = false;
	private startedAt: number | undefined;
	private completed = false;
	private disposed = false;

	constructor(
		request: PrivilegeRequestV1,
		options: { shellPath?: string; transport: LocalTmuxTransport; now: () => number; signal?: AbortSignal },
	) {
		this.request = request;
		this.shellPath = options.shellPath;
		this.transport = options.transport;
		this.now = options.now;
		this.sourceSignal = options.signal;
		this.sessionId = sessionIdFor(request);
		const token = randomUUID().replaceAll("-", "");
		this.beginMarker = `__BEAUPI_PRIV_BEGIN_${token}__`;
		this.endMarker = `__BEAUPI_PRIV_END_${token}__`;
		if (options.signal?.aborted) this.controller.abort();
		else options.signal?.addEventListener("abort", this.forwardAbort, { once: true });
	}

	private readonly forwardAbort = (): void => this.controller.abort();

	async start(): Promise<void> {
		if (this.startAttempted) throw new Error("Privilege command session already started");
		this.startAttempted = true;
		if (this.controller.signal.aborted) throw new Error("Privilege command session cancelled");
		await mkdir(dirname(this.request.logPath), { recursive: true, mode: 0o700 });
		await chmod(dirname(this.request.logPath), 0o700);
		const logHandle = await open(
			this.request.logPath,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
			0o600,
		);
		await logHandle.close();
		const shell = getShellConfig(this.shellPath);
		if (shell.commandTransport === "stdin") {
			throw new TerminalTransportError("new-session", "Local privilege tmux requires an argv-capable shell");
		}
		const interactiveArgs = shell.shell.toLowerCase().endsWith("bash") ? ["--noprofile", "--norc"] : [];
		const childCommand = `${minimalEnvironment()} ${[shell.shell, ...interactiveArgs].map(shellQuote).join(" ")}`;
		const created = await this.transport.run(
			["new-session", "-d", "-s", this.sessionId, "-x", "100", "-y", "30", "-c", this.request.cwd, childCommand],
			{ signal: this.controller.signal },
		);
		if (created.exitCode !== 0) {
			throw new TerminalTransportError(
				"new-session",
				"Could not create local privilege tmux session",
				created.exitCode,
			);
		}
		try {
			await this.transport.requireSuccess("remain-on-exit", [
				"set-option",
				"-t",
				this.sessionId,
				"remain-on-exit",
				"on",
			]);
			await this.transport.requireSuccess("pipe-pane", [
				"pipe-pane",
				"-t",
				this.sessionId,
				`cat >> ${shellQuote(this.request.logPath)}`,
			]);
			const status = await this.transport.status(this.sessionId);
			if (!status.exists || !status.paneId)
				throw new TerminalTransportError("display-message", "Privilege pane was lost during startup");
			this.paneId = status.paneId;
			const releasedAt = this.now();
			const released = await this.transport.sendLiteral(
				this.paneId,
				`${wrapper(this.request.command, this.beginMarker, this.endMarker)}\n`,
				{ signal: this.controller.signal },
			);
			if (released.exitCode !== 0) {
				const reason = released.stderr
					.replace(/[\r\n\t]+/g, " ")
					.trim()
					.slice(0, 500);
				throw new TerminalTransportError(
					"send-keys",
					reason ? `Could not start privilege command: ${reason}` : "Could not start privilege command",
					released.exitCode,
				);
			}
			const deadline = this.now() + START_TIMEOUT_MS;
			while (true) {
				const capture = await this.transport.capture(this.paneId, { signal: this.controller.signal });
				if (capture.exitCode !== 0)
					throw new TerminalTransportError("capture-pane", "Privilege pane was lost during startup");
				const parsed = parseTerminalCommandCapture(capture.stdout, this.beginMarker, this.endMarker);
				if (parsed.output.includes("Unable to disable terminal echo")) {
					throw new TerminalTransportError("stty", "Privilege terminal echo could not be disabled");
				}
				if (parsed.found) break;
				if (this.now() >= deadline)
					throw new TerminalTransportError("capture-pane", "Privilege terminal echo handshake timed out");
				await delay(POLL_MS);
			}
			this.startedAt = releasedAt;
		} catch (error) {
			await this.transport.close(this.sessionId).catch(() => undefined);
			throw error;
		}
	}

	async sendSensitive(input: Buffer): Promise<void> {
		if (!this.paneId || this.startedAt === undefined || this.completed)
			throw new Error("Privilege terminal is not accepting input");
		await this.transport.sendSensitive(this.paneId, input, { signal: this.controller.signal });
	}

	async capture(): Promise<PrivilegeTerminalFrameV1> {
		if (!this.paneId) return { content: "", state: "starting" };
		const capture = await this.transport.capture(this.paneId, { signal: this.controller.signal });
		if (capture.exitCode !== 0) return { content: "", state: "lost" };
		const parsed = parseTerminalCommandCapture(capture.stdout, this.beginMarker, this.endMarker);
		const content = parsed.found ? parsed.output : capture.stdout;
		return {
			content,
			state:
				parsed.exitCode !== undefined
					? "complete"
					: /(?:password|passphrase)\s*:/i.test(content)
						? "authenticating"
						: "running",
		};
	}

	async resize(columns: number, rows: number): Promise<void> {
		if (!this.paneId || this.completed) return;
		const result = await this.transport.resize(this.paneId, columns, rows);
		if (result.exitCode !== 0)
			throw new TerminalTransportError("resize-pane", "Could not resize privilege pane", result.exitCode);
	}

	async cancel(): Promise<void> {
		if (this.completed) return;
		this.controller.abort();
		if (this.paneId) await this.transport.sendKey(this.paneId, "C-c", { timeoutMs: 2_000 }).catch(() => undefined);
	}

	async wait(): Promise<PrivilegeCommandResultV1> {
		if (!this.paneId || this.startedAt === undefined) throw new Error("Privilege command session has not started");
		const deadline = this.request.timeoutMs === undefined ? undefined : this.startedAt + this.request.timeoutMs;
		let output = "";
		while (true) {
			const capture = await this.transport.capture(this.paneId).catch(() => undefined);
			if (capture) {
				const parsed = parseTerminalCommandCapture(capture.stdout, this.beginMarker, this.endMarker);
				if (parsed.found) output = parsed.output;
				if (parsed.exitCode !== undefined) {
					this.completed = true;
					const echoFailure = /Unable to (?:disable|restore) terminal echo/.test(output);
					return {
						output,
						exitCode: parsed.exitCode,
						startedAt: this.startedAt,
						completedAt: this.now(),
						logPath: this.request.logPath,
						diagnostic: echoFailure
							? { code: "echo_recovery_failed", message: "Privilege terminal echo could not be secured" }
							: undefined,
					};
				}
			}
			if (this.controller.signal.aborted) {
				this.completed = true;
				return {
					output,
					exitCode: null,
					cancelled: true,
					startedAt: this.startedAt,
					completedAt: this.now(),
					logPath: this.request.logPath,
					diagnostic: { code: "cancelled", message: "Privilege command cancelled" },
				};
			}
			if (deadline !== undefined && this.now() >= deadline) {
				if (this.paneId)
					await this.transport.sendKey(this.paneId, "C-c", { timeoutMs: 2_000 }).catch(() => undefined);
				this.completed = true;
				return {
					output,
					exitCode: null,
					timedOut: true,
					startedAt: this.startedAt,
					completedAt: this.now(),
					logPath: this.request.logPath,
					diagnostic: { code: "timeout", message: "Privilege command timed out" },
				};
			}
			const status = await this.transport.status(this.paneId).catch(() => ({ exists: false, dead: false }));
			if (!status.exists) {
				this.completed = true;
				return {
					output,
					exitCode: null,
					startedAt: this.startedAt,
					completedAt: this.now(),
					logPath: this.request.logPath,
					diagnostic: { code: "terminal_lost", message: "Local privilege tmux pane was lost" },
				};
			}
			await delay(POLL_MS);
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.sourceSignal?.removeEventListener("abort", this.forwardAbort);
		await this.transport.close(this.sessionId, { timeoutMs: 2_000 }).catch(() => undefined);
	}
}

export class TmuxPrivilegeTerminalAdapter implements PrivilegeTerminalAdapter {
	private readonly remoteHost: RemotePrivilegeSessionHost | undefined;
	private readonly shellPath: string | undefined;
	private readonly transport: LocalTmuxTransport;
	private readonly now: () => number;

	constructor(options: TmuxPrivilegeTerminalAdapterOptions = {}) {
		this.remoteHost = options.remoteHost;
		this.shellPath = options.shellPath;
		this.transport = options.transport ?? new LocalTmuxTransport();
		this.now = options.now ?? (() => Date.now());
	}

	create(request: PrivilegeRequestV1, signal?: AbortSignal): Promise<PrivilegeCommandSession> {
		if (request.target.execution === "terminal") {
			if (!this.remoteHost) throw new Error("Remote privilege terminal host is not configured");
			return this.remoteHost.createPrivilegeCommandSession(request, signal);
		}
		return Promise.resolve(
			new LocalPrivilegeCommandSession(request, {
				shellPath: this.shellPath,
				transport: this.transport,
				now: this.now,
				signal,
			}),
		);
	}
}
