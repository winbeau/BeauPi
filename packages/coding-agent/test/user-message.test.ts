import { setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BG_RESET = "\x1b[49m";
const WIDTHS = [0, 1, 2, 8, 40, 60, 80, 120, 160] as const;

describe("UserMessageComponent", () => {
	beforeEach(() => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("beaupi-dark", false);
	});

	afterEach(() => {
		initTheme("dark", false);
	});

	test("renders a single user message with a BeauPi gutter and no background card", () => {
		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(3);
		expect(stripAnsi(lines[1]).trimEnd()).toBe(" > hello");
		expect(lines[1]).toContain(theme.getFgAnsi("accent"));
		expect(lines.join("\n")).not.toContain(theme.getBgAnsi("userMessageBg"));
		expect(lines.join("\n")).not.toContain(BG_RESET);
	});

	test("preserves OSC 133 order and the existing top/content/bottom height", () => {
		const lines = new UserMessageComponent("hello").render(20);

		expect(lines).toHaveLength(3);
		expect(lines[0].startsWith(OSC133_ZONE_START)).toBe(true);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[2].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(lines.join("").indexOf(OSC133_ZONE_START)).toBeLessThan(lines.join("").indexOf(OSC133_ZONE_END));
	});

	test("aligns wrapped and explicit continuation lines with the message body", () => {
		const component = new UserMessageComponent("第一行包含很长的中文内容\nsecond line with emoji 🚀", undefined, 0);
		const contentLines = component
			.render(12)
			.slice(1, -1)
			.map((line) => stripAnsi(line).trimEnd());

		expect(contentLines.length).toBeGreaterThan(2);
		expect(contentLines[0].startsWith("> ")).toBe(true);
		for (const line of contentLines.slice(1)) expect(line.startsWith("  ")).toBe(true);
	});

	test("preserves ordered list markers and backslash escapes", () => {
		const rendered = stripAnsi(
			new UserMessageComponent("7. item\n\n\\*literal\\*", undefined, 0).render(40).join("\n"),
		);

		expect(rendered).toContain("> 7. item");
		expect(rendered).toContain("\\*literal\\*");
	});

	test("applies outputPad without changing the gutter/body relationship", () => {
		const padded = new UserMessageComponent("hello", undefined, 1).render(40).map(stripAnsi);
		expect(padded.some((line) => line.startsWith(" > hello"))).toBe(true);

		const unpadded = new UserMessageComponent("hello", undefined, 0).render(40).map(stripAnsi);
		expect(unpadded.some((line) => line.startsWith("> hello"))).toBe(true);
	});

	test("keeps Unicode and ANSI output within every target width", () => {
		const text = "路径/到/项目/中的/文件.ts · emoji 🚀 · Cafe\u0301 · metadata";
		for (const outputPad of [0, 1]) {
			const component = new UserMessageComponent(text, undefined, outputPad);
			for (const width of WIDTHS) {
				for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	test("recolors the user gutter after theme invalidation", () => {
		const component = new UserMessageComponent("hello", undefined, 0);
		const darkAccent = theme.getFgAnsi("accent");
		expect(component.render(40).join("\n")).toContain(darkAccent);

		initTheme("beaupi-light", false);
		component.invalidate();
		const lightAccent = theme.getFgAnsi("accent");
		const lightRender = component.render(40).join("\n");
		expect(lightAccent).not.toBe(darkAccent);
		expect(lightRender).toContain(lightAccent);
		expect(lightRender).not.toContain(darkAccent);
	});
});
