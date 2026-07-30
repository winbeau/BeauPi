import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

const cleanup: string[] = [];
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
		sessionTargets: [{ id: "fake", scope: "session", sshAlias: "fake-alias", remoteCwd: "/workspace" }],
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

	it("keeps remote command failure structured and exposes operation adapters", async () => {
		const setup = await createSetup();
		await execute(setup.definitions.target_select, { targetId: "fake" });
		setup.adapter.setCommandResult("false", { stderr: "failed\n", exitCode: 4 });
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
		setup.adapter.setCommandResult("cat -- '/workspace/hello.txt'", { stdout: "hello\n", exitCode: 0 });
		await expect(read.access(join(setup.cwd, "hello.txt"))).resolves.toBeUndefined();
	});
});
