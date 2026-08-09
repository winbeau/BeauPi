import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import {
	type CommandRecord,
	selectTaskTodos,
	type TaskTodo,
	type TaskTodoStatus,
} from "../../../core/state/task-ledger.ts";
import { theme } from "../theme/theme.ts";
import { fitSingleLine } from "./beaupi-style.ts";

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
	const source = width >= 80 && todo.source && todo.source !== "dynamic-task" ? theme.fg("dim", todo.source) : "";
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

function renderTodoActivity(todo: TaskTodo, width: number): string | undefined {
	if (todo.status !== "active" || !todo.activity) return undefined;
	return fitSingleLine(
		[
			{ text: theme.fg("dim", "    ⎿"), required: true },
			{ text: theme.fg("dim", todo.activity), separator: "  ", required: true, truncate: true },
		],
		width,
	);
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
		const dynamicTasks = snapshot.dynamicTasks;
		if (!dynamicTasks) return [];

		const dynamicTodos = snapshot.todos.filter((todo) => todo.source === "dynamic-task");
		const selection = selectTaskTodos(dynamicTodos, taskTodoLimit(terminalRows(this.tui)));
		const dynamicCompleted = dynamicTasks.tasks.filter((task) => task.status === "completed").length;
		const dynamicAttention = dynamicTasks.tasks.filter(
			(task) => task.status === "blocked" || task.status === "failed",
		).length;
		const header = fitSingleLine(
			[
				{ text: theme.bold("Tasks"), required: true },
				{ text: theme.fg("accent", `plan r${dynamicTasks.revision}`), separator: " · ", required: true },
				{
					text: theme.fg(
						dynamicAttention > 0 ? "warning" : "dim",
						`${dynamicCompleted}/${dynamicTasks.tasks.length} completed`,
					),
					separator: " · ",
					priority: 1,
				},
				{
					text: dynamicAttention > 0 ? theme.fg("warning", `${dynamicAttention} attention`) : "",
					separator: " · ",
					priority: 0,
				},
			],
			availableWidth,
		);
		const todoLines = selection.visible.flatMap((todo) => {
			const activity = renderTodoActivity(todo, availableWidth);
			return activity ? [renderTodo(todo, availableWidth), activity] : [renderTodo(todo, availableWidth)];
		});
		const lines = [header, ...todoLines];
		const hiddenSummary = hiddenTodoSummary(selection.hidden, availableWidth);
		if (hiddenSummary) lines.push(hiddenSummary);
		return lines;
	}
}
