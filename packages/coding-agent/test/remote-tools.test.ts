import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
	type TerminalOutputReviewer,
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

async function createSetup(outputReviewer?: TerminalOutputReviewer) {
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
		outputReviewer,
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
	it("allows configured root login identities while prohibiting post-login identity changes", async () => {
		const setup = await createSetup();
		const definitions = Object.values(setup.definitions);
		const guidelines = definitions.flatMap((definition) => definition.promptGuidelines ?? []);
		expect(setup.definitions.remote_exec.description).toContain("configured SSH login identity");
		expect(setup.definitions.terminal_create.description).toContain("configured SSH login identity");
		expect(guidelines).toContain(
			"Use the target's configured OpenSSH login identity; trusted provider-managed targets may legitimately resolve to root.",
		);
		expect(guidelines).toContain(
			"Do not use sudo, su, doas, pkexec, runuser, setpriv, nsenter, chroot, or machinectl to change or switch identities after login.",
		);
		expect(guidelines.some((guideline) => guideline.includes("root shells"))).toBe(false);
	});

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
		setup.adapter.setTerminalCommandResult("tool-terminal", "printf terminal-tool-ok", {
			stdout: "terminal-tool-ok\n",
			exitCode: 0,
		});
		const terminalBash = await execute(setup.definitions.terminal_bash, {
			terminalId: "tool-terminal",
			command: "printf terminal-tool-ok",
		});
		expect(terminalBash.details).toMatchObject({
			operation: "terminal_bash",
			terminalId: "tool-terminal",
			exitCode: 0,
		});
		expect(terminalBash.content[0]).toMatchObject({
			type: "text",
			text: expect.stringMatching(/^terminal-tool-ok\n@.*工作日志\.log$/),
		});
		const capture = await execute(setup.definitions.terminal_capture, { terminalId: "tool-terminal" });
		expect(capture.details).toMatchObject({
			operation: "terminal_capture",
			ok: true,
			terminalId: "tool-terminal",
			cursor: expect.any(Number),
			changed: false,
		});
		const close = await execute(setup.definitions.terminal_close, { terminalId: "tool-terminal" });
		expect(close.details).toMatchObject({ operation: "terminal_close", ok: true, status: "completed" });
	});

	it("runs read, write, and edit through an existing terminal with local-tool rendering parity", async () => {
		const setup = await createSetup();
		await execute(setup.definitions.target_select, { targetId: "fake" });
		const terminal = await execute(setup.definitions.terminal_create, { terminalId: "files" });
		const filePath = "src/example.txt";
		const readOutput = Array.from({ length: 11 }, (_, index) => `line-${String(index + 1).padStart(2, "0")}`).join(
			"\n",
		);
		const readEncoded = Buffer.from(`${readOutput}\n`, "utf8").toString("base64");
		setup.adapter.setTerminalCommandResult("files", "test -r 'src/example.txt'", { exitCode: 0 });
		setup.adapter.setTerminalCommandResult("files", "base64 < 'src/example.txt' | tr -d '\\n'", {
			stdout: readEncoded,
			exitCode: 0,
		});

		const readArgs = { terminalId: "files", path: filePath };
		const readResult = await execute(setup.definitions.terminal_read, readArgs);
		expect(readResult.content[0]).toMatchObject({ type: "text", text: `${readOutput}\n` });
		expect(readResult.details).toMatchObject({ path: filePath });
		expect(setup.adapter.terminalCommandCalls).toContainEqual({
			terminalId: "files",
			command: "base64 < 'src/example.txt' | tr -d '\\n'",
		});
		expect(setup.adapter.commandCalls).not.toContain("cd '/workspace' && base64 < 'src/example.txt' | tr -d '\\n'");
		const limitedRead = await execute(setup.definitions.terminal_read, {
			terminalId: "files",
			path: filePath,
			offset: 2,
			limit: 2,
		});
		expect(limitedRead.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("line-02\nline-03"),
		});
		expect(limitedRead.content[0]).toMatchObject({ text: expect.stringContaining("Use offset=4 to continue") });

		const readContext = {
			args: readArgs,
			toolCallId: "terminal-read-render",
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
		} satisfies ToolRenderContext<Record<string, never>, typeof readArgs>;
		const readCall = setup.definitions.terminal_read.renderCall?.(readArgs as never, theme, readContext);
		expect(stripAnsi(readCall?.render(160).join("\n") ?? "")).toContain("Terminal Read [files](src/example.txt)");
		const readRendered = setup.definitions.terminal_read.renderResult?.(
			readResult as never,
			{ expanded: false, isPartial: false },
			theme,
			readContext,
		);
		const readPreview = stripAnsi(readRendered?.render(120).join("\n") ?? "");
		expect(readPreview).toContain("line-10");
		expect(readPreview).not.toContain("line-11");
		expect(readPreview).toContain("1 more lines");

		const imagePath = "src/pixel.png";
		const imageEncoded =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
		setup.adapter.setTerminalCommandResult("files", "test -r 'src/pixel.png'", { exitCode: 0 });
		setup.adapter.setTerminalCommandResult("files", "base64 < 'src/pixel.png' | tr -d '\\n'", {
			stdout: imageEncoded,
			exitCode: 0,
		});
		const imageResult = await execute(setup.definitions.terminal_read, { terminalId: "files", path: imagePath });
		expect(imageResult.content).toContainEqual(expect.objectContaining({ type: "image", mimeType: "image/png" }));

		const writeContent = "created\n";
		const writeEncoded = Buffer.from(writeContent, "utf8").toString("base64");
		setup.adapter.setTerminalCommandResult("files", "mkdir -p -- 'src'", { exitCode: 0 });
		setup.adapter.setTerminalCommandResult("files", `printf %s '${writeEncoded}' | base64 -d > 'src/example.txt'`, {
			exitCode: 0,
		});
		const writeArgs = { terminalId: "files", path: filePath, content: writeContent };
		const writeResult = await execute(setup.definitions.terminal_write, writeArgs);
		expect(writeResult.details).toMatchObject({
			path: filePath,
			bytesWritten: Buffer.byteLength(writeContent, "utf8"),
		});
		const writeCall = setup.definitions.terminal_write.renderCall?.(writeArgs as never, theme, {
			...readContext,
			args: writeArgs,
		} as never);
		expect(stripAnsi(writeCall?.render(160).join("\n") ?? "")).toContain("Terminal Write [files](src/example.txt)");

		setup.adapter.setTerminalCommandResult("files", "test -w 'src/example.txt'", { exitCode: 0 });
		setup.adapter.setTerminalCommandResult("files", "base64 < 'src/example.txt' | tr -d '\\n'", {
			stdout: Buffer.from("before\n", "utf8").toString("base64"),
			exitCode: 0,
		});
		const editedContent = "after\n";
		const editEncoded = Buffer.from(editedContent, "utf8").toString("base64");
		setup.adapter.setTerminalCommandResult("files", `printf %s '${editEncoded}' | base64 -d > 'src/example.txt'`, {
			exitCode: 0,
		});
		const editArgs = {
			terminalId: "files",
			path: filePath,
			edits: [{ oldText: "before", newText: "after" }],
		};
		const editResult = await execute(setup.definitions.terminal_edit, editArgs);
		expect(editResult.details).toMatchObject({ path: filePath, diff: expect.stringContaining("+1 after") });
		const editContext = {
			...readContext,
			args: editArgs,
			toolCallId: "terminal-edit-render",
			state: {},
		} as never;
		const editCall = setup.definitions.terminal_edit.renderCall?.(editArgs as never, theme, editContext);
		setup.definitions.terminal_edit.renderResult?.(
			editResult as never,
			{ expanded: false, isPartial: false },
			theme,
			editContext,
		);
		const editRendered = stripAnsi(editCall?.render(160).join("\n") ?? "");
		expect(editRendered).toContain("Terminal Update [files](src/example.txt)");
		expect(editRendered).toContain("after");

		const logPath = (terminal.details as { logPath: string }).logPath;
		const workLog = readFileSync(logPath, "utf8");
		expect(workLog).toContain("command=Terminal Read 'src/example.txt'");
		expect(workLog).toContain("command=Terminal Write 'src/example.txt'");
		expect(workLog).not.toContain(readEncoded);
		expect(workLog).not.toContain(imageEncoded);
		expect(workLog).not.toContain(writeEncoded);
		expect(workLog).not.toContain(editEncoded);
	});

	it("keeps absolute Terminal file paths remote instead of canonicalizing them locally", async () => {
		const setup = await createSetup();
		await execute(setup.definitions.target_select, { targetId: "fake" });
		await execute(setup.definitions.terminal_create, { terminalId: "absolute-files" });
		const filePath = "/root/wenbiao_zhao/lingbot-va-attn-generate.py";
		const initialContent = "before\n";
		const initialEncoded = Buffer.from(initialContent, "utf8").toString("base64");
		setup.adapter.setTerminalCommandResult("absolute-files", `test -r '${filePath}'`, { exitCode: 0 });
		setup.adapter.setTerminalCommandResult("absolute-files", `base64 < '${filePath}' | tr -d '\\n'`, {
			stdout: initialEncoded,
			exitCode: 0,
		});
		const readResult = await execute(setup.definitions.terminal_read, {
			terminalId: "absolute-files",
			path: filePath,
		});
		expect(readResult.content[0]).toMatchObject({ type: "text", text: initialContent });
		expect(readResult.details).toMatchObject({ path: filePath });

		const writtenContent = "written\n";
		const writtenEncoded = Buffer.from(writtenContent, "utf8").toString("base64");
		setup.adapter.setTerminalCommandResult("absolute-files", "mkdir -p -- '/root/wenbiao_zhao'", { exitCode: 0 });
		setup.adapter.setTerminalCommandResult(
			"absolute-files",
			`printf %s '${writtenEncoded}' | base64 -d > '${filePath}'`,
			{ exitCode: 0 },
		);
		const writeResult = await execute(setup.definitions.terminal_write, {
			terminalId: "absolute-files",
			path: filePath,
			content: writtenContent,
		});
		expect(writeResult.details).toMatchObject({ path: filePath });

		setup.adapter.setTerminalCommandResult("absolute-files", `test -w '${filePath}'`, { exitCode: 0 });
		setup.adapter.setTerminalCommandResult("absolute-files", `base64 < '${filePath}' | tr -d '\\n'`, {
			stdout: Buffer.from(writtenContent, "utf8").toString("base64"),
			exitCode: 0,
		});
		const editedContent = "edited\n";
		const editedEncoded = Buffer.from(editedContent, "utf8").toString("base64");
		setup.adapter.setTerminalCommandResult(
			"absolute-files",
			`printf %s '${editedEncoded}' | base64 -d > '${filePath}'`,
			{ exitCode: 0 },
		);
		const editResult = await execute(setup.definitions.terminal_edit, {
			terminalId: "absolute-files",
			path: filePath,
			edits: [{ oldText: "written", newText: "edited" }],
		});
		expect(editResult.details).toMatchObject({ path: filePath, diff: expect.stringContaining("+1 edited") });
	});

	it("preserves read failure semantics without invoking the output reviewer", async () => {
		let reviewCalls = 0;
		const setup = await createSetup({
			async review() {
				reviewCalls += 1;
				return { text: "reviewed", status: "completed", inputTruncated: false };
			},
		});
		await execute(setup.definitions.target_select, { targetId: "fake" });
		const terminal = await execute(setup.definitions.terminal_create, { terminalId: "missing-file" });
		setup.adapter.setTerminalCommandResult("missing-file", "test -r 'missing.txt'", { exitCode: 1 });

		await expect(
			execute(setup.definitions.terminal_read, { terminalId: "missing-file", path: "missing.txt" }),
		).rejects.toThrow("Terminal file is not readable");

		const failedWriteContent = "secret payload";
		const failedWriteEncoded = Buffer.from(failedWriteContent, "utf8").toString("base64");
		setup.adapter.setTerminalCommandResult("missing-file", "mkdir -p -- '.'", { exitCode: 0 });
		setup.adapter.setTerminalCommandResult(
			"missing-file",
			`printf %s '${failedWriteEncoded}' | base64 -d > 'broken.txt'`,
			{ stderr: "disk full\n", exitCode: 1 },
		);
		await expect(
			execute(setup.definitions.terminal_write, {
				terminalId: "missing-file",
				path: "broken.txt",
				content: failedWriteContent,
			}),
		).rejects.toThrow("Terminal file write failed");

		const workLog = readFileSync((terminal.details as { logPath: string }).logPath, "utf8");
		expect(workLog).toContain("disk full");
		expect(workLog).not.toContain(failedWriteEncoded);
		expect(reviewCalls).toBe(0);
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
		expect(stripAnsi(terminalCreateCall?.render(64)[0] ?? "")).toMatch(/^Terminal Create \[build\]\(/);

		const terminalBashCall = setup.definitions.terminal_bash.renderCall?.(
			{ terminalId: "build", command: "npm run check", timeout: 30 } as never,
			theme,
			context,
		);
		expect(stripAnsi(terminalBashCall?.render(160)[0] ?? "")).toBe(
			"Terminal Bash [build](npm run check · timeout 30s)",
		);

		const terminalSendCall = setup.definitions.terminal_send.renderCall?.(
			{ terminalId: "build", input: "echo ready\n" } as never,
			theme,
			context,
		);
		expect(terminalSendCall?.render(64)).toHaveLength(1);
		expect(stripAnsi(terminalSendCall?.render(64)[0] ?? "")).toBe("Terminal Send [build](echo ready\\n)");

		const terminalCaptureCall = setup.definitions.terminal_capture.renderCall?.(
			{ terminalId: "build", cursor: 120 } as never,
			theme,
			context,
		);
		expect(stripAnsi(terminalCaptureCall?.render(160)[0] ?? "")).toBe("Terminal Capture [build](cursor 120)");
		const terminalStatusCall = setup.definitions.terminal_status.renderCall?.(
			{ terminalId: "build" } as never,
			theme,
			context,
		);
		expect(stripAnsi(terminalStatusCall?.render(160)[0] ?? "")).toBe("Terminal Status [build]()");
		const terminalCloseCall = setup.definitions.terminal_close.renderCall?.(
			{ terminalId: "build" } as never,
			theme,
			context,
		);
		expect(stripAnsi(terminalCloseCall?.render(160)[0] ?? "")).toBe("Terminal Close [build]()");

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
		await execute(setup.definitions.terminal_create, { terminalId: "failed-terminal" });
		setup.adapter.setTerminalCommandResult("failed-terminal", "false", { stderr: "failed\n", exitCode: 7 });
		const terminalFailure = await execute(setup.definitions.terminal_bash, {
			terminalId: "failed-terminal",
			command: "false",
		});
		expect(terminalFailure.details).toMatchObject({
			operation: "terminal_bash",
			ok: false,
			exitCode: 7,
			diagnostic: { code: "remote_command" },
			review: { status: "fallback" },
		});
		expect(terminalFailure.content[0]).toMatchObject({
			type: "text",
			text: expect.stringMatching(/failed[\s\S]*@.*工作日志\.log$/),
		});
		const read = setup.runtime.createReadOperations();
		setup.adapter.setCommandResult("cd '/workspace' && cat -- 'hello.txt'", {
			stdout: "hello\n",
			exitCode: 0,
		});
		const path = join(setup.cwd, "hello.txt");
		await expect(read.readFile(path)).resolves.toEqual(Buffer.from("hello\n"));
		await expect(read.access(path)).resolves.toBeUndefined();
		expect(setup.adapter.commandCalls).toContain("cd '/workspace' && test -r 'hello.txt'");
	});
});
