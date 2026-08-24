import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import { controlPathFor, shellQuote, targetArgs } from "../remote/openssh-runner.ts";
import type { ExecutionTargetConfig, RemoteCommandOptions, RemoteCommandResult } from "../remote/types.ts";
import { RemoteExecutionError } from "../remote/types.ts";

export interface RemoteAgentTransport {
	readonly stdin: Writable;
	readonly stdout: Readable;
	readonly stderr: Readable;
	readonly pid?: number;
	close(): Promise<void>;
}

function safeDiagnostic(value: string): string {
	return value
		.replace(/[\r\n\t]+/g, " ")
		.trim()
		.slice(0, 500);
}

function killChild(child: ChildProcess): void {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	setTimeout(() => {
		if (child.exitCode === null) child.kill("SIGKILL");
	}, 1_000).unref();
}

export class OpenSshCommandRunner {
	readonly target: ExecutionTargetConfig;
	readonly controlPath: string;

	constructor(target: ExecutionTargetConfig, controlPath = controlPathFor(target)) {
		this.target = target;
		this.controlPath = controlPath;
	}

	async run(command: string, options: RemoteCommandOptions & { stdin?: Buffer } = {}): Promise<RemoteCommandResult> {
		const startedAt = Date.now();
		if (options.signal?.aborted)
			throw new RemoteExecutionError({
				code: "remote_cancelled",
				message: "Remote SSH operation was cancelled",
				executionState: "not_started",
			});
		const args = [...targetArgs(this.target, this.controlPath), command];
		const child = spawnProcess("ssh", args, {
			stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let cancelled = false;
		let timedOut = false;
		let timer: NodeJS.Timeout | undefined;
		const onAbort = (): void => {
			cancelled = true;
			killChild(child);
		};
		child.stdout?.on("data", (data: Buffer) => {
			stdout += data.toString("utf8");
			options.onData?.(data);
		});
		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString("utf8");
			options.onData?.(data);
		});
		child.stdin?.on("error", () => undefined);
		if (options.stdin) child.stdin?.end(options.stdin);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.timeoutMs !== undefined) {
			timer = setTimeout(
				() => {
					timedOut = true;
					killChild(child);
				},
				Math.max(1, Math.floor(options.timeoutMs)),
			);
		}
		try {
			const exitCode = await waitForChildProcess(child);
			if (cancelled)
				throw new RemoteExecutionError({
					code: "remote_cancelled",
					message: "Remote SSH operation was cancelled",
					executionState: "not_started",
				});
			if (timedOut)
				throw new RemoteExecutionError({
					code: "remote_timeout",
					message: "Remote SSH operation timed out",
					retryable: true,
					executionState: "not_started",
				});
			return { stdout, stderr, exitCode, startedAt, completedAt: Date.now() };
		} catch (error) {
			if (error instanceof RemoteExecutionError) throw error;
			throw new RemoteExecutionError({
				code: "ssh_connection",
				message: safeDiagnostic(error instanceof Error ? error.message : String(error)),
				retryable: true,
				executionState: "not_started",
			});
		} finally {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		}
	}

	async connectAgent(remoteCommand: string, signal?: AbortSignal): Promise<RemoteAgentTransport> {
		if (signal?.aborted)
			throw new RemoteExecutionError({
				code: "remote_cancelled",
				message: "Remote Agent connection was cancelled",
				executionState: "not_started",
			});
		await mkdir(dirname(this.controlPath), { recursive: true, mode: 0o700 });
		const args = targetArgs(this.target, this.controlPath);
		args.splice(args.length - 1, 0, "-T");
		args.push(remoteCommand);
		const child = spawnProcess("ssh", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		let settled = false;
		const onAbort = (): void => {
			if (!settled) killChild(child);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdin?.on("error", () => undefined);
		const transport: RemoteAgentTransport = {
			stdin: child.stdin as Writable,
			stdout: child.stdout as Readable,
			stderr: child.stderr as Readable,
			pid: child.pid,
			close: async () => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				if (child.stdin && !child.stdin.destroyed) child.stdin.end();
				killChild(child);
				await new Promise<void>((resolve) => {
					if (child.exitCode !== null) {
						resolve();
						return;
					}
					child.once("close", () => resolve());
					setTimeout(resolve, 1_500).unref();
				});
			},
		};
		child.once("close", () => {
			settled = true;
			signal?.removeEventListener("abort", onAbort);
		});
		return transport;
	}
}

export function agentLaunchCommand(agentPath: string, artifactSha256: string, agentVersion: string): string {
	return [
		"exec node",
		shellQuote(agentPath),
		"--stdio",
		"--artifact-sha256",
		shellQuote(artifactSha256),
		"--agent-version",
		shellQuote(agentVersion),
	].join(" ");
}
