import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { WorkflowSnapshot } from "../src/core/workflow/index.ts";
import { WorkflowSnapshotComponent } from "../src/modes/interactive/components/workflow.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function snapshot(): WorkflowSnapshot {
	return {
		version: 1,
		workflowId: "wf-render",
		definitionId: "parallel-review",
		status: "running",
		createdAt: "2026-01-01T00:00:00.000Z",
		startedAt: "2026-01-01T00:00:00.000Z",
		durationMs: 12_600,
		maxConcurrency: 3,
		monitorId: "mon-workflow",
		nodes: [
			{
				id: "inspect",
				profile: "reviewer",
				taskSummary: "Inspect",
				dependsOn: [],
				writePolicy: "none",
				failurePolicy: "continue",
				status: "completed",
				createdAt: "2026-01-01T00:00:00.000Z",
				startedAt: "2026-01-01T00:00:00.000Z",
				completedAt: "2026-01-01T00:00:08.200Z",
				durationMs: 8_200,
				monitorId: "mon-inspect",
				diagnostics: [],
			},
			{
				id: "correctness-review-with-a-very-long-name",
				profile: "reviewer",
				taskSummary: "Correctness",
				dependsOn: ["inspect"],
				writePolicy: "none",
				failurePolicy: "continue",
				status: "running",
				createdAt: "2026-01-01T00:00:00.000Z",
				startedAt: "2026-01-01T00:00:08.200Z",
				durationMs: 4_400,
				monitorId: "mon-correctness",
				diagnostics: [],
			},
			{
				id: "security",
				profile: "reviewer",
				taskSummary: "Security",
				dependsOn: ["inspect"],
				writePolicy: "none",
				failurePolicy: "continue",
				status: "failed",
				createdAt: "2026-01-01T00:00:00.000Z",
				startedAt: "2026-01-01T00:00:08.200Z",
				completedAt: "2026-01-01T00:00:09.200Z",
				durationMs: 1_000,
				monitorId: "mon-security",
				diagnostics: [],
				error: { code: "review_failed", message: "Found a blocking lifecycle race in session recovery" },
			},
		],
		diagnostics: [],
	};
}

describe("WorkflowSnapshotComponent", () => {
	it("renders current, completed, parallel, and failed nodes without overflow in dark/light themes", () => {
		for (const themeName of ["beaupi-dark", "beaupi-light"]) {
			initTheme(themeName, false);
			for (const width of [40, 80, 120, 160]) {
				const component = new WorkflowSnapshotComponent(snapshot(), theme, true);
				const lines = component.render(width);
				const plain = lines.map(stripAnsi);
				expect(plain[0]).toContain("Workflow: parallel-review");
				expect(plain.join("\n")).toContain("Found a blocking");
				if (width >= 80) {
					expect(plain.join("\n")).toContain("blocking lifecycle race");
					const correctness = plain.find((line) => line.includes("correctness"));
					const security = plain.find((line) => line.includes("security"));
					expect(correctness?.search(/\S/)).toBe(security?.search(/\S/));
				}
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});
