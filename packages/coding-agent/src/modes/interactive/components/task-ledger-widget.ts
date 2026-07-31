import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { MonitorRecord, MonitorStatus } from "../../../core/monitor/index.ts";
import {
	type CommandRecord,
	selectTaskTodos,
	type TaskLedgerSnapshot,
	type TaskTodo,
	type TaskTodoStatus,
} from "../../../core/state/task-ledger.ts";
import { theme } from "../theme/theme.ts";
import { activityStateSymbol, fitSingleLine } from "./beaupi-style.ts";

function safeWidth(width: number): number {
	return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function terminalRows(tui: TUI): number {
	const rows = tui.terminal.rows;
	return Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
}

export function taskTodoLimit(rows: number): number {
	const availableRows = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
	return Math.max(3, Math.min(10, Math.floor((availableRows - 8) / 6) + 1));
}

function taskTodoSymbol(status: TaskTodoStatus): string {
	switch (status) {
		case "completed":
			return theme.fg("success", "■");
		case "active":
			return theme.fg("accent", "□");
		case "failed":
			return theme.fg("error", "□");
		case "blocked":
			return theme.fg("warning", "□");
		case "pending":
			return theme.fg("dim", "□");
	}
}

function taskLabel(todo: TaskTodo, width: number): string {
	const showOwner = width >= 60 && todo.owner;
	const owner = showOwner ? theme.fg("dim", `(@${todo.owner})`) : "";
	const source = width >= 80 && todo.source ? theme.fg("dim", todo.source) : "";
	const blocked =
		todo.status === "blocked" && todo.blockedBy && todo.blockedBy.length > 0
			? theme.fg("dim", `▸ blocked by ${todo.blockedBy.join(", ")}`)
			: "";
	let label = todo.label;
	if (todo.status === "active") label = theme.bold(label);
	else if (todo.status === "completed") label = theme.fg("dim", theme.strikethrough(label));
	else if (todo.status === "blocked") label = theme.fg("dim", label);
	else if (todo.status === "failed") label = theme.fg("error", label);
	return fitSingleLine(
		[
			{ text: label, required: true, truncate: true },
			{ text: owner, separator: " ", priority: 2 },
			{ text: source, separator: " · ", priority: 1 },
			{ text: blocked, separator: " ", priority: 0 },
		],
		width,
	);
}

function renderTodo(todo: TaskTodo, width: number): string {
	const availableWidth = safeWidth(width);
	if (availableWidth === 0) return "";
	const symbol = taskTodoSymbol(todo.status);
	const prefix = `  ${symbol} `;
	if (visibleWidth(prefix) >= availableWidth) return truncateToWidth(prefix, availableWidth, "");
	return `${prefix}${taskLabel(todo, availableWidth - visibleWidth(prefix))}`;
}

function hiddenTodoSummary(hidden: readonly TaskTodo[], width: number): string | undefined {
	if (hidden.length === 0) return undefined;
	const counts = new Map<TaskTodoStatus, number>();
	for (const todo of hidden) counts.set(todo.status, (counts.get(todo.status) ?? 0) + 1);
	const labels: string[] = [];
	const add = (status: TaskTodoStatus, singular: string, plural = singular): void => {
		const count = counts.get(status) ?? 0;
		if (count > 0) labels.push(`${count} ${count === 1 ? singular : plural}`);
	};
	add("active", "in progress");
	add("pending", "pending");
	add("failed", "failed");
	add("blocked", "blocked");
	add("completed", "completed");
	return fitSingleLine(
		[
			{ text: theme.fg("dim", "  …"), required: true },
			{ text: theme.fg("dim", `+${labels.join(", ")}`), separator: " ", required: true, truncate: true },
		],
		width,
	);
}

function timelineRank(command: CommandRecord): number {
	if (command.status === "failed" || command.status === "cancelled") return 0;
	if (command.status === "running" || command.status === "queued") return 1;
	return 2;
}

export function selectTimelineCommands(commands: readonly CommandRecord[], maxVisible: number): CommandRecord[] {
	const limit = Math.max(0, Math.floor(maxVisible));
	return commands
		.map((command, index) => ({ command, index }))
		.sort(
			(left, right) =>
				timelineRank(left.command) - timelineRank(right.command) ||
				(right.command.endedAt ?? right.command.startedAt) - (left.command.endedAt ?? left.command.startedAt) ||
				right.index - left.index,
		)
		.slice(0, limit)
		.sort((left, right) => left.index - right.index)
		.map(({ command }) => command);
}

function verificationLabel(snapshot: TaskLedgerSnapshot): string {
	return snapshot.verification.status === "none" ? "" : `verify ${snapshot.verification.status}`;
}

function monitorActivityState(
	status: MonitorStatus,
): "pending" | "active" | "completed" | "failed" | "blocked" | "cancelled" {
	if (status === "starting") return "pending";
	if (status === "running" || status === "healthy") return "active";
	if (status === "completed") return "completed";
	if (status === "failed") return "failed";
	if (status === "cancelled") return "cancelled";
	return "blocked";
}

function monitorRank(record: MonitorRecord): number {
	if (record.status === "failed" || record.status === "stalled" || record.status === "lost") return 0;
	if (record.status === "starting" || record.status === "running" || record.status === "healthy") return 1;
	return 2;
}

function selectMonitorRows(records: readonly MonitorRecord[], maxVisible: number): MonitorRecord[] {
	return records
		.map((record, index) => ({ record, index }))
		.sort(
			(left, right) =>
				monitorRank(left.record) - monitorRank(right.record) ||
				right.record.lastActivityAt - left.record.lastActivityAt ||
				right.index - left.index,
		)
		.slice(0, Math.max(0, Math.floor(maxVisible)))
		.map(({ record }) => record);
}

function formatMonitorDuration(milliseconds: number): string {
	const seconds = Math.max(0, milliseconds) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	return `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60)
		.toString()
		.padStart(2, "0")}s`;
}

function renderMonitor(record: MonitorRecord, width: number): string {
	const prefix = `  ${activityStateSymbol(monitorActivityState(record.status))} `;
	if (record.status === "failed" && record.agentTask?.errorCode) {
		const turns =
			record.agentTask.maxTurns === undefined
				? `${record.agentTask.turnsUsed} turns`
				: `${record.agentTask.turnsUsed}/${record.agentTask.maxTurns} turns`;
		return fitSingleLine(
			[
				{ text: prefix, required: true },
				{ text: theme.fg("dim", "Monitor"), required: true },
				{ text: record.name, separator: " ", required: true, truncate: true },
				{ text: theme.fg("error", record.agentTask.errorCode), separator: " · ", required: true },
				{ text: theme.fg("dim", turns), separator: " · ", priority: 2 },
				{
					text: record.agentTask.lastToolName ? theme.fg("dim", `last: ${record.agentTask.lastToolName}`) : "",
					separator: " · ",
					priority: 1,
				},
			],
			width,
		);
	}
	return fitSingleLine(
		[
			{ text: prefix, required: true },
			{ text: theme.fg("dim", "Monitor"), required: true },
			{ text: record.name, separator: " ", required: true, truncate: true },
			{ text: theme.fg("dim", record.status), separator: " · ", priority: 1 },
			{ text: theme.fg("dim", formatMonitorDuration(record.durationMs)), separator: " · ", priority: 2 },
		],
		width,
	);
}

export class TaskLedgerWidget implements Component {
	private session: AgentSession;
	private readonly tui: TUI;

	constructor(session: AgentSession, tui: TUI) {
		this.session = session;
		this.tui = tui;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const availableWidth = safeWidth(width);
		if (availableWidth === 0) return [];
		const snapshot = this.session.taskLedger.getSnapshot();
		const monitorRuntime = this.session.monitorRuntime;
		const monitorRecords = monitorRuntime?.list({ includeTerminal: true }) ?? [];
		if (snapshot.todos.length === 0 && monitorRecords.length === 0) return [];
		const rows = terminalRows(this.tui);
		const todoLimit = taskTodoLimit(rows);
		const selection = selectTaskTodos(snapshot.todos, todoLimit);
		const monitorSummary = monitorRuntime?.getSummary();
		const runningWorkflows = snapshot.workflows.filter((workflow) => workflow.status === "running").length;
		const attentionWorkflows = snapshot.workflows.filter(
			(workflow) => workflow.status === "failed" || workflow.status === "lost",
		).length;
		const header = fitSingleLine(
			[
				{ text: theme.bold("Tasks"), required: true },
				{ text: theme.fg("accent", snapshot.phase), separator: " · ", required: true },
				{
					text:
						snapshot.filesModified.length > 0
							? theme.fg(
									"dim",
									`${snapshot.filesModified.length} file${snapshot.filesModified.length === 1 ? "" : "s"}`,
								)
							: "",
					separator: " · ",
					priority: 1,
				},
				{ text: theme.fg("dim", verificationLabel(snapshot)), separator: " · ", priority: 0 },
				{
					text:
						runningWorkflows > 0 || attentionWorkflows > 0
							? theme.fg(
									attentionWorkflows > 0 ? "warning" : "accent",
									`workflows ${runningWorkflows} running${attentionWorkflows > 0 ? ` · ${attentionWorkflows} attention` : ""}`,
								)
							: "",
					separator: " · ",
					priority: 2,
				},
				{
					text:
						monitorSummary && monitorSummary.total > 0
							? theme.fg(
									monitorSummary.failed + monitorSummary.stalled + monitorSummary.lost > 0
										? "warning"
										: "accent",
									`monitors ${monitorSummary.running + monitorSummary.healthy} running${
										monitorSummary.failed + monitorSummary.stalled + monitorSummary.lost > 0
											? ` · ${monitorSummary.failed + monitorSummary.stalled + monitorSummary.lost} attention`
											: ""
									}`,
								)
							: "",
					separator: " · ",
					priority: 1,
				},
				{
					text: snapshot.documentContract
						? theme.fg(
								snapshot.documentContract.stale ? "warning" : "dim",
								snapshot.documentContract.stale ? "docs stale" : "contract active",
							)
						: "",
					separator: " · ",
					priority: -1,
				},
			],
			availableWidth,
		);
		const lines = [header, ...selection.visible.map((todo) => renderTodo(todo, availableWidth))];
		const hiddenSummary = hiddenTodoSummary(selection.hidden, availableWidth);
		if (hiddenSummary) lines.push(hiddenSummary);
		for (const record of selectMonitorRows(monitorRecords, Math.max(2, Math.min(4, todoLimit)))) {
			lines.push(renderMonitor(record, availableWidth));
		}

		return lines;
	}
}
