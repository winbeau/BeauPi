import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { BackgroundTaskSnapshotV1 } from "../src/core/background/types.ts";
import { BackgroundTaskComponent } from "../src/modes/interactive/components/background.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function task(status: BackgroundTaskSnapshotV1["status"], index: number): BackgroundTaskSnapshotV1 {
	const monitor = {
		version: 1 as const,
		id: `mon-bg-${index}`,
		sessionId: "session",
		target: { kind: "process" as const, pid: 500 + index, logPath: `/tmp/a-very-long-background-log-${index}.log` },
		kind: "process" as const,
		name: `background task ${index}`,
		taskSummary: "Long task",
		createdAt: 1,
		startedAt: 1,
		durationMs: 123_456,
		lastActivityAt: 1,
		status,
		logPath: `/tmp/a-very-long-background-log-${index}.log`,
		logCursor: 10,
		activityLog: [],
		diagnostics: status === "failed" || status === "lost" ? ["process state could not be confirmed"] : [],
	};
	return {
		version: 1,
		id: `bg-${index}`,
		sessionId: "session",
		monitorId: monitor.id,
		source: "started",
		name: monitor.name,
		goal: "Run a long process",
		executable: "/usr/bin/a-very-long-executable-name",
		args: ["--with-a-long-argument", "--and-another-one"],
		createdAt: 1,
		triggers: [],
		logCursor: 10,
		progressReview: {
			version: 1,
			enabled: false,
			minimumIntervalMs: 300_000,
			maxReviews: 6,
			maxInputCharacters: 12_000,
			timeoutMs: 30_000,
			maxOutputTokens: 512,
		},
		reviewCount: 0,
		diagnostics: monitor.diagnostics,
		status,
		monitor,
		target: monitor.target,
		wakeQueued: status === "failed" ? 1 : 0,
		lastWakeReason: status === "failed" ? "failed" : undefined,
	};
}

describe("BackgroundTaskComponent", () => {
	it("renders empty, running, completed, failed, stalled and lost snapshots without overflow", () => {
		for (const themeName of ["beaupi-dark", "beaupi-light"]) {
			initTheme(themeName, false);
			for (const width of [40, 80, 120, 160]) {
				const component = new BackgroundTaskComponent(
					[task("running", 1), task("completed", 2), task("failed", 3), task("stalled", 4), task("lost", 5)],
					{
						version: 1,
						total: 5,
						waiting: 1,
						starting: 0,
						running: 1,
						stalled: 1,
						completed: 1,
						failed: 1,
						cancelled: 0,
						lost: 1,
						wakeQueued: 1,
					},
					theme,
					true,
				);
				const lines = component.render(width);
				expect(lines.map(stripAnsi).join("\n")).toContain("Background Tasks");
				expect(lines.map(stripAnsi).join("\n")).toContain("diagnostic: process state");
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		const empty = new BackgroundTaskComponent([], undefined, theme).render(80).map(stripAnsi).join("\n");
		expect(empty).toContain("No background tasks.");
	});
});
