import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { MonitorRuntime } from "../src/core/monitor/index.ts";
import {
	ExecutionTargetRegistry,
	FakeSshTmuxAdapter,
	RemoteExecutionError,
	RemoteExecutionRuntime,
	validateExecutionTarget,
} from "../src/core/remote/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createHarness } from "./test-harness.ts";

class Clock {
	value = 1_000;
	now = (): number => this.value;
	advance(milliseconds: number): void {
		this.value += milliseconds;
	}
}

const cleanup: string[] = [];
afterEach(() => {
	for (const path of cleanup.splice(0)) {
		if (existsSync(path)) rmSync(path, { recursive: true, force: true });
	}
});

function createSetup(options: { projectTrusted?: boolean; remoteCwd?: string | false; targetUser?: string } = {}) {
	const cwd = join(tmpdir(), `beaupi-remote-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(cwd, { recursive: true });
	cleanup.push(cwd);
	const sessionManager = SessionManager.inMemory(cwd);
	const settingsManager = SettingsManager.inMemory({}, { projectTrusted: options.projectTrusted ?? true });
	const remoteCwd = options.remoteCwd === false ? undefined : (options.remoteCwd ?? "/workspace");
	const target = {
		id: "fake",
		label: "Fake target",
		scope: "session" as const,
		sshAlias: "fake-alias",
		...(options.targetUser ? { user: options.targetUser } : {}),
		...(remoteCwd ? { remoteCwd } : {}),
	};
	const targets = new ExecutionTargetRegistry({ settingsManager, sessionTargets: [target] });
	const adapter = new FakeSshTmuxAdapter();
	const clock = new Clock();
	const monitor = new MonitorRuntime({
		sessionId: sessionManager.getSessionId(),
		cwd,
		sessionManager,
		now: clock.now,
		stallTimeoutMs: 10_000,
	});
	const runtime = new RemoteExecutionRuntime({
		cwd,
		sessionId: sessionManager.getSessionId(),
		sessionManager,
		settingsManager,
		monitorRuntime: monitor,
		targets,
		adapter,
		now: clock.now,
	});
	return { cwd, sessionManager, settingsManager, target, targets, adapter, clock, monitor, runtime };
}

describe("M7 execution targets", () => {
	it("keeps user and project target scopes separate and gates project selection on trust", () => {
		const settings = SettingsManager.inMemory({
			executionTargets: [{ id: "user-target", scope: "user", sshAlias: "user-alias" }],
		});
		settings.setProjectExecutionTargets([{ id: "project-target", scope: "project", sshAlias: "project-alias" }]);
		const registry = new ExecutionTargetRegistry({ settingsManager: settings });
		expect(registry.list().map((target) => target.id)).toEqual(["project-target", "user-target"]);
		registry.select("project-target");
		settings.setProjectTrusted(false);
		expect(registry.list().map((target) => target.id)).toEqual(["user-target"]);
		expect(() => registry.assertSelected("project-target")).toThrow(/trusted/);
	});

	it("validates target scope, alias, ports, and remote cwd without accepting shell text", () => {
		expect(
			validateExecutionTarget({ id: "a", scope: "session", sshAlias: "h100-server", remoteCwd: "/workspace" }).ok,
		).toBe(true);
		expect(
			validateExecutionTarget({ id: "a", scope: "session", sshAlias: "h100-server", remoteCwd: "projects/pi" }).ok,
		).toBe(true);
		expect(validateExecutionTarget({ id: "a", scope: "session", sshAlias: "ssh h100-server" }).ok).toBe(false);
		expect(validateExecutionTarget({ id: "a", scope: "project", sshAlias: "host", port: 0 }).ok).toBe(false);
		expect(validateExecutionTarget({ id: "a", scope: "project", sshAlias: "host", remoteCwd: "/tmp;rm" }).ok).toBe(
			false,
		);
	});

	it("rejects remote execution before target selection and records only the selected id", async () => {
		const setup = createSetup();
		await expect(setup.runtime.remoteExec("printf ok")).rejects.toMatchObject({
			diagnostic: { code: "target_not_selected" },
		});
		setup.runtime.selectTarget("fake");
		await expect(setup.runtime.remoteExec("sudo id")).rejects.toMatchObject({
			diagnostic: { code: "remote_command" },
		});
		await expect(setup.runtime.remoteExec("printf ok")).resolves.toMatchObject({ exitCode: 0 });
		const entries = setup.sessionManager.getBranch();
		expect(JSON.stringify(entries)).not.toContain("fake-alias");
		expect(JSON.stringify(entries)).toContain('"targetId":"fake"');
	});

	it("allows provider-managed root login targets without allowing identity changes after login", async () => {
		const setup = createSetup({ targetUser: "root" });
		expect(validateExecutionTarget(setup.target).ok).toBe(true);
		expect(setup.runtime.selectTarget("fake").user).toBe("root");
		await expect(setup.runtime.remoteExec("id -u")).resolves.toMatchObject({ exitCode: 0 });
		await expect(setup.runtime.terminalCreate({ terminalId: "root-login-terminal" })).resolves.toMatchObject({
			status: "running",
			targetId: "fake",
		});
		await expect(setup.runtime.remoteExec("su - app")).rejects.toMatchObject({
			diagnostic: { code: "remote_command" },
		});
	});

	it("uses the configured remote workspace and leaves commands unchanged when none is set", async () => {
		const workspace = createSetup();
		workspace.runtime.selectTarget("fake");
		await workspace.runtime.remoteExec("pwd");
		expect(workspace.adapter.commandCalls).toContain("cd '/workspace' && pwd");

		const relativeWorkspace = createSetup({ remoteCwd: "projects/pi" });
		relativeWorkspace.runtime.selectTarget("fake");
		await relativeWorkspace.runtime.createReadOperations().access(join(relativeWorkspace.cwd, "src/index.ts"));
		expect(relativeWorkspace.adapter.commandCalls).toContain("cd 'projects/pi' && test -r -- 'src/index.ts'");

		const home = createSetup({ remoteCwd: false });
		home.runtime.selectTarget("fake");
		await home.runtime.remoteExec("pwd");
		expect(home.adapter.commandCalls).toContain("pwd");
		expect(home.adapter.commandCalls).not.toContain("cd '.' && pwd");
	});

	it("keeps separate reusable connections for multiple explicitly addressed targets", async () => {
		const setup = createSetup();
		setup.runtime.addSessionTarget({
			id: "fake-two",
			scope: "session",
			sshAlias: "fake-two-alias",
			remoteCwd: "/srv/project",
		});
		const second = await setup.runtime.remoteExec("pwd", { targetId: "fake-two" });
		expect(second.connectedTargetId).toBe("fake-two");
		expect(setup.runtime.selectedTarget).toBeUndefined();
		expect(setup.adapter.commandCalls).toContain("cd '/srv/project' && pwd");

		setup.runtime.selectTarget("fake");
		await setup.runtime.remoteExec("pwd");
		await setup.runtime.remoteExec("pwd", { targetId: "fake-two" });
		expect(setup.adapter.connectCalls).toBe(2);
		expect(setup.runtime.selectedTarget?.id).toBe("fake");
	});

	it("reuses a fake SSH connection and maps successful and failed exit codes into Monitor", async () => {
		const setup = createSetup();
		setup.runtime.selectTarget("fake");
		const success = await setup.runtime.remoteExec("printf success");
		expect(success.exitCode).toBe(0);
		expect(success.stdout).toBe("ok\n");
		expect(setup.adapter.commandCalls).toContain("cd '/workspace' && printf success");
		expect(setup.monitor.status(success.monitorId)).toMatchObject({ status: "completed", exitCode: 0 });
		const connectionMonitor = setup.monitor.list({ kind: "ssh-tmux", status: "healthy" })[0];
		expect(connectionMonitor?.target).toMatchObject({ kind: "ssh-tmux", resource: "connection", targetId: "fake" });
		setup.adapter.setCommandResult("cd '/workspace' && false", { stdout: "nope\n", exitCode: 7 });
		const failed = await setup.runtime.remoteExec("false");
		expect(failed.exitCode).toBe(7);
		expect(failed.diagnostic?.code).toBe("remote_command");
		expect(setup.monitor.status(failed.monitorId)).toMatchObject({ status: "failed", exitCode: 7 });
		await setup.runtime.remoteExec("printf second");
		expect(setup.adapter.connectCalls).toBe(1);
		await setup.runtime.close();
		expect(setup.adapter.closeCalls).toBe(1);
		expect(
			setup.monitor
				.list({ kind: "ssh-tmux", status: "completed" })
				.some((record) => record.target.kind === "ssh-tmux" && record.target.resource === "connection"),
		).toBe(true);
		await setup.runtime.remoteExec("printf after-close");
		expect(setup.adapter.connectCalls).toBe(2);
		setup.adapter.setCommandResult("cd '/workspace' && slow", { delayMs: 30 });
		await expect(setup.runtime.remoteExec("slow", { timeoutMs: 1 })).rejects.toMatchObject({
			diagnostic: { code: "remote_timeout" },
		});
	});

	it("maps cancellation and connection diagnostics without exposing adapter credentials", async () => {
		const setup = createSetup();
		setup.runtime.selectTarget("fake");
		const controller = new AbortController();
		controller.abort();
		await expect(setup.runtime.remoteExec("sleep 10", { signal: controller.signal })).rejects.toMatchObject({
			diagnostic: { code: "remote_cancelled" },
		});
		setup.adapter.failConnect = new RemoteExecutionError({
			code: "ssh_host_key",
			message: "host key verification failed",
		});
		await expect(setup.runtime.close()).resolves.toBeUndefined();
		const fresh = createSetup();
		fresh.runtime.selectTarget("fake");
		fresh.adapter.failConnect = new RemoteExecutionError({
			code: "ssh_authentication",
			message: "permission denied",
		});
		await expect(fresh.runtime.remoteExec("true")).rejects.toMatchObject({
			diagnostic: { code: "ssh_authentication" },
		});
		const hostKey = createSetup();
		hostKey.runtime.selectTarget("fake");
		hostKey.adapter.failConnect = new RemoteExecutionError({
			code: "ssh_host_key",
			message: "host key verification failed",
		});
		await expect(hostKey.runtime.remoteExec("true")).rejects.toMatchObject({ diagnostic: { code: "ssh_host_key" } });
		const state = JSON.stringify(fresh.sessionManager.getBranch());
		expect(state).not.toMatch(/private key|passphrase|password|token/i);
	});
});

describe("M7 faux-provider integration", () => {
	it("runs the fake SSH adapter from a faux-provider Tool call", async () => {
		const setup = createSetup();
		setup.runtime.selectTarget("fake");
		const tool: AgentTool = {
			name: "fake_remote_exec",
			label: "fake_remote_exec",
			description: "Run the deterministic fake remote command",
			parameters: Type.Object({}),
			execute: async () => {
				const result = await setup.runtime.remoteExec("printf faux");
				return { content: [{ type: "text", text: result.stdout }], details: result };
			},
		};
		const harness = await createHarness({
			baseToolsOverride: { fake_remote_exec: tool },
			responses: [{ toolCalls: [{ name: "fake_remote_exec", args: {} }], stopReason: "toolUse" }, "done"],
		});
		try {
			await harness.session.prompt("run the fake remote command");
			expect(setup.adapter.connectCalls).toBe(1);
			expect(harness.faux.callCount).toBe(2);
		} finally {
			harness.cleanup();
		}
	});
});

describe("M7 fake tmux lifecycle", () => {
	it("creates, sends, captures incrementally, reports status, closes, and marks loss", async () => {
		const setup = createSetup();
		setup.runtime.selectTarget("fake");
		const created = await setup.runtime.terminalCreate({ terminalId: "test-terminal" });
		expect(setup.adapter.tmuxCreateCalls[0]?.cwd).toBe("/workspace");
		expect(setup.monitor.status(created.monitorId).status).toBe("healthy");
		const first = await setup.runtime.terminalCapture(created.terminalId);
		expect(first.content).toBe("");
		await setup.runtime.terminalSend(created.terminalId, "one\n");
		const second = await setup.runtime.terminalCapture(created.terminalId);
		expect(second.content).toBe("one\n");
		const unchanged = await setup.runtime.terminalCapture(created.terminalId);
		expect(unchanged.content).toBe("");
		expect(unchanged.changed).toBe(false);
		expect(readFileSync(created.logPath, "utf8")).toBe("one\n");
		const status = await setup.runtime.terminalStatus(created.terminalId);
		expect(status).toMatchObject({ exists: true, status: "healthy" });
		const closed = await setup.runtime.terminalClose(created.terminalId);
		expect(closed.status).toBe("completed");
		const lostSetup = createSetup();
		lostSetup.runtime.selectTarget("fake");
		const lostTerminal = await lostSetup.runtime.terminalCreate({ terminalId: "lost-terminal" });
		lostSetup.adapter.closeFakeTerminal(lostTerminal.terminalId);
		const lost = await lostSetup.runtime.terminalStatus(lostTerminal.terminalId);
		expect(lost.status).toBe("lost");
	});

	it("executes Bash-like commands through an interactive terminal and consumes their captured output", async () => {
		const setup = createSetup();
		setup.runtime.selectTarget("fake");
		const created = await setup.runtime.terminalCreate({ terminalId: "bash-terminal" });
		setup.adapter.setTerminalCommandResult(created.terminalId, "printf terminal-ok", {
			stdout: "terminal-ok\n",
			exitCode: 0,
		});
		const result = await setup.runtime.terminalBash(created.terminalId, "printf terminal-ok");
		expect(result).toMatchObject({
			terminalId: created.terminalId,
			monitorId: created.monitorId,
			command: "printf terminal-ok",
			stdout: "terminal-ok\n",
			stderr: "",
			exitCode: 0,
		});
		expect(setup.adapter.terminalCommandCalls).toEqual([
			{ terminalId: created.terminalId, command: "printf terminal-ok" },
		]);
		expect(readFileSync(created.logPath, "utf8")).toBe("terminal-ok\n");
		const capture = await setup.runtime.terminalCapture(created.terminalId);
		expect(capture.content).toBe("");
	});

	it("rejects terminal Bash on fixed-command or busy terminals and maps timeout and cancellation", async () => {
		const fixed = createSetup();
		fixed.runtime.selectTarget("fake");
		const fixedTerminal = await fixed.runtime.terminalCreate({ terminalId: "fixed-terminal", command: "sleep 30" });
		await expect(fixed.runtime.terminalBash(fixedTerminal.terminalId, "pwd")).rejects.toMatchObject({
			diagnostic: { code: "terminal_busy" },
		});

		const setup = createSetup();
		setup.runtime.selectTarget("fake");
		const created = await setup.runtime.terminalCreate({ terminalId: "slow-terminal" });
		setup.adapter.setTerminalCommandResult(created.terminalId, "sleep 30", { delayMs: 50 });
		const running = setup.runtime.terminalBash(created.terminalId, "sleep 30");
		await new Promise((resolve) => setTimeout(resolve, 0));
		await expect(setup.runtime.terminalSend(created.terminalId, "echo overlap\n")).rejects.toMatchObject({
			diagnostic: { code: "terminal_busy" },
		});
		await expect(running).resolves.toMatchObject({ exitCode: 0 });

		setup.adapter.setTerminalCommandResult(created.terminalId, "sleep timeout", { delayMs: 50 });
		await expect(
			setup.runtime.terminalBash(created.terminalId, "sleep timeout", { timeoutMs: 1 }),
		).rejects.toMatchObject({ diagnostic: { code: "remote_timeout" } });

		setup.adapter.setTerminalCommandResult(created.terminalId, "sleep cancel", { delayMs: 50 });
		const controller = new AbortController();
		const cancelled = setup.runtime.terminalBash(created.terminalId, "sleep cancel", { signal: controller.signal });
		controller.abort();
		await expect(cancelled).rejects.toMatchObject({ diagnostic: { code: "remote_cancelled" } });
	});

	it("restores an unverifiable remote monitor as lost", async () => {
		const original = createSetup();
		original.runtime.selectTarget("fake");
		const terminal = await original.runtime.terminalCreate({ terminalId: "restore-terminal" });
		const restoredAdapter = new FakeSshTmuxAdapter();
		const restoredMonitor = new MonitorRuntime({
			sessionId: original.sessionManager.getSessionId(),
			cwd: original.cwd,
			sessionManager: original.sessionManager,
			adapters: { "ssh-tmux": restoredAdapter },
			now: original.clock.now,
		});
		await restoredMonitor.initialize();
		expect(restoredMonitor.status(terminal.monitorId).status).toBe("lost");
	});
});
