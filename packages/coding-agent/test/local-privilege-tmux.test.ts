import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
const tmuxIt = tmuxAvailable ? it : it.skip;

describe("local privilege tmux fixture", () => {
	it("treats a password prompt as active only while the tmux cursor remains on that line", () => {
		const screen = "[sudo] password for user:\n\n";
		expect(isPrivilegeAuthenticationPrompt(screen, 0)).toBe(true);
		expect(isPrivilegeAuthenticationPrompt(screen, 1)).toBe(false);
	});

	it("does not accept sensitive input when the echo-disable handshake fails", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "beaupi-local-privilege-echo-failure-"));
		cleanup.push(cwd);
		let capture = "";
		const calls: string[][] = [];
		const runner: LocalTmuxTransportRunner = vi.fn(async (args) => {
			calls.push([...args]);
			if (args[0] === "display-message") {
				return {
					stdout: "%1__BEAUPI_TMUX_FIELD__bash__BEAUPI_TMUX_FIELD__0__BEAUPI_TMUX_FIELD__0__BEAUPI_TMUX_FIELD__\n",
					stderr: "",
					exitCode: 0,
					startedAt: 1,
					completedAt: 2,
				};
			}
			if (args[0] === "send-keys" && args.includes("-l")) {
				const literal = args.at(-1) ?? "";
				const begin = literal.match(/__BEAUPI_PRIV_BEGIN_[A-Za-z0-9]+__/)?.[0] ?? "";
				const end = literal.match(/__BEAUPI_PRIV_END_[A-Za-z0-9]+__/)?.[0] ?? "";
				capture = `\n${begin}\nUnable to disable terminal echo\n${end}:125\n`;
			}
			return {
				stdout: args[0] === "capture-pane" ? capture : "",
				stderr: "",
				exitCode: 0,
				startedAt: 1,
				completedAt: 2,
			};
		});
		const adapter = new TmuxPrivilegeTerminalAdapter({ transport: new LocalTmuxTransport({ runner }) });
		const session = await adapter.create({
			version: 1,
			requestId: "local-echo-failure",
			auditId: "audit-local-echo-failure",
			toolCallId: "tool-local-echo-failure",
			sourceTool: "privileged_exec",
			route: "explicit_tool",
			command: "sudo id",
			target: { execution: "local" },
			cwd,
			createdAt: new Date(0).toISOString(),
			logPath: join(cwd, "logs", "privilege.log"),
		});

		await expect(session.start()).rejects.toThrow("echo could not be disabled");
		await expect(session.sendSensitive(Buffer.from("M13-never-send"))).rejects.toThrow("not accepting input");
		expect(calls.some((args) => args[0] === "load-buffer")).toBe(false);
	});

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
				command: "printf 'Password: '; IFS= read -r answer; printf '\\naccepted\\n'; sleep 1",
				target: { execution: "local" },
				cwd,
				timeoutMs: 5_000,
				createdAt: new Date(0).toISOString(),
				logPath,
			};
			const adapter = new TmuxPrivilegeTerminalAdapter();
			const session = await adapter.create(request);
			try {
				await session.start();
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
		15_000,
	);
});
