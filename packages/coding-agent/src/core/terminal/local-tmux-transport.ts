import { randomUUID } from "node:crypto";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import {
	type TerminalPaneStatus,
	type TerminalProcessOptions,
	type TerminalProcessResult,
	TerminalTransportError,
} from "./types.ts";

export type LocalTmuxTransportRunner = (
	args: string[],
	options: TerminalProcessOptions,
) => Promise<TerminalProcessResult>;

function safeDiagnostic(value: string): string {
	return value
		.replace(/[\r\n\t]+/g, " ")
		.trim()
		.slice(0, 500);
}

async function defaultRunner(args: string[], options: TerminalProcessOptions): Promise<TerminalProcessResult> {
	const startedAt = Date.now();
	if (options.signal?.aborted) throw new TerminalTransportError(args[0] ?? "tmux", "tmux operation cancelled");
	const child = spawnProcess("tmux", args, {
		stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let stdout = "";
	let stderr = "";
	let cancelled = false;
	let timedOut = false;
	let timeout: NodeJS.Timeout | undefined;
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
	child.stdin?.on("error", () => {});
	if (options.stdin) child.stdin?.end(options.stdin);
	options.signal?.addEventListener("abort", onAbort, { once: true });
	if (options.timeoutMs !== undefined) {
		timeout = setTimeout(
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
			throw new TerminalTransportError(args[0] ?? "tmux", "tmux operation cancelled", exitCode);
		}
		if (timedOut) throw new TerminalTransportError(args[0] ?? "tmux", "tmux operation timed out", exitCode);
		return { stdout, stderr, exitCode, startedAt, completedAt: Date.now() };
	} catch (error) {
		if (error instanceof TerminalTransportError) throw error;
		throw new TerminalTransportError(
			args[0] ?? "tmux",
			safeDiagnostic(error instanceof Error ? error.message : String(error)) || "tmux process failed",
		);
	} finally {
		if (timeout) clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

export interface LocalTmuxTransportOptions {
	runner?: LocalTmuxTransportRunner;
	randomId?: () => string;
}

const TMUX_STATUS_SEPARATOR = "__BEAUPI_TMUX_FIELD__";

export class LocalTmuxTransport {
	private readonly runner: LocalTmuxTransportRunner;
	private readonly randomId: () => string;

	constructor(options: LocalTmuxTransportOptions = {}) {
		this.runner = options.runner ?? defaultRunner;
		this.randomId = options.randomId ?? (() => `beaupi-${randomUUID().replaceAll("-", "")}`);
	}

	run(args: string[], options: TerminalProcessOptions = {}): Promise<TerminalProcessResult> {
		return this.runner(args, options);
	}

	async requireSuccess(
		operation: string,
		args: string[],
		options: TerminalProcessOptions = {},
	): Promise<TerminalProcessResult> {
		const result = await this.run(args, options);
		if (result.exitCode !== 0) {
			throw new TerminalTransportError(
				operation,
				`${operation} failed: ${safeDiagnostic(result.stderr) || "tmux returned a non-zero exit code"}`,
				result.exitCode,
			);
		}
		return result;
	}

	async sendLiteral(
		target: string,
		input: string,
		options: TerminalProcessOptions = {},
	): Promise<TerminalProcessResult> {
		const startedAt = Date.now();
		const segments = input.split(/\r\n|\r|\n/);
		let stdout = "";
		let stderr = "";
		let exitCode: number | null = 0;
		for (let index = 0; index < segments.length; index++) {
			const segment = segments[index] ?? "";
			if (segment || segments.length === 1) {
				const result = await this.run(["send-keys", "-t", target, "-l", segment], options);
				stdout += result.stdout;
				stderr += result.stderr;
				exitCode = result.exitCode;
				if (exitCode !== 0) break;
			}
			if (index < segments.length - 1) {
				const result = await this.run(["send-keys", "-t", target, "Enter"], options);
				stdout += result.stdout;
				stderr += result.stderr;
				exitCode = result.exitCode;
				if (exitCode !== 0) break;
			}
		}
		return { stdout, stderr, exitCode, startedAt, completedAt: Date.now() };
	}

	sendKey(target: string, key: string, options: TerminalProcessOptions = {}): Promise<TerminalProcessResult> {
		return this.run(["send-keys", "-t", target, key], options);
	}

	async sendSensitive(target: string, input: Buffer, options: TerminalProcessOptions = {}): Promise<void> {
		if (input.includes(0))
			throw new TerminalTransportError("load-buffer", "Sensitive terminal input cannot contain NUL");
		const bufferId = this.randomId();
		try {
			await this.requireSuccess("load-buffer", ["load-buffer", "-b", bufferId, "-"], {
				...options,
				stdin: Buffer.from(input),
			});
			await this.requireSuccess("paste-buffer", ["paste-buffer", "-d", "-r", "-b", bufferId, "-t", target], options);
		} finally {
			await this.run(["delete-buffer", "-b", bufferId], { timeoutMs: 2_000 }).catch(() => undefined);
		}
	}

	capture(target: string, options: TerminalProcessOptions = {}): Promise<TerminalProcessResult> {
		return this.run(["capture-pane", "-p", "-J", "-S", "-", "-t", target], options);
	}

	captureScreen(target: string, options: TerminalProcessOptions = {}): Promise<TerminalProcessResult> {
		return this.run(["capture-pane", "-p", "-t", target], options);
	}

	async status(target: string, options: TerminalProcessOptions = {}): Promise<TerminalPaneStatus> {
		const result = await this.run(
			[
				"display-message",
				"-p",
				"-t",
				target,
				`#{pane_id}${TMUX_STATUS_SEPARATOR}#{pane_current_command}${TMUX_STATUS_SEPARATOR}#{cursor_y}${TMUX_STATUS_SEPARATOR}#{pane_dead}${TMUX_STATUS_SEPARATOR}#{pane_dead_status}`,
			],
			options,
		);
		if (result.exitCode !== 0) return { exists: false };
		const [paneId, currentCommand, cursorY, dead, deadStatus] = result.stdout
			.trimEnd()
			.split(TMUX_STATUS_SEPARATOR, 5);
		return {
			exists: dead !== "1",
			paneId: paneId || undefined,
			currentCommand: currentCommand || undefined,
			cursorY: /^\d+$/.test(cursorY ?? "") ? Number(cursorY) : undefined,
			dead: dead === "1",
			exitCode: /^\d+$/.test(deadStatus ?? "") ? Number(deadStatus) : undefined,
		};
	}

	resize(
		target: string,
		columns: number,
		rows: number,
		options: TerminalProcessOptions = {},
	): Promise<TerminalProcessResult> {
		return this.run(
			[
				"resize-pane",
				"-t",
				target,
				"-x",
				String(Math.max(1, Math.floor(columns))),
				"-y",
				String(Math.max(1, Math.floor(rows))),
			],
			options,
		);
	}

	close(target: string, options: TerminalProcessOptions = {}): Promise<TerminalProcessResult> {
		return this.run(["kill-session", "-t", target], options);
	}
}
