import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { MonitorRuntime } from "../src/core/monitor/index.ts";
import {
	createRemoteToolDefinitions,
	ExecutionTargetRegistry,
	FakeSshTmuxAdapter,
	RemoteExecutionRuntime,
} from "../src/core/remote/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const cleanup: string[] = [];
beforeAll(() => initTheme(undefined, false));
afterEach(() => {
	for (const path of cleanup.splice(0)) {
		if (existsSync(path)) rmSync(path, { recursive: true, force: true });
	}
});

async function createSetup() {
	const cwd = join(tmpdir(), `beaupi-remote-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(cwd, { recursive: true });
	cleanup.push(cwd);
	const sessionManager = SessionManager.inMemory(cwd);
	const settingsManager = SettingsManager.inMemory();
	const targets = new ExecutionTargetRegistry({
		settingsManager,
		sessionTargets: [
			{ id: "fake", scope: "session", sshAlias: "fake-alias", remoteCwd: "/workspace" },
			{ id: "fake-two", scope: "session", sshAlias: "fake-two-alias", remoteCwd: "/srv/project" },
		],
	});
	const adapter = new FakeSshTmuxAdapter();
	const monitor = new MonitorRuntime({ sessionId: sessionManager.getSessionId(), cwd, sessionManager });
	const runtime = new RemoteExecutionRuntime({
		cwd,
		sessionId: sessionManager.getSessionId(),
		sessionManager,
		settingsManager,
		targets,
		adapter,
		monitorRuntime: monitor,
	});
	const definitions = Object.fromEntries(
		createRemoteToolDefinitions(runtime).map((definition) => [definition.name, definition]),
	);
	return { cwd, adapter, monitor, runtime, definitions };
}

async function execute(definition: ReturnType<typeof createRemoteToolDefinitions>[number], params: unknown) {
	return await definition.execute("m7-tool-call", params as never, undefined, undefined, {} as ExtensionContext);
}

describe("M7 remote tools", () => {
	it("selects a target and returns structured remote_exec and terminal details", async () => {
		const setup = await createSetup();
		const selected = await execute(setup.definitions.target_select, { targetId: "fake" });
		expect(selected.details).toMatchObject({
			operation: "target_select",
			ok: true,
			target: { id: "fake", scope: "session" },
		});
		const executed = await execute(setup.definitions.remote_exec, { command: "printf tool-ok" });
		expect(executed.details).toMatchObject({
			operation: "remote_exec",
			ok: true,
			exitCode: 0,
			target: { id: "fake" },
		});
		const secondTarget = await execute(setup.definitions.remote_exec, {
			command: "pwd",
			targetId: "fake-two",
		});
		expect(secondTarget.details).toMatchObject({
			operation: "remote_exec",
			ok: true,
			target: { id: "fake-two" },
		});
		expect(setup.adapter.commandCalls).toContain("cd '/srv/project' && pwd");
		const terminal = await execute(setup.definitions.terminal_create, { terminalId: "tool-terminal" });
		expect(terminal.details).toMatchObject({ operation: "terminal_create", ok: true, terminalId: "tool-terminal" });
		const capture = await execute(setup.definitions.terminal_capture, { terminalId: "tool-terminal" });
		expect(capture.details).toMatchObject({
			operation: "terminal_capture",
			ok: true,
			terminalId: "tool-terminal",
			cursor: 0,
		});
		const close = await execute(setup.definitions.terminal_close, { terminalId: "tool-terminal" });
		expect(close.details).toMatchObject({ operation: "terminal_close", ok: true, status: "completed" });
	});

	it("uses the standard Tool title style without rendering a Full log hint", async () => {
		const setup = await createSetup();
		await execute(setup.definitions.target_select, { targetId: "fake" });
		setup.adapter.setCommandResult("cd '/workspace' && printf tool-ok", { stdout: "tool-ok", exitCode: 0 });
		const result = await execute(setup.definitions.remote_exec, { command: "printf tool-ok" });
		const context = {
			args: { command: "printf tool-ok" },
			toolCallId: "m7-render",
			invalidate: () => {},
			lastComponent: undefined,
			state: {},
			cwd: setup.cwd,
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: true,
			isError: false,
		} as never;
		const call = setup.definitions.remote_exec.renderCall?.({ command: "printf tool-ok" } as never, theme, context);
		expect(call?.render(160).join("\n")).toContain("Remote Exec");
		expect(call?.render(160).join("\n")).toContain("[fake]");
		expect(call?.render(160).join("\n")).toContain("printf tool-ok");
		const explicitCall = setup.definitions.remote_exec.renderCall?.(
			{ command: "pwd", targetId: "fake-two" } as never,
			theme,
			context,
		);
		expect(explicitCall?.render(160).join("\n")).toContain("[fake-two]");
		const rendered = setup.definitions.remote_exec.renderResult?.(
			result as never,
			{ expanded: false, isPartial: false },
			theme,
			context,
		);
		const lines = rendered?.render(160).join("\n") ?? "";
		expect(lines).toContain("tool-ok");
		expect(lines).not.toContain("Full log:");
	});

	it("keeps remote command failure structured and exposes operation adapters", async () => {
		const setup = await createSetup();
		await execute(setup.definitions.target_select, { targetId: "fake" });
		setup.adapter.setCommandResult("cd '/workspace' && false", { stderr: "failed\n", exitCode: 4 });
		const failed = await execute(setup.definitions.remote_exec, { command: "false" });
		expect(failed.details).toMatchObject({
			operation: "remote_exec",
			ok: false,
			exitCode: 4,
			diagnostic: { code: "remote_command" },
		});
		const bash = setup.definitions.remote_bash;
		expect(bash).toBeDefined();
		const read = setup.runtime.createReadOperations();
		setup.adapter.setCommandResult("cd '/workspace' && cat -- 'hello.txt'", {
			stdout: "hello\n",
			exitCode: 0,
		});
		const path = join(setup.cwd, "hello.txt");
		await expect(read.readFile(path)).resolves.toEqual(Buffer.from("hello\n"));
		await expect(read.access(path)).resolves.toBeUndefined();
		expect(setup.adapter.commandCalls).toContain("cd '/workspace' && test -r -- 'hello.txt'");
	});
});
