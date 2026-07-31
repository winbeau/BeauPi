import type { Component } from "@earendil-works/pi-tui";
import type { BackgroundSummaryV1, BackgroundTaskSnapshotV1 } from "../../../core/background/types.ts";
import type { MonitorStatus } from "../../../core/monitor/index.ts";
import type { Theme, ThemeColor } from "../theme/theme.ts";
import { activityStateSymbol, fitSingleLine } from "./beaupi-style.ts";

function activityState(status: MonitorStatus): "pending" | "active" | "completed" | "failed" | "blocked" | "cancelled" {
	if (status === "starting") return "pending";
	if (status === "running" || status === "healthy") return "active";
	if (status === "completed") return "completed";
	if (status === "failed") return "failed";
	if (status === "cancelled") return "cancelled";
	return "blocked";
}

function statusColor(status: MonitorStatus): ThemeColor {
	if (status === "starting") return "dim";
	if (status === "running" || status === "healthy") return "accent";
	if (status === "completed") return "success";
	if (status === "failed") return "error";
	if (status === "cancelled") return "muted";
	return "warning";
}

function duration(milliseconds: number): string {
	const seconds = Math.max(0, milliseconds) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	return `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60)
		.toString()
		.padStart(2, "0")}s`;
}

function command(task: BackgroundTaskSnapshotV1): string {
	if (!task.executable) return task.name;
	return [task.executable, ...task.args].join(" ");
}

export class BackgroundTaskComponent implements Component {
	private readonly tasks: readonly BackgroundTaskSnapshotV1[];
	private readonly summary?: BackgroundSummaryV1;
	private readonly currentTheme: Theme;
	private readonly expanded: boolean;
	private readonly now: () => number;

	constructor(
		tasks: readonly BackgroundTaskSnapshotV1[],
		summary: BackgroundSummaryV1 | undefined,
		currentTheme: Theme,
		expanded = false,
		now: () => number = () => Date.now(),
	) {
		this.tasks = tasks;
		this.summary = summary;
		this.currentTheme = currentTheme;
		this.expanded = expanded;
		this.now = now;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const availableWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (availableWidth === 0) return [];
		const summary = this.summary;
		const lines = [
			fitSingleLine(
				[
					{ text: this.currentTheme.bold("Background Tasks"), required: true, truncate: true },
					{
						text: summary ? this.currentTheme.fg("accent", `${summary.running} running`) : "",
						separator: " · ",
						priority: 2,
					},
					{
						text:
							summary && summary.wakeQueued > 0
								? this.currentTheme.fg("warning", `wake ${summary.wakeQueued}`)
								: "",
						separator: " · ",
						priority: 3,
					},
				],
				availableWidth,
			),
		];
		if (this.tasks.length === 0) {
			lines.push(this.currentTheme.fg("dim", "No background tasks."));
			return lines;
		}
		for (const task of this.tasks) {
			const monitor = task.monitor;
			const color = statusColor(task.status);
			const symbol = this.currentTheme.fg(color, activityStateSymbol(activityState(task.status)));
			const age = monitor ? Math.max(0, this.now() - monitor.lastActivityAt) : 0;
			lines.push(
				fitSingleLine(
					[
						{ text: symbol, required: true },
						{ text: task.id, separator: " ", required: true },
						{ text: command(task), separator: " ", required: true, truncate: true },
						{ text: this.currentTheme.fg(color, task.status), separator: " · ", priority: 4 },
						{
							text: monitor ? this.currentTheme.fg("dim", duration(monitor.durationMs)) : "",
							separator: " · ",
							priority: 3,
						},
						{
							text:
								monitor && age >= 1_000 ? this.currentTheme.fg("dim", `idle ${Math.floor(age / 1000)}s`) : "",
							separator: " · ",
							priority: 2,
						},
						{
							text: task.wakeQueued > 0 ? this.currentTheme.fg("warning", `wake ${task.wakeQueued}`) : "",
							separator: " · ",
							priority: 5,
						},
					],
					availableWidth,
				),
			);
			const diagnostic = task.diagnostics.at(-1) ?? monitor?.diagnostics.at(-1);
			if (
				diagnostic &&
				(this.expanded || task.status === "failed" || task.status === "stalled" || task.status === "lost")
			) {
				lines.push(
					fitSingleLine(
						[
							{ text: this.currentTheme.fg(color, "  diagnostic"), required: true },
							{ text: diagnostic, separator: ": ", required: true, truncate: true },
						],
						availableWidth,
					),
				);
			}
			if (monitor?.logPath) {
				lines.push(
					fitSingleLine(
						[
							{ text: this.currentTheme.fg("dim", "  log"), required: true },
							{
								text: this.currentTheme.fg("dim", monitor.logPath),
								separator: ": ",
								required: true,
								truncate: true,
							},
						],
						availableWidth,
					),
				);
			}
		}
		return lines;
	}
}
