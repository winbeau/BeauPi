import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { MonitorRuntime } from "../src/core/monitor/index.ts";
import {
	type PrivilegeAuditEventV1,
	type PrivilegeAuditWriter,
	PrivilegeRuntime,
	TmuxPrivilegeTerminalAdapter,
} from "../src/core/privilege/index.ts";
import {
	createRemoteToolDefinitions,
	ExecutionTargetRegistry,
	FakeSshTmuxAdapter,
	RemoteExecutionRuntime,
} from "../src/core/remote/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

class Audit implements PrivilegeAuditWriter {
	readonly events: PrivilegeAuditEventV1[] = [];
	pathFor(): string {
		return "/tmp/m13-remote-audit.jsonl";
	}
	async append(event: PrivilegeAuditEventV1): Promise<void> {
		this.events.push(structuredClone(event));
	}
}

const cleanup: string[] = [];
afterEach(() => {
	for (const path of cleanup.splice(0)) if (existsSync(path)) rmSync(path, { recursive: true, force: true });
});

function setup(user?: string) {
	const cwd = join(tmpdir(), `beaupi-remote-privilege-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(cwd, { recursive: true });
	cleanup.push(cwd);
	const sessionManager = SessionManager.inMemory(cwd);
	const settingsManager = SettingsManager.inMemory();
	const adapter = new FakeSshTmuxAdapter();
	const monitorRuntime = new MonitorRuntime({ sessionId: sessionManager.getSessionId(), cwd, sessionManager });
	const remoteRuntime = new RemoteExecutionRuntime({
		cwd,
		sessionId: sessionManager.getSessionId(),
		sessionManager,
		settingsManager,
		monitorRuntime,
		targets: new ExecutionTargetRegistry({
			settingsManager,
			sessionTargets: [{ id: "fake", scope: "session", sshAlias: "fake", remoteCwd: "/workspace", user }],
		}),
		adapter,
	});
	remoteRuntime.selectTarget("fake");
	const audit = new Audit();
	const privilegeRuntime = new PrivilegeRuntime({
		sessionId: sessionManager.getSessionId(),
		cwd,
		terminalAdapter: new TmuxPrivilegeTerminalAdapter({ remoteHost: remoteRuntime }),
		auditWriter: audit,
		isRootTarget: (targetId) => remoteRuntime.isRootTarget(targetId),
	});
	return { cwd, adapter, audit, monitorRuntime, remoteRuntime, privilegeRuntime };
}

describe("remote controlled privilege terminal", () => {
	it("uses the existing SSH tmux pane without leaking sensitive input", async () => {
		const fixture = setup();
		const terminal = await fixture.remoteRuntime.terminalCreate({ terminalId: "privileged-terminal" });
		const secret = Buffer.from("M13-remote-secret-fixture\r", "utf8");
		fixture.adapter.setPrivilegeCommandResult(terminal.terminalId, { output: "uid=0(root)\n", exitCode: 0 });
		fixture.privilegeRuntime.setHandler(async (_request, control) => {
			await control.start();
			expect(await control.capture()).toMatchObject({ state: "waiting_for_user" });
			await control.execute();
			expect(await control.capture()).toMatchObject({ state: "authenticating" });
			await control.sendSensitive(secret);
			await control.wait();
			return { status: "completed" };
		});

		const updates: string[] = [];
		const result = await fixture.privilegeRuntime.execute(
			{
				toolCallId: "remote-sudo",
				sourceTool: "terminal_bash",
				route: "terminal_bash",
				command: "sudo id",
				target: {
					execution: "terminal",
					targetId: "fake",
					terminalId: terminal.terminalId,
					monitorId: terminal.monitorId,
				},
				cwd: fixture.cwd,
			},
			undefined,
			(update) => {
				const content = update.content[0];
				if (content?.type === "text" && update.details.status === "running") updates.push(content.text);
			},
		);

		expect(result.details).toMatchObject({ status: "succeeded", exitCode: 0, monitorId: terminal.monitorId });
		expect(updates.some((output) => output.includes("uid=0(root)"))).toBe(true);
		expect(fixture.adapter.getSensitiveInputForTest()).toEqual(secret);
		expect(readFileSync(terminal.logPath, "utf8")).toContain("uid=0(root)");
		const serialized = JSON.stringify({
			result,
			audit: fixture.audit.events,
			monitor: fixture.monitorRuntime.list(),
		});
		expect(serialized).not.toContain(secret.toString("utf8").trim());
		expect(readFileSync(terminal.logPath, "utf8")).not.toContain(secret.toString("utf8").trim());
	});

	it("blocks interactive root shells before opening a privilege command session", async () => {
		const fixture = setup();
		const terminal = await fixture.remoteRuntime.terminalCreate({ terminalId: "interactive-root-blocked" });
		const handler = vi.fn();
		fixture.privilegeRuntime.setHandler(handler);

		const result = await fixture.privilegeRuntime.execute({
			toolCallId: "remote-interactive-blocked",
			sourceTool: "privileged_exec",
			route: "explicit_tool",
			command: "sudo bash",
			target: { execution: "terminal", targetId: "fake", terminalId: terminal.terminalId },
			cwd: fixture.cwd,
		});

		expect(result.details).toMatchObject({
			status: "blocked",
			diagnostic: { code: "unsupported_privilege" },
		});
		expect(handler).not.toHaveBeenCalled();
	});

	it("routes terminal_bash sudo before the ordinary terminal executor", async () => {
		const fixture = setup();
		const terminal = await fixture.remoteRuntime.terminalCreate({ terminalId: "routed-terminal" });
		fixture.adapter.setPrivilegeCommandResult(terminal.terminalId, { prompt: false, output: "routed\n" });
		fixture.privilegeRuntime.setHandler(async (_request, control) => {
			await control.start();
			await control.execute();
			await control.wait();
			return { status: "completed" };
		});
		const tool = createRemoteToolDefinitions(fixture.remoteRuntime, fixture.privilegeRuntime).find(
			(definition) => definition.name === "terminal_bash",
		);
		expect(tool).toBeDefined();
		const result = await tool!.execute(
			"terminal-bash-sudo",
			{ terminalId: terminal.terminalId, command: "sudo id" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(result.details).toMatchObject({ status: "succeeded", route: "terminal_bash" });
		expect(fixture.adapter.terminalCommandCalls).toEqual([]);
	});

	it("requires confirmation again when the remote sudo credential is cached", async () => {
		const fixture = setup();
		const terminal = await fixture.remoteRuntime.terminalCreate({ terminalId: "cached-terminal" });
		fixture.adapter.setPrivilegeCommandResult(terminal.terminalId, { prompt: false, output: "cached\n" });
		let confirmations = 0;
		fixture.privilegeRuntime.setHandler(async (_request, control) => {
			confirmations++;
			await control.start();
			await control.execute();
			await control.wait();
			return { status: "completed" };
		});
		for (const toolCallId of ["cached-1", "cached-2"]) {
			fixture.adapter.setPrivilegeCommandResult(terminal.terminalId, { prompt: false, output: "cached\n" });
			await fixture.privilegeRuntime.execute({
				toolCallId,
				sourceTool: "privileged_exec",
				route: "explicit_tool",
				command: "sudo true",
				target: { execution: "terminal", targetId: "fake", terminalId: terminal.terminalId },
				cwd: fixture.cwd,
			});
		}
		expect(confirmations).toBe(2);
		expect(fixture.adapter.getSensitiveInputForTest()).toHaveLength(0);
	});

	it("blocks redundant sudo for a configured root login before pane input", async () => {
		const fixture = setup("root");
		const terminal = await fixture.remoteRuntime.terminalCreate({ terminalId: "root-terminal" });
		const result = await fixture.privilegeRuntime.execute({
			toolCallId: "root-sudo",
			sourceTool: "privileged_exec",
			route: "explicit_tool",
			command: "sudo id",
			target: { execution: "terminal", targetId: "fake", terminalId: terminal.terminalId },
			cwd: fixture.cwd,
		});
		expect(result.details).toMatchObject({ status: "blocked", diagnostic: { code: "redundant_privilege" } });
		expect(fixture.adapter.getSensitiveInputForTest()).toHaveLength(0);
	});
});
