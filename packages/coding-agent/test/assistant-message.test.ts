import type { AssistantMessage } from "@earendil-works/pi-ai";
import { setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const WIDTHS = [0, 1, 2, 8, 40, 60, 80, 120, 160] as const;

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason" | "errorMessage">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		errorMessage: overrides.errorMessage,
		timestamp: Date.now(),
	};
}

function plainLines(component: AssistantMessageComponent, width = 80): string[] {
	return component.render(width).map((line) => stripAnsi(line).trimEnd());
}

describe("AssistantMessageComponent", () => {
	beforeEach(() => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("beaupi-dark", false);
	});

	afterEach(() => {
		initTheme("dark", false);
	});

	test("adds OSC 133 zone markers to pure assistant messages in the existing order", () => {
		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0].startsWith(OSC133_ZONE_START)).toBe(true);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant content contains tool calls", () => {
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered).not.toContain(OSC133_ZONE_START);
		expect(rendered).not.toContain(OSC133_ZONE_END);
		expect(rendered).not.toContain(OSC133_ZONE_FINAL);
	});

	test("coalesces thinking and keeps exactly one gap before following text", () => {
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first thought" },
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: "second thought" },
				{ type: "text", text: "answer" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
			true,
			undefined,
			"Thinking...",
			0,
		);

		expect(plainLines(component)).toEqual(["", "Thinking...", "", "answer"]);
	});

	test("keeps a thinking summary that labels a following tool call", () => {
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "**Defining optional renderer exports**" },
				{ type: "toolCall", id: "tool-1", name: "edit", arguments: { path: "src/tools/index.ts" } },
			]),
			false,
			undefined,
			"Thinking...",
			0,
		);

		expect(plainLines(component)).toEqual(["", "Defining optional renderer exports"]);
	});

	test("does not add a trailing blank line before the first tool title", () => {
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "first" },
				{ type: "text", text: "second" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
			false,
			undefined,
			"Thinking...",
			0,
		);

		expect(plainLines(component)).toEqual(["", "first", "second"]);
	});

	test("renders expanded thinking as foreground-only dim italic content", () => {
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }]),
			false,
			undefined,
			"Thinking...",
			0,
		);
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain(theme.getFgAnsi("thinkingText"));
		expect(rendered).not.toContain(theme.getBgAnsi("userMessageBg"));
		expect(rendered).not.toContain(theme.getBgAnsi("customMessageBg"));
		expect(stripAnsi(rendered)).toContain("private reasoning");
	});

	test("keeps length stops visible even when the message contains a tool call", () => {
		const component = new AssistantMessageComponent(
			createAssistantMessage(
				[
					{ type: "thinking", thinking: "private reasoning" },
					{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
				],
				{ stopReason: "length" },
			),
			true,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("Thinking...");
		expect(rendered).toContain("● Error: Model stopped");
		expect(rendered).toContain("maximum output token limit");
		expect(rendered.match(/maximum output token limit/g)).toHaveLength(1);
	});

	test("shows one assistant error when no tool call owns the failure", () => {
		const aborted = new AssistantMessageComponent(
			createAssistantMessage([], { stopReason: "aborted", errorMessage: "Request was aborted" }),
		);
		expect(stripAnsi(aborted.render(80).join("\n"))).toContain("● Operation aborted");

		const failed = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "partial" }], {
				stopReason: "error",
				errorMessage: "provider failed",
			}),
		);
		const rendered = stripAnsi(failed.render(80).join("\n"));
		expect(rendered).toContain("● Error: provider failed");
		expect(rendered.match(/provider failed/g)).toHaveLength(1);
	});

	test("does not duplicate aborted or error text already owned by a tool call", () => {
		for (const stopReason of ["aborted", "error"] as const) {
			const component = new AssistantMessageComponent(
				createAssistantMessage(
					[
						{ type: "text", text: "calling tool" },
						{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
					],
					{ stopReason, errorMessage: "tool-owned failure" },
				),
			);
			expect(stripAnsi(component.render(80).join("\n"))).not.toContain("tool-owned failure");
		}
	});

	test("uses configured output padding for text and thinking", () => {
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "reasoning" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
		);
		expect(plainLines(component).some((line) => line.startsWith(" hello"))).toBe(true);
		expect(plainLines(component).some((line) => line.startsWith(" reasoning"))).toBe(true);

		component.setOutputPad(0);
		expect(plainLines(component).some((line) => line.startsWith("hello"))).toBe(true);
		expect(plainLines(component).some((line) => line.startsWith("reasoning"))).toBe(true);
	});

	test("keeps text, thinking, and errors within every target width", () => {
		for (const outputPad of [0, 1]) {
			const component = new AssistantMessageComponent(
				createAssistantMessage(
					[
						{ type: "thinking", thinking: "推理内容 with emoji 🚀 and Cafe\u0301" },
						{ type: "text", text: "正文包含很长的 Unicode content that must wrap safely" },
					],
					{ stopReason: "error", errorMessage: "长错误信息 must remain visible" },
				),
				false,
				undefined,
				"Thinking...",
				outputPad,
			);
			for (const width of WIDTHS) {
				for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			expect(stripAnsi(component.render(1).join("\n"))).toContain("●");
		}
	});

	test("recolors hidden thinking content after theme invalidation", () => {
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "reasoning" }]),
			true,
			undefined,
			"Thinking...",
			0,
		);
		const darkThinking = theme.getFgAnsi("thinkingText");
		expect(component.render(80).join("\n")).toContain(darkThinking);

		initTheme("beaupi-light", false);
		component.invalidate();
		const lightThinking = theme.getFgAnsi("thinkingText");
		const lightRender = component.render(80).join("\n");
		expect(lightThinking).not.toBe(darkThinking);
		expect(lightRender).toContain(lightThinking);
		expect(lightRender).not.toContain(darkThinking);
	});
});
