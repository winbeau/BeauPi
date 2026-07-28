import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { StructuredDiffComponent } from "../src/modes/interactive/components/diff.ts";
import { initTheme, setTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("StructuredDiffComponent", () => {
	beforeEach(() => {
		initTheme("beaupi-dark", false);
	});

	it("renders solid boundaries, full-line backgrounds, line numbers, and word emphasis", () => {
		const component = new StructuredDiffComponent(
			[
				" 1 const token = await loadToken();",
				"-2 return refresh(token, currentSession, retryBudget);",
				"+2 return refreshWithRotation(token, currentSession, retryBudget);",
				" 3 }",
			].join("\n"),
		);
		const rendered = component.render(80).join("\n");
		const plain = stripAnsi(rendered);

		expect(plain.split("\n")[0]).toBe("─".repeat(80));
		expect(plain.split("\n").at(-1)).toBe("─".repeat(80));
		expect(plain).toContain("-2 return refresh(token, currentSession, retryBudget);");
		expect(plain).toContain("+2 return refreshWithRotation(token, currentSession, retryBudget);");
		expect(rendered).toContain(theme.getBgAnsi("toolDiffRemovedBg"));
		expect(rendered).toContain(theme.getBgAnsi("toolDiffAddedBg"));
		expect(rendered).toContain(theme.getBgAnsi("toolDiffRemovedEmphasisBg"));
		expect(rendered).toContain(theme.getBgAnsi("toolDiffAddedEmphasisBg"));
	});

	it("does not add word emphasis when most of a line changed", () => {
		const component = new StructuredDiffComponent("-1 alpha\n+1 completely different replacement");
		const rendered = component.render(60).join("\n");

		expect(rendered).not.toContain(theme.getBgAnsi("toolDiffRemovedEmphasisBg"));
		expect(rendered).not.toContain(theme.getBgAnsi("toolDiffAddedEmphasisBg"));
	});

	it("wraps long CJK and emoji lines without exceeding the render width", () => {
		const component = new StructuredDiffComponent(
			"-120 旧内容包含很长的中文与🙂emoji🙂emoji🙂emoji\n+120 新内容包含很长的中文与🙂emoji🙂emoji🙂emoji",
		);
		for (const width of [20, 40, 80, 120]) {
			const lines = component.render(width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("invalidates width and theme-specific render caches", () => {
		const component = new StructuredDiffComponent("-1 before\n+1 after");
		const dark = component.render(40).join("\n");
		setTheme("beaupi-light", false);
		component.invalidate();
		const light = component.render(40).join("\n");

		expect(light).not.toBe(dark);
		expect(stripAnsi(light)).toBe(stripAnsi(dark));
	});
});
