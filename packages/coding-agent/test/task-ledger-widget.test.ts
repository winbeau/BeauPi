import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { TaskLedgerSnapshot, TaskTodo } from "../src/core/state/task-ledger.ts";
import {
	selectTimelineCommands,
	TaskLedgerWidget,
	taskTodoLimit,
} from "../src/modes/interactive/components/task-ledger-widget.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createSnapshot(overrides: Partial<TaskLedgerSnapshot> = {}): TaskLedgerSnapshot {
	return {
		taskId: "task-1",
		phase: "execute",
		startedAt: 1,
		updatedAt: 10,
		revision: 1,
		workspaceRevision: 1,
		commands: [],
		filesRead: [],
		fileModifications: [],
		filesModified: ["src/a.ts", "src/b.ts"],
		failures: [],
		verification: { status: "pending", timestamp: 10 },
		todos: [],
		...overrides,
	};
}

function createWidget(snapshot: TaskLedgerSnapshot, rows = 45): TaskLedgerWidget {
	const session = {
		taskLedger: { getSnapshot: () => snapshot },
	} as unknown as AgentSession;
	const tui = { terminal: { rows } } as unknown as TUI;
	return new TaskLedgerWidget(session, tui);
}

function renderPlain(widget: TaskLedgerWidget, width: number): string {
	return stripAnsi(widget.render(width).join("\n"));
}

describe("TaskLedgerWidget", () => {
	beforeAll(() => {
		initTheme("beaupi-dark", false);
	});

	it("renders pending, active, completed, failed, and blocked Todo states with owner and blocked summaries", () => {
		const todos: TaskTodo[] = [
			{ id: "pending", label: "Pending item", status: "pending", sequence: 0, updatedAt: 1, owner: "main" },
			{ id: "active", label: "Active item", status: "active", sequence: 1, updatedAt: 2, owner: "main" },
			{
				id: "completed",
				label: "Completed item",
				status: "completed",
				sequence: 2,
				updatedAt: 3,
				completedAt: Date.now(),
				owner: "main",
			},
			{ id: "failed", label: "Failed item", status: "failed", sequence: 3, updatedAt: 4, owner: "main" },
			{
				id: "blocked",
				label: "Blocked item",
				status: "blocked",
				sequence: 4,
				updatedAt: 5,
				owner: "main",
				blockedBy: ["#1", "#2"],
			},
		];
		const widget = createWidget(createSnapshot({ todos }), 80);
		const styledWide = widget.render(120).join("\n");
		const wide = stripAnsi(styledWide);
		expect(wide).toContain("Tasks · execute · 2 files · verify pending");
		expect(wide).toContain("○ Pending item (@main)");
		expect(wide).toContain("● Active item (@main)");
		expect(wide).toContain("● Completed item (@main)");
		expect(wide).toContain("● Failed item (@main)");
		expect(styledWide).toContain(theme.getFgAnsi("success"));
		expect(styledWide).toContain(theme.getFgAnsi("error"));
		expect(wide).toContain("! Blocked item (@main) ▸ blocked by #1, #2");

		const narrow = renderPlain(widget, 40);
		expect(narrow).not.toContain("(@main)");
	});

	it("dynamically truncates Todo items and retains a categorized hidden summary", () => {
		const todos: TaskTodo[] = Array.from({ length: 10 }, (_, index) => ({
			id: `todo-${index}`,
			label: `Todo ${index}`,
			status: index === 0 ? "active" : index < 6 ? "pending" : "completed",
			sequence: index,
			updatedAt: index,
			completedAt: index >= 6 ? 1 : undefined,
		}));
		const widget = createWidget(createSnapshot({ todos }), 24);
		const lines = widget.render(80).map(stripAnsi);
		expect(taskTodoLimit(24)).toBe(3);
		expect(lines.filter((line) => /^[ ]{2}[○●!]/.test(line))).toHaveLength(3);
		expect(lines.some((line) => line.includes("pending") && line.includes("completed"))).toBe(true);
		expect(taskTodoLimit(120)).toBe(10);
	});

	it("renders a Tool Timeline with the M1 lifecycle symbols and repeated-command summary", () => {
		const commands: TaskLedgerSnapshot["commands"] = [
			{
				id: "one",
				source: "tool",
				toolCallId: "one",
				toolName: "read",
				label: "Read",
				summary: "src/a.ts",
				status: "success",
				startedAt: 1,
				endedAt: 2,
				workspaceRevision: 0,
				verification: false,
				commit: false,
			},
			{
				id: "two",
				source: "tool",
				toolCallId: "two",
				toolName: "bash",
				label: "Bash",
				command: "npm run check",
				status: "running",
				startedAt: 3,
				workspaceRevision: 1,
				verification: true,
				commit: false,
			},
			{
				id: "three",
				source: "tool",
				toolCallId: "three",
				toolName: "bash",
				label: "Bash",
				command: "git status --short",
				status: "failed",
				startedAt: 4,
				endedAt: 5,
				workspaceRevision: 1,
				duplicateOf: "status-before",
				verification: false,
				commit: false,
			},
		];
		const widget = createWidget(createSnapshot({ commands, todos: [] }));
		const rendered = renderPlain(widget, 100);
		expect(rendered).toContain("Tools");
		expect(rendered).toContain("● Read(src/a.ts)");
		expect(rendered).toContain("● Bash(npm run check)");
		expect(rendered).toContain("● Bash(git status --short · repeated)");
		expect(selectTimelineCommands(commands, 2).map((command) => command.id)).toEqual(["two", "three"]);
	});

	it("keeps every rendered line within 40, 80, 120, and 160 columns", () => {
		const todos: TaskTodo[] = [
			{
				id: "active",
				label: "更新一个包含中文和 emoji 🙂 的非常长任务描述",
				status: "active",
				sequence: 0,
				updatedAt: 1,
				owner: "primary-agent-with-a-long-name",
			},
		];
		const widget = createWidget(createSnapshot({ todos }));
		for (const width of [40, 80, 120, 160]) {
			for (const line of widget.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
