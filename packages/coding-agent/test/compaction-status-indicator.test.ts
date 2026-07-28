import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CompactionStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("CompactionStatusIndicator", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("renders streamed summary progress using an asymptotic bar", () => {
		const requestRender = vi.fn();
		const ui = { requestRender } as unknown as TUI;
		const indicator = new CompactionStatusIndicator(ui, "manual");

		try {
			indicator.addProgress(4_800);
			const lines = indicator.render(80).map(stripAnsi);

			expect(lines.at(-1)).toContain("63%");
			expect(lines.at(-1)).toContain("━");
			expect(requestRender).toHaveBeenCalled();
		} finally {
			indicator.dispose();
		}
	});
});
