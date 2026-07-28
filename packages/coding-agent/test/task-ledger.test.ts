import type { AgentEvent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import {
	attachTaskLedgerToolDetails,
	createCommandSignature,
	isCommitCommand,
	isGitStatusCommand,
	isVerificationCommand,
	selectTaskTodos,
	TaskLedger,
	type TaskLedgerToolDetails,
	type TaskTodo,
} from "../src/core/state/task-ledger.ts";

function toolStart(toolCallId: string, toolName: string, args: Record<string, unknown>): AgentEvent {
	return { type: "tool_execution_start", toolCallId, toolName, args };
}

function toolEnd(
	toolCallId: string,
	toolName: string,
	options: { isError?: boolean; details?: unknown } = {},
): AgentEvent {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName,
		result: { content: [{ type: "text", text: options.isError ? "failed" : "ok" }], details: options.details },
		isError: options.isError ?? false,
	};
}

function messageEntry(
	id: string,
	parentId: string | null,
	timestamp: number,
	message: UserMessage | AssistantMessage | ToolResultMessage,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(timestamp).toISOString(),
		message,
	};
}

function toolMetadata(
	options: Partial<TaskLedgerToolDetails> & Pick<TaskLedgerToolDetails, "eventId" | "status">,
): TaskLedgerToolDetails {
	return {
		version: 1,
		eventId: options.eventId,
		status: options.status,
		startedAt: options.startedAt ?? 100,
		endedAt: options.endedAt ?? 110,
		command: options.command,
		commandSignature: options.commandSignature,
		filesRead: options.filesRead,
		filesModified: options.filesModified,
		verification: options.verification,
		commit: options.commit,
	};
}

