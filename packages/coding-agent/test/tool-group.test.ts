import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolGroupComponent } from "../src/modes/interactive/components/tool-group.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function createRead(path: string): ToolExecutionComponent {
	return new ToolExecutionComponent(
		"read",
		`read-${path}`,
		{ path },
		{},
		createReadToolDefinition(process.cwd()),
		createFakeTui(),
		process.cwd(),
	);
}

describe("ToolGroupComponent", () => {
	beforeEach(() => {
		initTheme("beaupi-dark", false);
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("summarizes adjacent tools and keeps the current operation visible for at least 700ms", () => {
		const first = createRead("src/first.ts");
		const second = createRead("src/second.ts");
		const group = new ToolGroupComponent(createFakeTui(), [first, second]);
		let rendered = stripAnsi(group.render(100).join("\n"));
		expect(rendered).toContain("2 tools");
		expect(rendered).toContain("src/second.ts");

		first.updateResult({ content: [{ type: "text", text: "one" }], isError: false }, false);
		second.updateResult({ content: [{ type: "text", text: "two" }], isError: false }, false);
		vi.setSystemTime(699);
		rendered = stripAnsi(group.render(100).join("\n"));
		expect(rendered).toContain("src/second.ts");

		vi.setSystemTime(700);
		rendered = stripAnsi(group.render(100).join("\n"));
		expect(rendered).toContain("Read ×2");
		expect(rendered).not.toContain("src/second.ts");
	});

	it("expands every child and stops aggregation when a child fails", () => {
		const first = createRead("src/first.ts");
		const second = createRead("src/second.ts");
		const group = new ToolGroupComponent(createFakeTui(), [first, second]);
		group.setExpanded(true);
		let rendered = stripAnsi(group.render(100).join("\n"));
		expect(rendered).toContain("src/first.ts");
		expect(rendered).toContain("src/second.ts");

		group.setExpanded(false);
		second.updateResult({ content: [{ type: "text", text: "Read failed" }], isError: true }, false);
		rendered = stripAnsi(group.render(100).join("\n"));
		expect(rendered).toContain("src/first.ts");
		expect(rendered).toContain("Read failed");
		expect(group.canAppend(createRead("src/third.ts"))).toBe(false);
	});

	it("keeps summaries and child output within all target widths", () => {
		const group = new ToolGroupComponent(createFakeTui(), [
			createRead("src/这是一个很长的中文路径🙂/first.ts"),
			createRead("src/这是另一个很长的中文路径🙂/second.ts"),
		]);
		for (const width of [40, 60, 80, 120, 160]) {
			for (const line of group.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
