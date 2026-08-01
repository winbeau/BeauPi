import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isPrivilegeAuthenticationPrompt,
	type PrivilegeRequestV1,
	TmuxPrivilegeTerminalAdapter,
} from "../src/core/privilege/index.ts";
import { LocalTmuxTransport, type LocalTmuxTransportRunner } from "../src/core/terminal/local-tmux-transport.ts";

const cleanup: string[] = [];
afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const zshPath = spawnSync("which", ["zsh"], { encoding: "utf8" }).stdout.trim();
const tmuxIt = tmuxAvailable ? it : it.skip;
const zshTmuxIt = tmuxAvailable && zshPath ? it : it.skip;

describe("local privilege tmux fixture", () => {
	it("treats a password prompt as active only while the tmux cursor remains on that line", () => {
		const screen = "[sudo] password for user:\n\n";
		expect(isPrivilegeAuthenticationPrompt(screen, 0)).toBe(true);
		expect(isPrivilegeAuthenticationPrompt(screen, 1)).toBe(false);
	});

	it("starts the configured user shell with normal tmux environment and stages multiline input", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "beaupi-local-privilege-shell-"));
		cleanup.push(cwd);
		const command = "sudo apt update\nsudo apt install -y example";
		const userShell = process.env.SHELL ?? "/bin/bash";
		let capture = "";
		const calls: string[][] = [];
		const runner: LocalTmuxTransportRunner = vi.fn(async (args) => {
			calls.push([...args]);
			if (args[0] === "display-message") {
				return {
					stdout: "%1__BEAUPI_TMUX_FIELD__zsh__BEAUPI_TMUX_FIELD__2__BEAUPI_TMUX_FIELD__0__BEAUPI_TMUX_FIELD__\n",
					stderr: "",
					exitCode: 0,
					startedAt: 1,
					completedAt: 2,
				};
			}
			if (args[0] === "send-keys" && args.includes("-l")) {
				const literal = args.at(-1) ?? "";
				const stage = literal.match(/__BEAUPI_PRIV_STAGE_[A-Za-z0-9]+__/)?.[0] ?? "";
				capture = `\n${stage}\n$ ${command}`;
			}
			return {
				stdout: args[0] === "capture-pane" ? capture : "",
				stderr: "",
				exitCode: 0,
				startedAt: 1,
				completedAt: 2,
			};
		});
		const adapter = new TmuxPrivilegeTerminalAdapter({
			shellPath: userShell,
			transport: new LocalTmuxTransport({ runner }),
		});
		const session = await adapter.create({
			version: 1,
			requestId: "local-user-shell",
			auditId: "audit-local-user-shell",
			toolCallId: "tool-local-user-shell",
			sourceTool: "privileged_exec",
			route: "explicit_tool",
			command,
			target: { execution: "local" },
			cwd,
			createdAt: new Date(0).toISOString(),
			logPath: join(cwd, "logs", "privilege.log"),
		});

		try {
			await session.start();
			expect(await session.capture()).toMatchObject({ state: "waiting_for_user", content: `$ ${command}` });
			const create = calls.find((args) => args[0] === "new-session");
			expect(create?.at(-1)).toContain(userShell);
			expect(create?.join(" ")).not.toContain("env -i");
			expect(create?.join(" ")).not.toContain("--noprofile");
			expect(create?.join(" ")).not.toContain("--norc");
		} finally {
			await session.dispose();
		}
	});

	zshTmuxIt(
		"waits for normal zsh startup files before staging the command",
		async () => {
			const cwd = mkdtempSync(join(tmpdir(), "beaupi-local-privilege-zsh-"));
			cleanup.push(cwd);
			writeFileSync(join(cwd, ".zshrc"), "sleep 5.2\nexport BEAUPI_ZSH_READY=from-zshrc\n", "utf8");
			const previousZdotdir = process.env.ZDOTDIR;
			process.env.ZDOTDIR = cwd;
			const adapter = new TmuxPrivilegeTerminalAdapter({ shellPath: zshPath });
			const session = await adapter.create({
				version: 1,
				requestId: "local-zsh-startup",
				auditId: "audit-local-zsh-startup",
				toolCallId: "tool-local-zsh-startup",
				sourceTool: "privileged_exec",
				route: "explicit_tool",
				command: "printf 'zsh-ready=%s\\n' \"$BEAUPI_ZSH_READY\"",
				target: { execution: "local" },
				cwd,
				createdAt: new Date(0).toISOString(),
				logPath: join(cwd, "logs", "zsh.log"),
			});
			try {
				await session.start();
				expect(await session.capture()).toMatchObject({ state: "waiting_for_user" });
				await session.execute();
				const result = await session.wait();
				expect(result.output).toContain("zsh-ready=from-zshrc");
			} finally {
				if (previousZdotdir === undefined) delete process.env.ZDOTDIR;
				else process.env.ZDOTDIR = previousZdotdir;
				await session.dispose();
			}
		},
		25_000,
	);

	tmuxIt(
		"keeps a simulated password token out of pane output and the 0600 work log",
		async () => {
			const cwd = mkdtempSync(join(tmpdir(), "beaupi-local-privilege-"));
			cleanup.push(cwd);
			const logPath = join(cwd, "logs", "privilege.log");
			const token = "M13-local-secret-fixture";
			const request: PrivilegeRequestV1 = {
				version: 1,
				requestId: "local-tmux-fixture",
				auditId: "audit-local-tmux-fixture",
				toolCallId: "tool-local-tmux-fixture",
				sourceTool: "privileged_exec",
				route: "explicit_tool",
				command:
					"printf 'Password: '; stty -echo; IFS= read -r answer; stty echo; printf '\\naccepted\\n'; sleep 1",
				target: { execution: "local" },
				cwd,
				timeoutMs: 15_000,
				createdAt: new Date(0).toISOString(),
				logPath,
			};
			const adapter = new TmuxPrivilegeTerminalAdapter();
			const session = await adapter.create(request);
			try {
				await session.start();
				expect(await session.capture()).toMatchObject({
					state: "waiting_for_user",
					content: expect.stringContaining(request.command),
				});
				await session.execute();
				expect(await session.capture()).toMatchObject({ state: "authenticating" });
				await session.sendSensitive(Buffer.from(`${token}\r`, "utf8"));
				expect(await session.capture()).toMatchObject({ state: "running" });
				const result = await session.wait();
				expect(result).toMatchObject({ exitCode: 0 });
				expect(result.output).toContain("accepted");
				expect(result.output).not.toContain(token);
				const workLog = readFileSync(logPath, "utf8");
				expect(workLog).not.toContain(token);
				expect(statSync(logPath).mode & 0o777).toBe(0o600);
			} finally {
				await session.dispose();
			}
		},
		30_000,
	);

	tmuxIt(
		"keeps a multiline interactive shell attached until the user exits",
		async () => {
			const cwd = mkdtempSync(join(tmpdir(), "beaupi-local-privilege-interactive-"));
			cleanup.push(cwd);
			const command = "printf 'batch-one\\n'\nbash --noprofile --norc";
			const request: PrivilegeRequestV1 = {
				version: 1,
				requestId: "local-interactive-shell",
				auditId: "audit-local-interactive-shell",
				toolCallId: "tool-local-interactive-shell",
				sourceTool: "privileged_exec",
				route: "explicit_tool",
				command,
				target: { execution: "local" },
				cwd,
				timeoutMs: 5_000,
				createdAt: new Date(0).toISOString(),
				logPath: join(cwd, "logs", "interactive.log"),
			};
			const adapter = new TmuxPrivilegeTerminalAdapter();
			const session = await adapter.create(request);
			try {
				await session.start();
				expect(await session.capture()).toMatchObject({
					state: "waiting_for_user",
					content: expect.stringContaining(command),
				});
				await session.execute();
				expect(await session.capture()).toMatchObject({ state: "running" });
				await session.sendSensitive(Buffer.from(`printf 'interactive-shell=%s\\n' "$SHELL"\rexit\r`, "utf8"));
				const result = await session.wait();
				expect(result).toMatchObject({ exitCode: 0 });
				expect(result.output).toContain("batch-one");
				expect(result.output).toMatch(/interactive-shell=\S+/);
			} finally {
				await session.dispose();
			}
		},
		15_000,
	);
});
