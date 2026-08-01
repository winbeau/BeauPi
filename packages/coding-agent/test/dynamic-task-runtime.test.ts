import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { DynamicTaskRuntime, hashDynamicTaskFacts } from "../src/core/tasks/dynamic-task-runtime.ts";
import type { TaskReviewer, TaskReviewInput, TaskReviewResult } from "../src/core/tasks/task-reviewer.ts";
import {
	DYNAMIC_TASK_REVIEW_ENTRY_TYPE,
	DYNAMIC_TASK_SNAPSHOT_ENTRY_TYPE,
	type TasksUpdateInputV1,
} from "../src/core/tasks/types.ts";

function initial(expectedRevision = 0): TasksUpdateInputV1 {
	return {
		version: 1,
		expectedRevision,
		reason: "initial_plan",
		goal: "Implement M14",
		tasks: [
			{ id: "contract", title: "Define contract", status: "pending", matchHints: ["schema"] },
			{
				id: "runtime",
				title: "Implement runtime",
				status: "pending",
				dependsOn: ["contract"],
				matchHints: ["runtime"],
			},
		],
	};
}

describe("DynamicTaskRuntime", () => {
	it("creates a plan, advances revision through CAS, and returns structured conflicts", async () => {
		let now = 100;
		const manager = SessionManager.inMemory("/repo");
		const runtime = new DynamicTaskRuntime({ sessionManager: manager, now: () => now++ });

		const created = await runtime.updatePlan(initial());
		expect(created).toMatchObject({ status: "accepted", actualRevision: 1 });
		expect(runtime.getSnapshot()).toMatchObject({ revision: 1, goal: "Implement M14" });

		const updated = await runtime.updatePlan({
			...initial(1),
			reason: "work_started",
			tasks: [
				{ id: "contract", title: "Define contract v2", status: "active", matchHints: ["schema"] },
				{
					id: "runtime",
					title: "Implement runtime",
					status: "pending",
					dependsOn: ["contract"],
					matchHints: ["runtime"],
				},
			],
		});
		expect(updated).toMatchObject({ status: "accepted", actualRevision: 2 });

		const stale = await runtime.updatePlan({ ...initial(1), reason: "plan_changed" });
		expect(stale).toMatchObject({
			status: "revision_conflict",
			expectedRevision: 1,
			actualRevision: 2,
		});
		expect(runtime.getSnapshot()?.revision).toBe(2);
	});

	it("serializes concurrent updates so only one expectedRevision wins", async () => {
		const runtime = new DynamicTaskRuntime({ sessionManager: SessionManager.inMemory("/repo") });
		await runtime.updatePlan(initial());
		const update = (title: string) =>
			runtime.updatePlan({
				...initial(1),
				reason: "plan_changed",
				tasks: [
					{ id: "contract", title, status: "active" },
					{ id: "runtime", title: "Implement runtime", status: "pending", dependsOn: ["contract"] },
				],
			});
		const results = await Promise.all([update("Contract A"), update("Contract B")]);
		expect(results.map((result) => result.status).sort()).toEqual(["accepted", "revision_conflict"]);
		expect(runtime.getSnapshot()?.revision).toBe(2);
	});

	it("rebases stale Coordinator updates across asynchronous facts without losing progress", async () => {
		const manager = SessionManager.inMemory("/repo");
		const runtime = new DynamicTaskRuntime({ sessionManager: manager, now: () => 10 });
		await runtime.updatePlan(initial());
		await runtime.recordFact({
			id: "tool:sudo-1:completed",
			kind: "tool",
			ref: "sudo-1",
			status: "succeeded",
			summary: "privileged_exec completed",
			taskId: "contract",
		});
		await runtime.recordFact({
			id: "monitor:mon-1:running",
			kind: "monitor",
			ref: "mon-1",
			status: "running",
			summary: "Privilege monitor running",
			taskId: "contract",
		});
		await runtime.recordFact({
			id: "monitor:mon-1:stalled",
			kind: "monitor",
			ref: "mon-1",
			status: "stalled",
			summary: "Privilege monitor stalled",
			taskId: "contract",
		});
		expect(runtime.getSnapshot()?.revision).toBe(4);
		expect(runtime.getSnapshot()?.tasks[0]).toMatchObject({
			id: "contract",
			status: "blocked",
			activity: "Privilege monitor stalled",
			blockedBy: ["Privilege monitor stalled"],
			evidence: ["tool:sudo-1:completed", "monitor:mon-1:running", "monitor:mon-1:stalled"],
		});

		const unchanged = await runtime.updatePlan({ ...initial(1), reason: "work_started" });
		expect(unchanged).toMatchObject({ status: "no_change", expectedRevision: 1, actualRevision: 4 });
		expect(runtime.getSnapshot()?.tasks[0]).toMatchObject({
			status: "blocked",
			activity: "Privilege monitor stalled",
			blockedBy: ["Privilege monitor stalled"],
			evidence: ["tool:sudo-1:completed", "monitor:mon-1:running", "monitor:mon-1:stalled"],
		});

		const completed = await runtime.updatePlan({
			...initial(1),
			reason: "work_started",
			tasks: [
				{
					id: "contract",
					title: "Define contract",
					status: "completed",
					matchHints: ["schema"],
					activity: "Coordinator confirmed completion",
				},
				{
					id: "runtime",
					title: "Implement runtime",
					status: "pending",
					dependsOn: ["contract"],
					matchHints: ["runtime"],
				},
			],
		});
		expect(completed).toMatchObject({ status: "accepted", expectedRevision: 1, actualRevision: 5 });
		expect(runtime.getSnapshot()?.tasks[0]).toMatchObject({
			status: "completed",
			activity: "Coordinator confirmed completion",
			blockedBy: [],
			evidence: ["tool:sudo-1:completed", "monitor:mon-1:running", "monitor:mon-1:stalled"],
		});

		const restored = new DynamicTaskRuntime({ sessionManager: manager, now: () => 20 });
		await restored.recordFact({
			id: "monitor:mon-2:healthy",
			kind: "monitor",
			ref: "mon-2",
			status: "healthy",
			summary: "Second monitor healthy",
			taskId: "runtime",
		});
		const restoredRebase = await restored.updatePlan({
			...initial(5),
			reason: "work_started",
			tasks: [
				{ id: "contract", title: "Define contract", status: "completed", matchHints: ["schema"] },
				{
					id: "runtime",
					title: "Implement runtime",
					status: "completed",
					dependsOn: ["contract"],
					matchHints: ["runtime"],
				},
			],
		});
		expect(restoredRebase).toMatchObject({ status: "accepted", expectedRevision: 5, actualRevision: 7 });
		expect(restored.getSnapshot()?.tasks[1]).toMatchObject({
			status: "completed",
			evidence: ["monitor:mon-2:healthy"],
		});
	});

	it("keeps main structure updates separate from reviewer state patches", async () => {
		const runtime = new DynamicTaskRuntime({ sessionManager: SessionManager.inMemory("/repo"), now: () => 10 });
		await runtime.updatePlan(initial());
		await runtime.updatePlan({
			...initial(1),
			reason: "work_started",
			tasks: [
				{ id: "contract", title: "Define contract", status: "active", matchHints: ["schema"] },
				{
					id: "runtime",
					title: "Implement runtime",
					status: "pending",
					dependsOn: ["contract"],
					matchHints: ["runtime"],
				},
			],
		});
		await runtime.recordFact({
			id: "verify:check-1:passed",
			kind: "verification",
			ref: "check-1",
			status: "passed",
			summary: "npm run check passed",
		});
		const revision = runtime.getSnapshot()!.revision;
		const reviewHash = hashDynamicTaskFacts(runtime.getSnapshot()!.facts);
		const patched = await runtime.applyReviewerPatch({
			version: 1,
			expectedRevision: revision,
			factsHash: reviewHash,
			updates: [
				{
					id: "contract",
					status: "completed",
					activity: "Contract verified",
					evidence: ["verify:check-1:passed"],
				},
			],
		});
		expect(patched.status).toBe("accepted");
		expect(runtime.getSnapshot()?.tasks[0]).toMatchObject({
			id: "contract",
			title: "Define contract",
			status: "completed",
			evidence: ["verify:check-1:passed"],
		});

		const reopen = await runtime.applyReviewerPatch({
			version: 1,
			expectedRevision: runtime.getSnapshot()!.revision,
			factsHash: reviewHash,
			updates: [{ id: "contract", status: "active" }],
		});
		expect(reopen.status).toBe("invalid");
		expect(runtime.getSnapshot()?.tasks[0]?.status).toBe("completed");

		const mainReopen = await runtime.updatePlan({
			version: 1,
			expectedRevision: runtime.getSnapshot()!.revision,
			reason: "plan_changed",
			goal: "Implement M14",
			tasks: [
				{ id: "contract", title: "Rename contract", status: "active" },
				{ id: "runtime", title: "Implement runtime", status: "pending", dependsOn: ["contract"] },
			],
		});
		expect(mainReopen.status).toBe("accepted");
		expect(runtime.getSnapshot()?.tasks[0]).toMatchObject({ title: "Rename contract", status: "active" });
	});

	it("deduplicates facts and preserves evidence through same-id main updates", async () => {
		const manager = SessionManager.inMemory("/repo");
		const runtime = new DynamicTaskRuntime({ sessionManager: manager, now: () => 10 });
		await runtime.updatePlan(initial());
		const first = await runtime.recordFact({
			id: "file:write-1:src/a.ts",
			kind: "file",
			ref: "write-1",
			status: "succeeded",
			summary: "Modified src/a.ts",
			path: "src/a.ts",
			taskId: "contract",
		});
		const duplicate = await runtime.recordFact({
			id: "file:write-1:src/a.ts",
			kind: "file",
			ref: "write-1",
			status: "succeeded",
			summary: "Modified src/a.ts",
			path: "src/a.ts",
			taskId: "contract",
		});
		expect(first.status).toBe("accepted");
		expect(duplicate.status).toBe("no_change");
		const revision = runtime.getSnapshot()!.revision;
		await runtime.updatePlan({
			...initial(revision),
			reason: "work_started",
			tasks: [
				{ id: "contract", title: "Define contract", status: "active" },
				{ id: "runtime", title: "Implement runtime", status: "pending", dependsOn: ["contract"] },
			],
		});
		expect(runtime.getSnapshot()?.tasks[0]?.evidence).toEqual(["file:write-1:src/a.ts"]);
	});

	it("auto-activates the best pending mutation task and completes only an explicitly matched verification task", async () => {
		const runtime = new DynamicTaskRuntime({ sessionManager: SessionManager.inMemory("/repo"), now: () => 20 });
		await runtime.updatePlan({
			version: 1,
			expectedRevision: 0,
			reason: "initial_plan",
			goal: "Update authentication",
			tasks: [
				{ id: "inspect", title: "Inspect authentication", status: "completed" },
				{
					id: "implement",
					title: "Implement authentication changes",
					status: "pending",
					dependsOn: ["inspect"],
					matchHints: ["src/auth/session.ts"],
				},
				{
					id: "verify",
					title: "Run authentication verification",
					status: "pending",
					dependsOn: ["implement"],
					matchHints: ["npm run check"],
				},
			],
		});
		await runtime.noteToolStarted({
			toolCallId: "edit-1",
			toolName: "edit",
			args: { path: "src/auth/session.ts" },
			workspaceMutation: true,
			verification: false,
		});
		expect(runtime.getSnapshot()?.tasks.find((task) => task.id === "implement")?.status).toBe("active");
		await runtime.noteToolFinished({
			toolCallId: "edit-1",
			toolName: "edit",
			status: "success",
			filesModified: ["src/auth/session.ts"],
			verification: false,
		});
		const implemented = runtime.getSnapshot()?.tasks.find((task) => task.id === "implement");
		expect(implemented?.status).toBe("active");
		expect(implemented?.evidence).toContain("file:edit-1:src/auth/session.ts");

		await runtime.updatePlan({
			version: 1,
			expectedRevision: runtime.getSnapshot()!.revision,
			reason: "work_started",
			goal: "Update authentication",
			tasks: [
				{ id: "inspect", title: "Inspect authentication", status: "completed" },
				{ id: "implement", title: "Implement authentication changes", status: "completed" },
				{
					id: "verify",
					title: "Run authentication verification",
					status: "pending",
					dependsOn: ["implement"],
					matchHints: ["npm run check"],
				},
			],
		});
		await runtime.noteToolStarted({
			toolCallId: "check-1",
			toolName: "bash",
			args: { command: "npm run check" },
			workspaceMutation: false,
			verification: true,
		});
		await runtime.noteToolFinished({
			toolCallId: "check-1",
			toolName: "bash",
			status: "success",
			verification: true,
		});
		expect(runtime.getSnapshot()?.tasks.find((task) => task.id === "verify")?.status).toBe("completed");
		expect(runtime.getSnapshot()?.tasks.find((task) => task.id === "implement")?.status).toBe("completed");
	});

	it("keeps unmatched mutations and verifications as global facts without changing arbitrary Tasks", async () => {
		const runtime = new DynamicTaskRuntime({ sessionManager: SessionManager.inMemory("/repo"), now: () => 25 });
		await runtime.updatePlan({
			version: 1,
			expectedRevision: 0,
			reason: "initial_plan",
			goal: "Update authentication",
			tasks: [
				{ id: "implement", title: "Update authentication", status: "pending", matchHints: ["src/auth.ts"] },
				{ id: "verify", title: "Verify authentication", status: "pending", matchHints: ["npm run auth:test"] },
			],
		});
		await runtime.noteToolStarted({
			toolCallId: "unmatched-write",
			toolName: "write",
			args: { path: "notes/unrelated.txt" },
			workspaceMutation: true,
			verification: false,
		});
		expect(runtime.getSnapshot()?.tasks.map((task) => task.status)).toEqual(["pending", "pending"]);
		await runtime.noteToolFinished({
			toolCallId: "unmatched-check",
			toolName: "bash",
			status: "success",
			verification: true,
		});
		expect(runtime.getSnapshot()?.tasks.map((task) => task.status)).toEqual(["pending", "pending"]);
	});

	it("deduplicates repeated Tool lifecycle events", async () => {
		const runtime = new DynamicTaskRuntime({ sessionManager: SessionManager.inMemory("/repo"), now: () => 26 });
		await runtime.updatePlan({
			...initial(),
			tasks: [{ id: "runtime", title: "Implement runtime", status: "active", matchHints: ["runtime.ts"] }],
		});
		const started = await runtime.noteToolStarted({
			toolCallId: "edit-repeat",
			toolName: "edit",
			args: { path: "runtime.ts" },
			workspaceMutation: true,
			verification: false,
		});
		const duplicateStart = await runtime.noteToolStarted({
			toolCallId: "edit-repeat",
			toolName: "edit",
			args: { path: "runtime.ts" },
			workspaceMutation: true,
			verification: false,
		});
		expect(duplicateStart).toMatchObject({ status: "no_change", actualRevision: started.actualRevision });
		const finished = await runtime.noteToolFinished({
			toolCallId: "edit-repeat",
			toolName: "edit",
			status: "success",
			filesModified: ["runtime.ts"],
			verification: false,
		});
		const duplicateFinish = await runtime.noteToolFinished({
			toolCallId: "edit-repeat",
			toolName: "edit",
			status: "success",
			filesModified: ["runtime.ts"],
			verification: false,
		});
		expect(duplicateFinish).toMatchObject({ status: "no_change", actualRevision: finished.actualRevision });
		expect(runtime.getSnapshot()?.tasks[0]?.evidence).toEqual(
			expect.arrayContaining([
				"tool:edit-repeat:started",
				"tool:edit-repeat:success",
				"file:edit-repeat:runtime.ts",
			]),
		);
	});

	it("matches stable Workflow, Background, and Monitor facts to intended Tasks", async () => {
		const runtime = new DynamicTaskRuntime({ sessionManager: SessionManager.inMemory("/repo"), now: () => 27 });
		await runtime.updatePlan({
			version: 1,
			expectedRevision: 0,
			reason: "initial_plan",
			goal: "Track runtime work",
			tasks: [
				{ id: "workflow", title: "Run workflow", status: "active", matchHints: ["wf-1 node-a"] },
				{ id: "background", title: "Run worker", status: "pending", matchHints: ["bg-1 worker"] },
				{ id: "monitor", title: "Watch server", status: "active", matchHints: ["mon-1 server"] },
			],
		});
		await runtime.noteWorkflow({
			workflowId: "wf-1",
			nodeId: "node-a",
			status: "completed",
			summary: "wf-1 node-a completed",
		});
		await runtime.noteBackground({ taskId: "bg-1", status: "running", summary: "bg-1 worker running" });
		await runtime.noteBackground({ taskId: "bg-1", status: "completed", summary: "bg-1 worker completed" });
		await runtime.noteMonitor({ monitorId: "mon-1", status: "stalled", summary: "mon-1 server stalled" });
		const snapshot = runtime.getSnapshot()!;
		expect(snapshot.tasks.map((task) => task.status)).toEqual(["completed", "completed", "blocked"]);
		expect(snapshot.facts.map((fact) => fact.id)).toEqual(
			expect.arrayContaining([
				"workflow:wf-1:node-a:completed",
				"background:bg-1:running",
				"background:bg-1:completed",
				"monitor:mon-1:stalled",
			]),
		);
		const revision = snapshot.revision;
		await runtime.noteMonitor({ monitorId: "mon-1", status: "stalled", summary: "new duplicate summary" });
		expect(runtime.getSnapshot()?.revision).toBe(revision);
	});

	it("records ordinary failures as evidence without automatically failing the whole implementation task", async () => {
		const runtime = new DynamicTaskRuntime({ sessionManager: SessionManager.inMemory("/repo"), now: () => 30 });
		await runtime.updatePlan({
			...initial(),
			tasks: [
				{
					id: "runtime",
					title: "Implement runtime",
					status: "active",
					matchHints: ["src/runtime.ts"],
				},
			],
		});
		await runtime.noteToolStarted({
			toolCallId: "write-fail",
			toolName: "write",
			args: { path: "src/runtime.ts" },
			workspaceMutation: true,
			verification: false,
		});
		await runtime.noteToolFinished({
			toolCallId: "write-fail",
			toolName: "write",
			status: "failed",
			verification: false,
			diagnostic: "permission denied",
		});
		const task = runtime.getSnapshot()?.tasks.find((item) => item.status === "active");
		expect(task?.status).toBe("active");
		expect(task?.evidence).toContain("tool:write-fail:failed");
	});

	it("validates Reviewer facts hash and requires current evidence for completion", async () => {
		const runtime = new DynamicTaskRuntime({ sessionManager: SessionManager.inMemory("/repo"), now: () => 35 });
		await runtime.updatePlan({
			...initial(),
			tasks: [{ id: "runtime", title: "Implement runtime", status: "active" }],
		});
		await runtime.recordFact({
			id: "verify:runtime:passed",
			kind: "verification",
			ref: "runtime",
			status: "passed",
			summary: "Runtime verification passed",
		});
		const snapshot = runtime.getSnapshot()!;
		const hash = hashDynamicTaskFacts(snapshot.facts);
		expect(
			await runtime.applyReviewerPatch({
				version: 1,
				expectedRevision: snapshot.revision,
				factsHash: "f".repeat(64),
				updates: [{ id: "runtime", status: "completed", evidence: ["verify:runtime:passed"] }],
			}),
		).toMatchObject({ status: "invalid", diagnostics: [{ code: "facts_hash_mismatch" }] });
		expect(
			await runtime.applyReviewerPatch({
				version: 1,
				expectedRevision: snapshot.revision,
				factsHash: hash,
				updates: [{ id: "runtime", status: "completed" }],
			}),
		).toMatchObject({ status: "invalid", diagnostics: [{ code: "completion_new_evidence_required" }] });
		expect(
			await runtime.applyReviewerPatch({
				version: 1,
				expectedRevision: snapshot.revision,
				factsHash: hash,
				updates: [{ id: "runtime", status: "completed", evidence: ["verify:runtime:passed"] }],
			}),
		).toMatchObject({ status: "accepted" });
	});

	it("discards stale Reviewer patches with a revision-conflict notice instead of overwriting Coordinator structure", async () => {
		let releaseReview!: (result: TaskReviewResult) => void;
		let reviewInput: TaskReviewInput | undefined;
		const reviewer: TaskReviewer = {
			review: async (input) => {
				reviewInput = input;
				return await new Promise<TaskReviewResult>((resolve) => {
					releaseReview = resolve;
				});
			},
		};
		const notices: string[] = [];
		const runtime = new DynamicTaskRuntime({
			sessionManager: SessionManager.inMemory("/repo"),
			reviewer,
			reviewLimits: { minimumIntervalMs: 0 },
			onNotification: (notice) => {
				notices.push(notice.kind);
			},
		});
		await runtime.updatePlan(initial());
		await runtime.recordFact({
			id: "file:write-race:src/runtime.ts",
			kind: "file",
			ref: "write-race",
			status: "succeeded",
			summary: "Modified src/runtime.ts",
			path: "src/runtime.ts",
			taskId: "runtime",
		});
		const pendingReview = runtime.reviewAfterSettled(1);
		await Promise.resolve();
		expect(reviewInput?.expectedRevision).toBe(runtime.getSnapshot()?.revision);
		const revision = runtime.getSnapshot()!.revision;
		await runtime.updatePlan({
			...initial(revision),
			reason: "plan_changed",
			tasks: [
				{ id: "contract", title: "Define revised contract", status: "active" },
				{ id: "runtime", title: "Implement runtime", status: "pending", dependsOn: ["contract"] },
			],
		});
		releaseReview({
			status: "completed",
			expectedRevision: reviewInput!.expectedRevision,
			factsHash: reviewInput!.factsHash,
			inputTruncated: false,
			patch: {
				version: 1,
				expectedRevision: reviewInput!.expectedRevision,
				factsHash: reviewInput!.factsHash,
				updates: [
					{
						id: "runtime",
						status: "completed",
						evidence: ["file:write-race:src/runtime.ts"],
					},
				],
			},
		});

		const review = await pendingReview;
		expect(review?.status).toBe("revision_conflict");
		expect(notices).toEqual(["revision_conflict"]);
		expect(runtime.getSnapshot()?.tasks[0]).toMatchObject({ title: "Define revised contract", status: "active" });
		expect(runtime.getSnapshot()?.tasks[1]?.status).toBe("pending");
	});

	it("restores review boundaries and performs zero duplicate calls for an unchanged facts hash", async () => {
		let callCount = 0;
		const reviewer: TaskReviewer = {
			review: async (input) => {
				callCount++;
				return {
					status: "unavailable",
					expectedRevision: input.expectedRevision,
					factsHash: input.factsHash,
					inputTruncated: false,
				};
			},
		};
		let now = 100;
		const manager = SessionManager.inMemory("/repo");
		const runtime = new DynamicTaskRuntime({
			sessionManager: manager,
			reviewer,
			now: () => now++,
			reviewLimits: { minimumIntervalMs: 0 },
		});
		await runtime.updatePlan(initial());
		await runtime.recordFact({
			id: "monitor:first:running",
			kind: "monitor",
			ref: "first",
			status: "running",
			summary: "First monitor running",
		});
		await runtime.reviewAfterSettled(1);
		await runtime.reviewAfterSettled(1);
		expect(callCount).toBe(1);
		expect(
			manager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === DYNAMIC_TASK_REVIEW_ENTRY_TYPE),
		).toBe(true);

		const restored = new DynamicTaskRuntime({
			sessionManager: manager,
			reviewer,
			now: () => now++,
			reviewLimits: { minimumIntervalMs: 0 },
		});
		await restored.reviewAfterSettled(2);
		expect(callCount).toBe(1);
		await restored.recordFact({
			id: "monitor:first:completed",
			kind: "monitor",
			ref: "first",
			status: "completed",
			summary: "First monitor completed",
		});
		await restored.reviewAfterSettled(3);
		expect(callCount).toBe(2);
	});

	it("rejects writes after dispose without appending snapshots", async () => {
		const manager = SessionManager.inMemory("/repo");
		const runtime = new DynamicTaskRuntime({ sessionManager: manager });
		await runtime.updatePlan(initial());
		const entryCount = manager.getBranch().length;
		runtime.dispose();
		expect(await runtime.updatePlan({ ...initial(1), reason: "plan_changed" })).toMatchObject({
			status: "invalid",
			diagnostics: [{ code: "runtime_disposed" }],
		});
		expect(
			await runtime.recordFact({
				id: "monitor:late:completed",
				kind: "monitor",
				ref: "late",
				status: "completed",
				summary: "Late monitor completion",
			}),
		).toMatchObject({ status: "invalid", diagnostics: [{ code: "runtime_disposed" }] });
		expect(manager.getBranch()).toHaveLength(entryCount);
	});

	it("keeps prompt projection bounded, evidence-aware, and structurally closed", async () => {
		const runtime = new DynamicTaskRuntime({ sessionManager: SessionManager.inMemory("/repo") });
		await runtime.updatePlan({
			...initial(),
			tasks: Array.from({ length: 16 }, (_, index) => ({
				id: `task-${index}`,
				title: `Task ${index} ${"long ".repeat(30)}`,
				status: index === 0 ? ("active" as const) : ("pending" as const),
				matchHints: index === 0 ? ["projection"] : [],
				activity: "bounded activity ".repeat(25),
			})),
		});
		await runtime.recordFact({
			id: "file:projection:src/tasks.ts",
			kind: "file",
			ref: "projection",
			status: "succeeded",
			summary: "Modified a file without projecting the complete fact history",
			path: "src/tasks.ts",
			taskId: "task-0",
		});
		const projection = runtime.getPromptProjection()!;
		expect(projection.length).toBeLessThanOrEqual(6_000);
		expect(projection).toContain("evidence file:projection:src/tasks.ts");
		expect(projection.endsWith("</dynamic_tasks>")).toBe(true);
	});

	it("aborts and discards an in-flight review when disposed", async () => {
		const manager = SessionManager.inMemory("/repo");
		const reviewer: TaskReviewer = {
			review: async (input, signal) => {
				await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
				return {
					status: "aborted",
					expectedRevision: input.expectedRevision,
					factsHash: input.factsHash,
					inputTruncated: false,
				};
			},
		};
		const runtime = new DynamicTaskRuntime({ sessionManager: manager, reviewer });
		await runtime.updatePlan(initial());
		await runtime.recordFact({
			id: "tool:pending:started",
			kind: "tool",
			ref: "pending",
			status: "started",
			summary: "Pending tool started",
		});
		const pending = runtime.reviewAfterSettled(1);
		await Promise.resolve();
		runtime.dispose();
		expect(await pending).toBeUndefined();
		expect(
			manager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === DYNAMIC_TASK_REVIEW_ENTRY_TYPE),
		).toBe(false);
	});

	it("restores only the current branch and ignores malformed or gapped snapshots", async () => {
		const manager = SessionManager.inMemory("/repo");
		const runtime = new DynamicTaskRuntime({ sessionManager: manager, now: () => 10 });
		await runtime.updatePlan(initial());
		const planLeaf = manager.getLeafId()!;
		await runtime.updatePlan({
			...initial(1),
			reason: "work_started",
			tasks: [
				{ id: "contract", title: "Define contract", status: "active" },
				{ id: "runtime", title: "Implement runtime", status: "pending", dependsOn: ["contract"] },
			],
		});
		const activeLeaf = manager.getLeafId()!;
		manager.appendCustomEntry(DYNAMIC_TASK_SNAPSHOT_ENTRY_TYPE, {
			version: 1,
			snapshot: { ...runtime.getSnapshot(), revision: 4 },
		});

		manager.branch(planLeaf);
		const branchRuntime = new DynamicTaskRuntime({ sessionManager: manager });
		expect(branchRuntime.getSnapshot()).toMatchObject({ revision: 1 });
		manager.branch(activeLeaf);
		branchRuntime.rebuild(manager.getBranch());
		expect(branchRuntime.getSnapshot()).toMatchObject({ revision: 2 });

		const restored = new DynamicTaskRuntime({ sessionManager: manager });
		expect(restored.getSnapshot()?.revision).toBe(2);
	});
});
