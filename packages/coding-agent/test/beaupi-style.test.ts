import { setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	BEAUPI_GUTTERS,
	BEAUPI_INDENT_COLUMNS,
	BEAUPI_STATUS_BY_SYMBOL,
	BEAUPI_STATUS_SYMBOLS,
	type BeauPiToolState,
	continuationGutter,
	fitLabelSuffixMetadata,
	fitSingleLine,
	indent,
	messageGutter,
	responsiveSpacing,
	resultGutter,
	semanticStatus,
	statusSymbol,
	toolStateSymbol,
	toolTitle,
	treeGutter,
} from "../src/modes/interactive/components/beaupi-style.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const WIDTHS = [0, 1, 2, 8, 40, 80, 120, 160] as const;
const STATES = [
	"queued",
	"running",
	"success",
	"completed",
	"warning",
	"error",
	"failed",
	"cancelled",
	"permission",
	"permission-waiting",
] as const satisfies readonly BeauPiToolState[];

function expectFits(output: string, width: number): void {
	for (const line of output.split("\n")) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(0, width));
	}
}

describe("BeauPi visual helpers", () => {
	beforeAll(() => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("beaupi-dark", false);
	});

	afterAll(() => {
		initTheme("dark", false);
	});

	it("maps lifecycle aliases to stable semantic states and symbols", () => {
		expect(semanticStatus("completed")).toBe("success");
		expect(semanticStatus("failed")).toBe("error");
		expect(semanticStatus("permission-waiting")).toBe("permission");
		expect(statusSymbol("running")).toBe("●");
		expect(statusSymbol("success")).toBe("✓");
		expect(statusSymbol("completed")).toBe("✓");
		expect(statusSymbol("warning")).toBe("▲");
		expect(statusSymbol("error")).toBe("✗");
		expect(statusSymbol("failed")).toBe("✗");
		expect(statusSymbol("cancelled")).toBe("⊘");
		expect(statusSymbol("permission-waiting")).toBe("!");
		expect(BEAUPI_STATUS_BY_SYMBOL[BEAUPI_STATUS_SYMBOLS.permission]).toBe("permission");
	});

	it("styles every lifecycle state without relying on color alone", () => {
		for (const state of STATES) {
			const styled = toolStateSymbol(state, theme);
			expect(stripAnsi(styled)).toBe(statusSymbol(state));
			expect(visibleWidth(styled)).toBe(1);
		}
	});

	it("defines stable message, tool, continuation, tree, and indent rules", () => {
		expect(visibleWidth(BEAUPI_GUTTERS.message)).toBe(BEAUPI_INDENT_COLUMNS.message);
		expect(visibleWidth(BEAUPI_GUTTERS.toolResult)).toBe(BEAUPI_INDENT_COLUMNS.toolResult);
		expect(visibleWidth(BEAUPI_GUTTERS.continuation)).toBe(BEAUPI_INDENT_COLUMNS.continuation);
		expect(visibleWidth(BEAUPI_GUTTERS.treeBranch)).toBe(BEAUPI_INDENT_COLUMNS.tree);
		expect(stripAnsi(messageGutter("hello", theme, 80))).toBe("> hello");
		expect(stripAnsi(resultGutter("184 lines", theme, 80))).toBe("  ⎿  184 lines");
		expect(stripAnsi(continuationGutter("continued", theme, 80))).toBe("     continued");
		expect(stripAnsi(treeGutter("branch", theme, 80))).toBe("   ├─ ");
		expect(stripAnsi(treeGutter("last", theme, 80))).toBe("   └─ ");
		expect(stripAnsi(treeGutter("pipe", theme, 80))).toBe("   │  ");
		expect(indent("toolResult", 80)).toBe("     ");
		expect(indent("toolResult", 2)).toBe("  ");
	});

	it("uses responsive spacing without changing block height at normal widths", () => {
		expect(responsiveSpacing(0)).toEqual({ blockRows: 0, inlineColumns: 0, metadataSeparator: "" });
		expect(responsiveSpacing(1)).toEqual({ blockRows: 0, inlineColumns: 1, metadataSeparator: " " });
		expect(responsiveSpacing(40)).toEqual({ blockRows: 1, inlineColumns: 1, metadataSeparator: " · " });
		expect(responsiveSpacing(80)).toEqual({ blockRows: 1, inlineColumns: 1, metadataSeparator: " · " });
		expect(responsiveSpacing(120)).toEqual({ blockRows: 1, inlineColumns: 2, metadataSeparator: " · " });
		expect(responsiveSpacing(160)).toEqual({ blockRows: 1, inlineColumns: 2, metadataSeparator: " · " });
	});

	it("fits ASCII, ANSI, CJK, emoji, combining marks, and empty content", () => {
		const inputs = [
			"ordinary ASCII metadata that can become long",
			theme.fg("accent", "ANSI styled metadata that can become long"),
			"路径/到/项目/中的/非常长的文件名.ts",
			"status 🚀 package 📦 ready ✅",
			"Cafe\u0301 re\u0301sume\u0301 coo\u0308perate",
			"",
		];

		for (const width of WIDTHS) {
			for (const input of inputs) {
				const output = fitSingleLine([{ text: input, required: true, truncate: true }], width);
				expectFits(output, width);
			}
		}
	});

	it("drops low-priority metadata before truncating the label or suffix", () => {
		const wide = fitLabelSuffixMetadata(
			{
				label: theme.fg("text", "Update authentication session"),
				suffix: theme.fg("success", "completed"),
				metadata: [theme.fg("dim", "12.4s"), theme.fg("dim", "184 lines")],
			},
			120,
		);
		expect(stripAnsi(wide)).toContain("Update authentication session  completed · 12.4s · 184 lines");

		const narrow = fitLabelSuffixMetadata(
			{
				label: "Update authentication session with a deliberately long label",
				suffix: "completed",
				metadata: ["12.4s", "184 lines"],
			},
			40,
		);
		expect(stripAnsi(narrow)).toContain("completed");
		expect(stripAnsi(narrow)).not.toContain("184 lines");
		expectFits(narrow, 40);
	});

	it("degrades gutters and titles safely at widths 0 and 1", () => {
		for (const width of [0, 1]) {
			const outputs = [
				messageGutter("hello", theme, width),
				resultGutter("result", theme, width),
				continuationGutter("continued", theme, width),
				treeGutter("branch", theme, width),
				toolTitle("Bash", "npm run check", "permission-waiting", theme, width),
			];
			for (const output of outputs) expectFits(output, width);
		}
		expect(stripAnsi(treeGutter("branch", theme, 1))).toBe("├");
		expect(stripAnsi(toolTitle("Bash", "npm run check", "running", theme, 1))).toBe("●");
	});

	it("keeps gutters, titles, suffixes, and metadata within 40/80/120/160 columns", () => {
		for (const width of [40, 80, 120, 160]) {
			const outputs = [
				messageGutter("用户输入 with emoji 🚀 and combining e\u0301", theme, width),
				resultGutter("完成 184 lines 📦", theme, width),
				continuationGutter(theme.fg("muted", "continued ANSI output"), theme, width),
				toolTitle("Update", "src/非常长的目录/authentication/session.ts", "success", theme, width),
				fitLabelSuffixMetadata(
					{
						label: theme.bold("label with ANSI styling"),
						suffix: "suffix",
						metadata: ["12.4s", "184 lines", "metadata"],
					},
					width,
				),
			];
			for (const output of outputs) expectFits(output, width);
		}
	});

	it("does not modify inputs and returns the same output for the same input", () => {
		const parts = Object.freeze([
			Object.freeze({ text: "label", required: true, truncate: true }),
			Object.freeze({ text: "metadata", separator: " · ", priority: 1 }),
		]);
		const first = fitSingleLine(parts, 8);
		const second = fitSingleLine(parts, 8);
		expect(first).toBe(second);
		expect(parts).toEqual([
			{ text: "label", required: true, truncate: true },
			{ text: "metadata", separator: " · ", priority: 1 },
		]);
	});
});