describe("TaskLedger", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("tracks discover, execute, verify, and commit lifecycle facts", () => {
		const ledger = new TaskLedger({ taskId: "session-1", cwd: "/repo" });
		ledger.handleAgentEvent({
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text: "change it" }], timestamp: 900 },
		});

		ledger.handleAgentEvent(toolStart("read-1", "read", { path: "/repo/src/a.ts" }));
		ledger.handleAgentEvent(toolEnd("read-1", "read", { details: { path: "/repo/src/a.ts" } }));
		let snapshot = ledger.getSnapshot();
		expect(snapshot.phase).toBe("discover");
		expect(snapshot.filesRead.map((record) => record.path)).toEqual(["src/a.ts"]);

		vi.setSystemTime(2_000);
		ledger.handleAgentEvent(toolStart("write-1", "write", { path: "/repo/src/a.ts", content: "next" }));
		ledger.handleAgentEvent(toolEnd("write-1", "write", { details: { path: "/repo/src/a.ts", bytesWritten: 4 } }));
		snapshot = ledger.getSnapshot();
		expect(snapshot.phase).toBe("execute");
		expect(snapshot.filesModified).toEqual(["src/a.ts"]);
		expect(snapshot.verification.status).toBe("pending");

		vi.setSystemTime(3_000);
		ledger.handleAgentEvent(toolStart("check-1", "bash", { command: "npm run check" }));
		expect(ledger.getSnapshot().verification.status).toBe("running");
		ledger.handleAgentEvent(toolEnd("check-1", "bash"));
		snapshot = ledger.getSnapshot();
		expect(snapshot.phase).toBe("verify");
		expect(snapshot.verification.status).toBe("passed");

		vi.setSystemTime(4_000);
		ledger.handleAgentEvent(toolStart("commit-1", "bash", { command: "git commit -m done" }));
		ledger.handleAgentEvent(toolEnd("commit-1", "bash"));
		snapshot = ledger.getSnapshot();
		expect(snapshot.phase).toBe("commit");
		expect(snapshot.todos.find((todo) => todo.id === "commit")?.status).toBe("completed");
	});

	it("records tool failure and cancellation without duplicate counts", () => {
		const ledger = new TaskLedger({ taskId: "session-2", cwd: "/repo" });
		ledger.handleAgentEvent(toolStart("failure", "read", { path: "missing.ts" }));
		ledger.handleAgentEvent(toolEnd("failure", "read", { isError: true }));
		ledger.handleAgentEvent(toolEnd("failure", "read", { isError: true }));

		ledger.handleAgentEvent(toolStart("cancelled", "bash", { command: "sleep 10" }));
		ledger.handleAgentEvent(toolEnd("cancelled", "bash", { isError: true }), { cancelled: true });

		const snapshot = ledger.getSnapshot();
		expect(snapshot.commands).toHaveLength(2);
		expect(snapshot.failures.map((failure) => failure.status)).toEqual(["failed", "cancelled"]);
		expect(snapshot.commands.map((command) => command.status)).toEqual(["failed", "cancelled"]);
	});

	it("normalizes simple command signatures and classifies git status, verification, and commit commands", () => {
		expect(createCommandSignature("  git   status -sb  ")).toBe("git status --branch --short");
		expect(createCommandSignature("git --no-optional-locks status --short --branch")).toBe(
			"git status --branch --short",
		);
		expect(createCommandSignature("printf '%s  %s' a b")).toBe("printf %s  %s a b");
		expect(isGitStatusCommand("git -C /repo status --short")).toBe(true);
		expect(isGitStatusCommand("git status && echo done")).toBe(false);
		expect(isVerificationCommand("npm run check")).toBe(true);
		expect(isVerificationCommand("./test.sh")).toBe(true);
		expect(isCommitCommand("git commit -m done")).toBe(true);
	});

	it("detects repeated git status only while the ledger-observed workspace is unchanged", () => {
		const ledger = new TaskLedger({ taskId: "session-3", cwd: "/repo" });
		ledger.handleAgentEvent(toolStart("status-1", "bash", { command: "git status --short" }));
		ledger.handleAgentEvent(toolEnd("status-1", "bash"));

		vi.setSystemTime(2_000);
		ledger.handleAgentEvent(toolStart("status-2", "bash", { command: "git --no-optional-locks status -s" }));
		ledger.handleAgentEvent(toolEnd("status-2", "bash"));
		let snapshot = ledger.getSnapshot();
		expect(snapshot.commands[1]?.duplicateOf).toBe("tool:status-1");
		expect(snapshot.todos.find((todo) => todo.id === "duplicate-git-status")).toMatchObject({
			status: "blocked",
			owner: "main",
		});

		vi.setSystemTime(3_000);
		ledger.handleAgentEvent(toolStart("edit-1", "edit", { path: "/repo/src/a.ts", edits: [] }));
		ledger.handleAgentEvent(toolEnd("edit-1", "edit", { details: { path: "/repo/src/a.ts" } }));
		vi.setSystemTime(4_000);
		ledger.handleAgentEvent(toolStart("status-3", "bash", { command: "git status --short" }));
		ledger.handleAgentEvent(toolEnd("status-3", "bash"));
		snapshot = ledger.getSnapshot();
		expect(snapshot.commands.find((command) => command.id === "tool:status-3")?.duplicateOf).toBeUndefined();
		expect(snapshot.todos.find((todo) => todo.id === "duplicate-git-status")).toBeUndefined();

		vi.setSystemTime(35_001);
		ledger.handleAgentEvent(toolStart("status-4", "bash", { command: "git status --short" }));
		ledger.handleAgentEvent(toolEnd("status-4", "bash"));
		snapshot = ledger.getSnapshot();
		expect(snapshot.commands.find((command) => command.id === "tool:status-4")?.duplicateOf).toBeUndefined();
	});

	it("rebuilds only the current Session branch and ignores abandoned branch modifications", () => {
		const manager = SessionManager.inMemory("/repo");
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "work" }], timestamp: 1 });
		manager.appendMessage(
			fauxAssistantMessage(fauxToolCall("read", { path: "src/a.ts" }, { id: "read-branch" }), {
				stopReason: "toolUse",
			}),
		);
		const readLeaf = manager.appendMessage({
			role: "toolResult",
			toolCallId: "read-branch",
			toolName: "read",
			content: [{ type: "text", text: "a" }],
			details: attachTaskLedgerToolDetails(
				{ path: "/repo/src/a.ts" },
				toolMetadata({ eventId: "tool:read-branch", status: "success", filesRead: ["src/a.ts"] }),
			),
			isError: false,
			timestamp: 3,
		});
		manager.appendMessage(
			fauxAssistantMessage(fauxToolCall("write", { path: "src/a.ts", content: "next" }, { id: "write-abandoned" }), {
				stopReason: "toolUse",
			}),
		);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "write-abandoned",
			toolName: "write",
			content: [{ type: "text", text: "written" }],
			details: attachTaskLedgerToolDetails(
				{ path: "/repo/src/a.ts", bytesWritten: 4 },
				toolMetadata({
					eventId: "tool:write-abandoned",
					status: "success",
					filesModified: ["src/a.ts"],
				}),
			),
			isError: false,
			timestamp: 5,
		});
		manager.branch(readLeaf);
		manager.appendMessage(
			fauxAssistantMessage(fauxToolCall("bash", { command: "git status --short" }, { id: "status-current" }), {
				stopReason: "toolUse",
			}),
		);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "status-current",
			toolName: "bash",
			content: [{ type: "text", text: "clean" }],
			details: attachTaskLedgerToolDetails(
				{ command: "git status --short", exitCode: 0 },
				toolMetadata({ eventId: "tool:status-current", status: "success", command: "git status --short" }),
			),
			isError: false,
			timestamp: 7,
		});

		const snapshot = new TaskLedger({
			taskId: "branch",
			cwd: "/repo",
			entries: manager.getBranch(),
		}).getSnapshot();
		expect(snapshot.commands.map((command) => command.toolCallId)).toEqual(["read-branch", "status-current"]);
		expect(snapshot.filesModified).toEqual([]);
		expect(snapshot.filesRead.map((record) => record.path)).toEqual(["src/a.ts"]);
	});

	it("rebuilds from Session entries and deduplicates repeated tool results by toolCallId", () => {
		const metadata = toolMetadata({
			eventId: "tool:read-1",
			status: "success",
			filesRead: ["src/a.ts"],
		});
		const user = messageEntry("user", null, 10, {
			role: "user",
			content: [{ type: "text", text: "inspect" }],
			timestamp: 10,
		});
		const assistant = messageEntry(
			"assistant",
			"user",
			20,
			fauxAssistantMessage(fauxToolCall("read", { path: "src/a.ts" }, { id: "read-1" }), {
				stopReason: "toolUse",
			}),
		);
		const details = attachTaskLedgerToolDetails({ path: "/repo/src/a.ts" }, metadata);
		const toolResult = messageEntry("result", "assistant", 30, {
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: "content" }],
			details,
			isError: false,
			timestamp: 30,
		});
		const duplicateResult = messageEntry("result-copy", "result", 31, {
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: "content" }],
			details,
			isError: false,
			timestamp: 31,
		});

		const ledger = new TaskLedger({
			taskId: "session-4",
			cwd: "/repo",
			entries: [user, assistant, toolResult, duplicateResult],
		});
		const snapshot = ledger.getSnapshot();
		expect(snapshot.commands).toHaveLength(1);
		expect(snapshot.filesRead).toHaveLength(1);
		expect(snapshot.filesRead[0]?.path).toBe("src/a.ts");
	});
});

describe("selectTaskTodos", () => {
	it("prioritizes recent completion, failures, active work, pending work, blocked work, and older completion", () => {
		const now = 100_000;
		const todos: TaskTodo[] = [
			{ id: "old", label: "old", status: "completed", sequence: 0, updatedAt: 1, completedAt: 1 },
			{ id: "blocked", label: "blocked", status: "blocked", sequence: 1, updatedAt: 2 },
			{ id: "pending", label: "pending", status: "pending", sequence: 2, updatedAt: 3 },
			{ id: "active", label: "active", status: "active", sequence: 3, updatedAt: 4 },
			{ id: "failed", label: "failed", status: "failed", sequence: 4, updatedAt: 5 },
			{
				id: "recent",
				label: "recent",
				status: "completed",
				sequence: 5,
				updatedAt: now - 1,
				completedAt: now - 1,
			},
		];

		const selection = selectTaskTodos(todos, 4, now);
		expect(selection.visible.map((todo) => todo.id)).toEqual(["recent", "failed", "active", "pending"]);
		expect(selection.hidden.map((todo) => todo.id)).toEqual(["blocked", "old"]);
	});
});
