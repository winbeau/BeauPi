import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, setTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function createWriteComponent(content: string): ToolExecutionComponent {
	return new ToolExecutionComponent(
		"write",
		"write-renderer",
		{ path: "src/example.ts", content },
		{},
		createWriteToolDefinition(process.cwd()),
		createFakeTui(),
		process.cwd(),
	);
}

describe("Write renderer", () => {
	beforeEach(() => {
		initTheme("beaupi-dark", false);
	});

	it("updates more-lines and total counts as streamed arguments grow", () => {
		const tenLines = Array.from({ length: 10 }, (_, index) => `const value${index} = ${index};`).join("\n");
		const component = createWriteComponent(tenLines);
		let rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Write(src/example.ts)");
		expect(rendered).not.toContain("more lines");

		const elevenLines = `${tenLines}\nconst value10 = 10;`;
		component.updateArgs({ path: "src/example.ts", content: elevenLines });
		rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("1 more lines, 11 total");

		const seventyTwoLines = Array.from({ length: 72 }, (_, index) => `const value${index} = ${index};`).join("\n");
		component.updateArgs({ path: "src/example.ts", content: seventyTwoLines });
		rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("62 more lines, 72 total");
	});

	it("expands the complete preview with Ctrl+O state", () => {
		const content = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
		const component = createWriteComponent(content);
		expect(stripAnsi(component.render(100).join("\n"))).not.toContain("line 20");

		component.setExpanded(true);
		expect(stripAnsi(component.render(100).join("\n"))).toContain("line 20");
	});

	it("refreshes syntax colors after theme invalidation", () => {
		const component = createWriteComponent("const answer = 42;");
		const dark = component.render(100).join("\n");
		setTheme("beaupi-light", false);
		component.invalidate();
		const light = component.render(100).join("\n");

		expect(light).not.toBe(dark);
		expect(stripAnsi(light)).toBe(stripAnsi(dark));
	});

	it("shows invalid and empty content states without losing the tool title", () => {
		const invalid = new ToolExecutionComponent(
			"write",
			"write-invalid",
			{ path: "empty.txt", content: 42 },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(invalid.render(80).join("\n"))).toContain("invalid content arg");

		const empty = createWriteComponent("");
		const rendered = stripAnsi(empty.render(80).join("\n"));
		expect(rendered).toContain("Write(src/example.ts)");
		expect(rendered).not.toContain("more lines");
	});

	it("keeps all rendered lines within narrow and wide terminal widths", () => {
		const component = createWriteComponent(`const message = "${"长路径🙂".repeat(30)}";`);
		for (const width of [40, 60, 80, 120, 160]) {
			for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
