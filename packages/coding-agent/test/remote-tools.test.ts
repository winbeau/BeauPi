import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionContext, ToolRenderContext } from "../src/core/extensions/types.ts";
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
import { stripAnsi } from "../src/utils/ansi.ts";

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
		expect(call?.render(160).join("\n")).not.toContain("[fake]");
		expect(call?.render(160).join("\n")).toContain("printf tool-ok");
		const explicitCall = setup.definitions.remote_exec.renderCall?.(
			{ command: "pwd", targetId: "fake-two" } as never,
			theme,
			context,
		);
		const explicitCallText = stripAnsi(explicitCall?.render(160).join("\n") ?? "");
		expect(explicitCallText).toContain("Remote Exec(pwd)");
		expect(explicitCallText).not.toContain("[fake-two]");
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

	it("renders SSH and tmux calls on one line and bounds output previews", async () => {
		const setup = await createSetup();
		await execute(setup.definitions.target_select, { targetId: "fake" });
		const command = `printf first\nprintf '${"long-command-segment ".repeat(12)}'\nprintf last`;
		const output = Array.from({ length: 15 }, (_, index) => `output line ${index + 1}`).join("\n");
		setup.adapter.setCommandResult(`cd '/workspace' && ${command}`, { stdout: output, exitCode: 0 });
		const result = await execute(setup.definitions.remote_exec, { command });
		const context = {
			args: { command },
			toolCallId: "m7-render-compact",
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
		} satisfies ToolRenderContext<Record<string, never>, { command: string }>;

		const call = setup.definitions.remote_exec.renderCall?.({ command } as never, theme, context);
		const callLines = call?.render(72) ?? [];
		expect(callLines).toHaveLength(1);
		expect(visibleWidth(callLines[0] ?? "")).toBeLessThanOrEqual(72);
		const callText = stripAnsi(callLines[0] ?? "");
		expect(callText).toMatch(/^Remote Exec\(/);
		expect(callText).toContain("…)");
		expect(callText).not.toContain("[fake]");
		expect(callText).not.toContain("\n");

		const rendered = setup.definitions.remote_exec.renderResult?.(
			result as never,
			{ expanded: false, isPartial: false },
			theme,
			context,
		);
		const previewLines = rendered?.render(100) ?? [];
		const previewText = stripAnsi(previewLines.join("\n"));
		expect(previewLines).toHaveLength(11);
		expect(previewText).toContain("output line 10");
		expect(previewText).not.toContain("output line 11");
		expect(previewText).toContain("5 more lines, 15 total");

		const expanded = setup.definitions.remote_exec.renderResult?.(
			result as never,
			{ expanded: true, isPartial: false },
			theme,
			{ ...context, expanded: true, lastComponent: rendered } as never,
		);
		expect(stripAnsi(expanded?.render(100).join("\n") ?? "")).toContain("output line 15");

		const terminalCreateCall = setup.definitions.terminal_create.renderCall?.(
			{ terminalId: "build", command } as never,
			theme,
			context,
		);
		expect(terminalCreateCall?.render(64)).toHaveLength(1);
		expect(stripAnsi(terminalCreateCall?.render(64)[0] ?? "")).toContain("Terminal Create(");

		const terminalSendCall = setup.definitions.terminal_send.renderCall?.(
			{ terminalId: "build", input: "echo ready\n" } as never,
			theme,
			context,
		);
		expect(terminalSendCall?.render(64)).toHaveLength(1);
		expect(stripAnsi(terminalSendCall?.render(64)[0] ?? "")).toContain("echo ready\\n");

		await execute(setup.definitions.terminal_create, { terminalId: "capture-preview" });
		await execute(setup.definitions.terminal_send, { terminalId: "capture-preview", input: output });
		const capture = await execute(setup.definitions.terminal_capture, { terminalId: "capture-preview" });
		const captureRendered = setup.definitions.terminal_capture.renderResult?.(
			capture as never,
			{ expanded: false, isPartial: false },
			theme,
			{ ...context, args: { terminalId: "capture-preview" } } as never,
		);
		const capturePreview = stripAnsi(captureRendered?.render(100).join("\n") ?? "");
		expect(capturePreview).toContain("output line 10");
		expect(capturePreview).not.toContain("output line 11");
		expect(capturePreview).toContain("5 more lines, 15 total");

		const remoteBashCall = setup.definitions.remote_bash.renderCall?.({ command } as never, theme, context);
		expect(remoteBashCall?.render(64)).toHaveLength(1);
		expect(stripAnsi(remoteBashCall?.render(64)[0] ?? "")).toContain("Remote Bash(");
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
