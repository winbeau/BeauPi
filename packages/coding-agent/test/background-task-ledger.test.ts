import { describe, expect, it } from "vitest";
import type { BackgroundRuntimeSnapshotV1 } from "../src/core/background/index.ts";
import { TaskLedger } from "../src/core/state/task-ledger.ts";
import type { DynamicTaskPlanV1 } from "../src/core/tasks/types.ts";

function backgroundSnapshot(): BackgroundRuntimeSnapshotV1 {
	const task = {
		version: 1 as const,
		id: "bg-ledger",
		sessionId: "session",
		monitorId: "mon-ledger",
		source: "attached" as const,
		name: "tests",
		goal: "wait for tests",
		args: [],
		createdAt: 1,
		waitRequestedAt: 2,
		triggers: [],
		logCursor: 0,
		reviewCount: 0,
		progressReview: {
			version: 1 as const,
			enabled: false,
			minimumIntervalMs: 300_000,
			maxReviews: 6,
			maxInputCharacters: 12_000,
			timeoutMs: 30_000,
			maxOutputTokens: 512,
		},
		diagnostics: [],
		status: "running" as const,
		wakeQueued: 1,
		lastWakeReason: "completed" as const,
	};
	return {
		version: 1,
		tasks: [task],
		wakeEvents: [
			{
				version: 1,
				id: "wake-ledger",
				dedupeKey: "key",
				taskId: task.id,
				monitorId: task.monitorId,
				reason: "completed",
				monitorStatus: "completed",
				createdAt: 3,
				state: "queued",
			},
		],
		summary: {
			version: 1,
			total: 1,
			waiting: 1,
			starting: 0,
			running: 1,
			stalled: 0,
			completed: 0,
			failed: 0,
			cancelled: 0,
			lost: 0,
			wakeQueued: 1,
		},
	};
}

describe("TaskLedger Background projection", () => {
	it("projects waiting tasks and wake attention without a second task state system", () => {
		const ledger = new TaskLedger({ taskId: "session", cwd: process.cwd() });
		const plan: DynamicTaskPlanV1 = {
			version: 1,
			planId: "plan-bg",
			revision: 1,
			goal: "Wait for tests",
			createdAt: 1,
			updatedAt: 1,
			factSequence: 0,
			facts: [],
			tasks: [
				{
					id: "tests",
					title: "Run tests",
					status: "active",
					dependsOn: [],
					matchHints: [],
					evidence: [],
					blockedBy: [],
					createdAt: 1,
					updatedAt: 1,
				},
			],
		};
		ledger.setDynamicTaskPlan(plan);
		ledger.setBackgroundSnapshot(backgroundSnapshot());
		const snapshot = ledger.getSnapshot(10);
		expect(snapshot.background?.summary).toMatchObject({ running: 1, wakeQueued: 1 });
		expect(snapshot.todos).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "dynamic-task:tests", source: "dynamic-task" }),
				expect.objectContaining({ id: "background:bg-ledger", status: "active", label: "Wait for tests" }),
				expect.objectContaining({ id: "background:wake-queue", status: "blocked" }),
			]),
		);
		expect(snapshot.todos.map((todo) => todo.id)).not.toEqual(
			expect.arrayContaining(["discover", "execute", "verify"]),
		);
	});
});
