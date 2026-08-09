import { join, resolve } from "node:path";
import { setCapabilities, setKeybindings, Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { getReadmePath } from "../src/config.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createLsToolDefinition } from "../src/core/tools/ls.ts";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("ToolExecutionComponent parity", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.useRealTimers();
		setKeybindings(new KeybindingsManager());
	});

	test("stacks custom call and result renderers like the old implementation", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("custom call");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call");
		expect(rendered).toContain("custom result");
	});

	test("renders ask_user_question waiting, answer, cancellation, and interaction failure states compactly", () => {
		const args = {
			questions: [
				{
					question: "Choose",
					header: "Target",
					options: [
						{ label: "A", description: "Use A" },
						{ label: "B", description: "Use B" },
					],
					multiSelect: false,
				},
			],
		};
		const component = new ToolExecutionComponent(
			"ask_user_question",
			"question-call",
			args,
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		expect(stripAnsi(component.render(80).join("\n"))).toContain("Question — waiting for user response");

		component.updateResult(
			{
				content: [{ type: "text", text: "answered" }],
				details: {
					version: 1,
					requestId: "question-call",
					status: "answered",
					answers: [{ header: "Target", selectedLabels: ["A"] }],
					createdAt: "2026-03-15T00:00:00.000Z",
				},
				isError: false,
			},
			false,
		);
		let rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("Target: A");
		expect(rendered).not.toContain(JSON.stringify(args, null, 2));

		component.updateResult(
			{
				content: [{ type: "text", text: "cancelled" }],
				details: {
					version: 1,
					requestId: "question-call",
					status: "cancelled",
					answers: [],
					createdAt: "2026-03-15T00:00:00.000Z",
				},
				isError: false,
			},
			false,
		);
		rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("Cancelled by user");
		expect(component.getDisplayState()).toBe("cancelled");

		component.updateResult(
			{
				content: [{ type: "text", text: "failed" }],
				details: {
					version: 1,
					requestId: "question-call",
					status: "interaction_error",
					answers: [],
					createdAt: "2026-03-15T00:00:00.000Z",
					diagnostic: "host failed",
				},
				isError: false,
			},
			false,
		);
		expect(component.getDisplayState()).toBe("error");
		expect(stripAnsi(component.render(80).join("\n"))).toContain("host failed");
	});

	test("uses a minimal shell with lifecycle symbols and no status background", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("Custom Tool(example)", 0, 0),
			renderResult: (result) => new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0),
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-minimal-shell",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);

		let rendered = component.render(80).join("\n");
		expect(stripAnsi(rendered)).toContain("○ Custom Tool(example)");
		expect(rendered).not.toContain(theme.getBgAnsi("toolPendingBg"));

		component.markExecutionStarted();
		rendered = component.render(80).join("\n");
		expect(stripAnsi(rendered)).toContain("● Custom Tool(example)");

		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		rendered = component.render(80).join("\n");
		expect(stripAnsi(rendered)).toContain("● Custom Tool(example)");
		expect(rendered).toContain(theme.getFgAnsi("success"));
		expect(stripAnsi(rendered)).toContain("⎿  done");
		expect(rendered).not.toContain(theme.getBgAnsi("toolSuccessBg"));

		component.updateResult({ content: [{ type: "text", text: "failed" }], isError: true }, false);
		rendered = component.render(80).join("\n");
		expect(stripAnsi(rendered)).toContain("● Custom Tool(example)");
		expect(rendered).toContain(theme.getFgAnsi("error"));
		expect(rendered).not.toContain(theme.getBgAnsi("toolErrorBg"));

		component.updateResult({ content: [{ type: "text", text: "Operation aborted" }], isError: true }, false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("● Custom Tool(example)");
		component.markCancelled("Operation aborted");
		expect(stripAnsi(component.render(80).join("\n"))).toContain("⊘ Custom Tool(example)");
	});

	test("self-rendered empty tool rows take no layout space", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderShell: "self",
			renderCall: () => new Text("", 0, 0),
			renderResult: () => new Text("", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-empty-self-render",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(component.render(120)).toEqual([]);

		component.updateResult(
			{
				content: [],
				details: {},
				isError: false,
			},
			false,
		);

		expect(component.render(120)).toEqual([]);
	});

	test("uses built-in rendering for built-in overrides without custom renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("edit"),
		};

		const component = new ToolExecutionComponent(
			"edit",
			"tool-2",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Update");
		expect(rendered).toContain("README.md");
		expect(rendered).not.toContain(":1");
	});

	test("preserves legacy file_path rendering compatibility for built-in tools", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-3",
			{ file_path: "README.md" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Read");
		expect(rendered).toContain("README.md");
	});

	test("bash execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		const operations: BashOperations = {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
		const promise = tool.execute(
			"tool-bash-1",
			{ command: "sleep 10" },
			undefined,
			(update) => updates.push(update as { content: Array<{ type: string; text?: string }>; details?: unknown }),
			{} as never,
		);
		expect(updates).toEqual([{ content: [], details: undefined }]);
		await promise;
	});

	test("renders Bash calls on one line with animated truncation and a configurable collapsed output hint", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-30T00:00:00.000Z"));
		setKeybindings(new KeybindingsManager({ "app.tools.expand": "alt+x" }));
		let renderRequests = 0;
		const tui = {
			requestRender: () => {
				renderRequests++;
			},
		} as unknown as TUI;
		const command =
			"rg -n \"export interface ToolRender|export type ToolRender|interface ToolRender\" packages/coding-agent/src\nnode_modules/@earendil-works -g '*.ts' -g '*.d.ts' | head -20";
		const tool = createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false });
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-compact",
			{ command, timeout: 30 },
			{},
			tool,
			tui,
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{
				content: [{ type: "text", text: "first result\nsecond result\nthird result" }],
				details: { command, exitCode: null },
				isError: false,
			},
			true,
		);

		const wideLines = component.render(240).map(stripAnsi);
		const wideCall = wideLines.find((line) => line.includes("Bash(")) ?? "";
		expect(wideCall).toContain("packages/coding-agent/src node_modules/@earendil-works");
		expect(wideCall).not.toContain("\n");

		const firstLines = component.render(72);
		const firstPlainLines = firstLines.map(stripAnsi);
		const firstCall = firstPlainLines.find((line) => line.includes("Bash(")) ?? "";
		expect(firstCall).toMatch(/^● Bash\(.+\) · timeout 30s$/);
		expect(firstPlainLines.join("\n")).toContain("⎿  … (3 lines, alt+x to expand)");
		expect(firstPlainLines.join("\n")).not.toContain("first result");
		expect(firstLines.every((line) => visibleWidth(line) <= 72)).toBe(true);

		vi.advanceTimersByTime(120);
		const secondCall = component
			.render(72)
			.map(stripAnsi)
			.find((line) => line.includes("Bash("));
		expect(secondCall).not.toBe(firstCall);
		expect(renderRequests).toBeGreaterThan(0);

		component.setExpanded(true);
		expect(stripAnsi(component.render(72).join("\n"))).toContain("third result");
		component.updateResult(
			{
				content: [{ type: "text", text: "first result\nsecond result\nthird result" }],
				details: { command, exitCode: 0 },
				isError: false,
			},
			false,
		);
	});

	test("collapses Bash timeout and error output to the last ten lines until expanded", () => {
		const tool = createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false });
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-error-collapse",
			{ command: "long-running-command", timeout: 5 },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		const errorOutput = [
			"first-hidden",
			"second-hidden",
			...Array.from({ length: 9 }, (_, index) => `visible-${index + 1}`),
			"Command timed out after 5 seconds",
		].join("\n");
		component.updateResult({ content: [{ type: "text", text: errorOutput }], isError: true }, false);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("2 earlier lines hidden");
		expect(collapsed).not.toContain("first-hidden");
		expect(collapsed).not.toContain("second-hidden");
		expect(collapsed).toContain("visible-1");
		expect(collapsed).toContain("Command timed out after 5 seconds");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("first-hidden");
		expect(expanded).toContain("second-hidden");
	});

	test("bash renderer does not duplicate final full output truncation details", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 1; i <= 4000; i++) {
					onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`));
				}
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
		const result = await tool.execute(
			"tool-bash-1b",
			{ command: "generate output" },
			undefined,
			undefined,
			{} as never,
		);
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-1b",
			{ command: "generate output" },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ ...result, isError: false }, false);

		const rendered = stripAnsi(component.render(200).join("\n"));
		expect(rendered.match(/Full output:/g)?.length ?? 0).toBe(1);
		expect(rendered).toMatch(/line-4000[^\n]*\n\s*\[Full output:/);
		expect(rendered).not.toMatch(/line-4000[^\n]*\n\s*\n\s*\[Full output:/);
		expect(rendered).toContain("Truncated: showing 2000 of 4000 lines");
		expect(rendered).not.toContain("[Showing lines 2001-4000 of 4000. Full output:");
	});

	test("does not duplicate built-in headers when passed the active built-in definition", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-4",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/\bRead\b/g)?.length ?? 0).toBe(1);
	});

	test("inherits missing built-in result renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderCall: () => new Text("override call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4b",
			{ path: "notes.txt" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("hello");
	});

	test("inherits missing built-in call renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderResult: () => new Text("override result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4c",
			{ path: "README.md" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Read");
		expect(rendered).toContain("README.md");
		expect(rendered).toContain("override result");
	});

	test("uses custom renderers for built-in overrides that reuse built-in definition parameters", () => {
		const builtInDefinition = createReadToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4d",
			{ path: "README.md" },
			{},
			{
				...builtInDefinition,
				renderCall: () => new Text("override call", 0, 0),
				renderResult: () => new Text("override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("read README.md");
	});

	test("uses custom renderers for built-in overrides that reuse wrapped built-in tool parameters", () => {
		const builtInTool = createReadTool(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4e",
			{ path: "README.md" },
			{},
			{
				...createBaseToolDefinition("read"),
				parameters: builtInTool.parameters,
				renderCall: () => new Text("wrapped override call", 0, 0),
				renderResult: () => new Text("wrapped override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("wrapped override call");
		expect(rendered).toContain("wrapped override result");
	});

	test("shares renderer state across custom call and result slots", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				return new Text(`custom result ${context.state.token}`, 0, 0);
			},
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call shared-token");
		expect(rendered).toContain("custom result shared-token");
	});

	test("exposes args in render result context", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("call", 0, 0),
			renderResult: (_result, _options, _theme, context) =>
				new Text(`arg:${String((context.args as { foo: string }).foo)}`, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5b",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("arg:bar");
	});

	test("falls back when custom renderers are absent", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-6",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom_tool");
		expect(rendered).toContain("done");
	});

	test("preserves image result fallbacks in the minimal shell", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-image",
			{},
			{},
			createBaseToolDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
				isError: false,
			},
			false,
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("image/png");
	});

	test("uses structured result counts for collapsed search and list summaries", () => {
		const search = new ToolExecutionComponent(
			"grep",
			"tool-search-count",
			{ pattern: "token", path: "src", context: 1 },
			{},
			createGrepToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		search.updateResult(
			{
				content: [
					{
						type: "text",
						text: "src/a.ts-1- before\nsrc/a.ts:2: token\nsrc/a.ts-3- after\nsrc/b.ts:7: token\n\n[notice]",
					},
				],
				details: { matchCount: 2 },
				isError: false,
			},
			false,
		);
		expect(stripAnsi(search.render(80).join("\n"))).toContain("2 matches");

		const find = new ToolExecutionComponent(
			"find",
			"tool-find-count",
			{ pattern: "*.ts" },
			{},
			createFindToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		find.updateResult(
			{
				content: [{ type: "text", text: "a.ts\nb.ts\nc.ts\n\n[notice]" }],
				details: { resultCount: 3 },
				isError: false,
			},
			false,
		);
		expect(stripAnsi(find.render(80).join("\n"))).toContain("3 results");

		const list = new ToolExecutionComponent(
			"ls",
			"tool-list-count",
			{},
			{},
			createLsToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		list.updateResult(
			{
				content: [{ type: "text", text: "a.ts\nb.ts\n\n[notice]" }],
				details: { entryCount: 2 },
				isError: false,
			},
			false,
		);
		expect(stripAnsi(list.render(80).join("\n"))).toContain("2 entries");
	});

	test("trims trailing blank display lines from write previews", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-7",
			{ path: "README.md", content: "one\ntwo\n" },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("trims trailing blank display lines from read results", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-8",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "one\ntwo\n" }], details: undefined, isError: false },
			false,
		);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("does not syntax-highlight read errors based on the requested file path", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-read-error-highlighting",
			{ path: "config.exs", offset: 120, limit: 130 },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const error = "Offset 120 is beyond end of file (96 lines total)";
		component.updateResult({ content: [{ type: "text", text: error }], details: undefined, isError: true }, false);

		const rendered = component.render(120).join("\n");
		expect(stripAnsi(rendered)).toContain(error);
		expect(rendered).toContain(theme.fg("toolOutput", error));
	});

	test("shows up to ten ordinary read result lines and expands the remainder", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-ordinary-read-collapsed",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const tenLines = Array.from({ length: 10 }, (_, index) => `line-${String(index + 1).padStart(2, "0")}`).join(
			"\n",
		);
		component.updateResult(
			{ content: [{ type: "text", text: tenLines }], details: undefined, isError: false },
			false,
		);

		let collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("Read");
		expect(collapsed).toContain("notes.txt");
		expect(collapsed).toContain("line-10");
		expect(collapsed).not.toContain("more lines");

		component.updateResult(
			{ content: [{ type: "text", text: `${tenLines}\nline-11` }], details: undefined, isError: false },
			false,
		);
		collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("line-10");
		expect(collapsed).not.toContain("line-11");
		expect(collapsed).toContain("1 more lines");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("line-11");
	});

	for (const scenario of [
		{
			title: "SKILL.md",
			path: join(process.cwd(), "attio", "SKILL.md"),
			content: "---\nname: attio\ndescription: CRM helper\n---\n\n# Hidden skill instructions",
			compact: "Read Skill(attio)",
			hidden: "Hidden skill instructions",
			absent: "Read Skill attio",
		},
		{
			title: "AGENTS.md",
			path: join(process.cwd(), ".beaupi", "AGENTS.md"),
			content: "Hidden resource instructions",
			compact: "Read Resource(.beaupi/AGENTS.md)",
			hidden: "Hidden resource instructions",
			absent: undefined,
		},
		{
			title: "outside AGENTS.md",
			path: resolve(process.cwd(), "..", "AGENTS.md"),
			content: "Hidden outside resource instructions",
			compact: `Read Resource(${resolve(process.cwd(), "..", "AGENTS.md").replace(/\\/g, "/")})`,
			hidden: "Hidden outside resource instructions",
			absent: undefined,
		},
		{
			title: "Pi documentation",
			path: getReadmePath(),
			content: "Hidden docs content",
			compact: "Read Docs(README.md)",
			hidden: "Hidden docs content",
			absent: undefined,
		},
	] as const) {
		test(`renders ${scenario.title} read results compactly until expanded`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-${scenario.title}`,
				{ path: scenario.path },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "text", text: scenario.content }], details: undefined, isError: false },
				false,
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed).not.toContain(scenario.hidden);
			if (scenario.absent) {
				expect(collapsed).not.toContain(scenario.absent);
			}

			component.setExpanded(true);
			const expanded = stripAnsi(component.render(120).join("\n"));
			expect(expanded).toContain(scenario.hidden);
		});
	}

	for (const scenario of [
		{ title: "SKILL.md", path: join(process.cwd(), "attio", "SKILL.md"), compact: "Read Skill(attio:120-329)" },
		{ title: "Pi documentation", path: getReadmePath(), compact: "Read Docs(README.md:120-329)" },
	] as const) {
		test(`shows the read line range in compact ${scenario.title} reads before the expand hint`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-range-${scenario.title}`,
				{ path: scenario.path, offset: 120, limit: 210 },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed.indexOf(":120-329")).toBeLessThan(collapsed.indexOf("to expand"));
		});
	}
});
