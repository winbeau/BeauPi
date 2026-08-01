import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { calculateAgentConcurrencyLimit } from "../src/core/agents/index.ts";
import { execCommand } from "../src/core/exec.ts";
import { MonitorRuntime } from "../src/core/monitor/index.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { type WorkflowDefinition, WorkflowRuntime } from "../src/core/workflow/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

interface Coordinator {
	harness: Harness;
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
}

const coordinators: Coordinator[] = [];

afterEach(() => {
	while (coordinators.length > 0) {
		const item = coordinators.pop();
		item?.session.dispose();
		item?.harness.cleanup();
	}
});

async function createCoordinator(maxConcurrency = 4): Promise<Coordinator> {
	const harness = await createHarness();
	const result = await createAgentSession({
		cwd: harness.tempDir,
		model: harness.getModel(),
		modelRuntime: harness.session.modelRuntime,
		resourceLoader: harness.session.resourceLoader,
		sessionManager: SessionManager.inMemory(harness.tempDir),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		agentPool: { maxConcurrency },
	});
	const coordinator = { harness, session: result.session };
	coordinators.push(coordinator);
	return coordinator;
}

function definition(nodes: WorkflowDefinition["nodes"], maxConcurrency = 4): WorkflowDefinition {
	return { version: 1, id: "test-workflow", maxConcurrency, nodes };
}

describe("WorkflowRuntime", () => {
	it("runs dependencies and conditions while passing only structured dependency outputs", async () => {
		const { harness, session } = await createCoordinator();
		let dependentContext = "";
		harness.setResponses([
			fauxAssistantMessage("dependency-ready"),
			(context) => {
				dependentContext = context.messages
					.map((message) => (message.role === "user" ? JSON.stringify(message.content) : ""))
					.join("\n");
				return fauxAssistantMessage("dependent-done");
			},
		]);
		const snapshot = await session.workflowRuntime!.run({
			workflow: definition([
				{ id: "inspect", profile: "reviewer", task: "Inspect", writePolicy: "none" },
				{
					id: "review",
					profile: "reviewer",
					task: "Review",
					dependsOn: ["inspect"],
					condition: 'deps.inspect.output.summary == "dependency-ready"',
					writePolicy: "none",
				},
			]),
		});
		expect(snapshot.status).toBe("completed");
		expect(snapshot.nodes.map((node) => node.status)).toEqual(["completed", "completed"]);
		expect(dependentContext).toContain('<workflow_dependencies version=\\"1\\">');
		expect(dependentContext).toContain("dependency-ready");
		expect(snapshot.nodes[0]?.output).not.toHaveProperty("messages");
	});

	it("runs read-only nodes in parallel and serializes shared writers", async () => {
		const { harness, session } = await createCoordinator();
		let active = 0;
		let maxObserved = 0;
		const delayed = (summary: string) => async () => {
			active++;
			maxObserved = Math.max(maxObserved, active);
			await new Promise((resolve) => setTimeout(resolve, 20));
			active--;
			return fauxAssistantMessage(summary);
		};
		harness.setResponses([delayed("one"), delayed("two")]);
		const parallel = await session.workflowRuntime!.run({
			workflow: definition(
				[
					{ id: "one", profile: "reviewer", task: "One", writePolicy: "none" },
					{ id: "two", profile: "reviewer", task: "Two", writePolicy: "none" },
				],
				2,
			),
		});
		expect(parallel.status).toBe("completed");
		expect(maxObserved).toBe(Math.min(2, calculateAgentConcurrencyLimit()));

		active = 0;
		maxObserved = 0;
		harness.setResponses([delayed("writer-one"), delayed("writer-two")]);
		const shared = await session.workflowRuntime!.run({
			workflow: definition(
				[
					{ id: "writer-one", profile: "implementer", task: "One", writePolicy: "shared" },
					{ id: "writer-two", profile: "implementer", task: "Two", writePolicy: "shared" },
				],
				2,
			),
		});
		expect(shared.status).toBe("completed");
		expect(maxObserved).toBe(1);

		active = 0;
		maxObserved = 0;
		harness.setResponses([delayed("reader"), delayed("writer")]);
		const conflicting = await session.workflowRuntime!.run({
			workflow: definition(
				[
					{ id: "reader", profile: "reviewer", task: "Read", writePolicy: "none" },
					{ id: "writer", profile: "implementer", task: "Write", writePolicy: "shared" },
				],
				2,
			),
		});
		expect(conflicting.status).toBe("completed");
		expect(maxObserved).toBe(1);

		active = 0;
		maxObserved = 0;
		harness.setResponses([delayed("workflow-one"), delayed("workflow-two")]);
		const separate = await Promise.all([
			session.workflowRuntime!.run({
				workflow: definition([
					{ id: "writer-one", profile: "implementer", task: "Write one", writePolicy: "shared" },
				]),
			}),
			session.workflowRuntime!.run({
				workflow: definition([
					{ id: "writer-two", profile: "implementer", task: "Write two", writePolicy: "shared" },
				]),
			}),
		]);
		expect(separate.every((workflow) => workflow.status === "completed")).toBe(true);
		expect(maxObserved).toBe(1);
	});

	it("handles failure, skip, timeout, Workflow cancellation, and duplicate cancellation deterministically", async () => {
		const { harness, session } = await createCoordinator();
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "failed node" })]);
		const failed = await session.workflowRuntime!.run({
			workflow: definition([
				{
					id: "fail",
					profile: "reviewer",
					task: "Fail",
					writePolicy: "none",
					failurePolicy: "continue",
				},
				{
					id: "skip",
					profile: "reviewer",
					task: "Skip",
					dependsOn: ["fail"],
					condition: "all_succeeded",
					writePolicy: "none",
				},
			]),
		});
		expect(failed.status).toBe("failed");
		expect(failed.nodes.map((node) => node.status)).toEqual(["failed", "skipped"]);

		const worktreeFailure = await session.workflowRuntime!.run({
			workflow: definition([{ id: "isolated", profile: "implementer", task: "Write", writePolicy: "isolated" }]),
		});
		expect(worktreeFailure).toMatchObject({
			status: "failed",
			nodes: [{ status: "failed", error: { code: "workflow_node_error" } }],
		});
		expect(worktreeFailure.nodes[0]?.error?.message).toContain("requires a Git repository");

		harness.setResponses([
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 30));
				return fauxAssistantMessage("late");
			},
		]);
		const timedOut = await session.workflowRuntime!.run({
			workflow: definition([
				{ id: "timeout", profile: "reviewer", task: "Timeout", writePolicy: "none", timeoutMs: 5 },
			]),
		});
		expect(timedOut.nodes[0]?.status).toBe("timed_out");

		let childStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			childStarted = resolve;
		});
		harness.setResponses([
			async () => {
				childStarted();
				await new Promise((resolve) => setTimeout(resolve, 50));
				return fauxAssistantMessage("cancelled");
			},
		]);
		const running = session.workflowRuntime!.run({
			workflow: definition([{ id: "wait", profile: "reviewer", task: "Wait", writePolicy: "none" }]),
		});
		await started;
		expect(
			session.taskLedger.getSnapshot().workflows.filter((workflow) => workflow.status === "running"),
		).toMatchObject([{ status: "running", nodes: [{ status: "running" }] }]);
		expect(
			session.taskLedger
				.getSnapshot()
				.todos.some((todo) => todo.id.includes("workflow:") && todo.status === "active"),
		).toBe(true);
		const workflowId = session.workflowRuntime!.list().find((workflow) => workflow.status === "running")!.workflowId;
		const cancellation = await session.workflowRuntime!.cancelWorkflow(workflowId);
		const cancelled = await running;
		expect(cancellation).toMatchObject({ accepted: true, reason: "cancel_requested" });
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.nodes[0]?.status).toBe("cancelled");
		await expect(session.workflowRuntime!.cancelWorkflow(workflowId)).resolves.toMatchObject({
			accepted: false,
			reason: "already_terminal",
		});
	});

	it("marks unconfirmed running Workflow monitors lost after restore instead of guessing success", async () => {
		const { harness, session } = await createCoordinator();
		let childStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			childStarted = resolve;
		});
		harness.setResponses([
			async () => {
				childStarted();
				await new Promise((resolve) => setTimeout(resolve, 50));
				return fauxAssistantMessage("late");
			},
		]);
		const running = session.workflowRuntime!.run({
			workflow: definition([{ id: "wait", profile: "reviewer", task: "Wait", writePolicy: "none" }]),
		});
		await started;
		const restored = new MonitorRuntime({
			sessionId: session.sessionId,
			cwd: harness.tempDir,
			sessionManager: session.sessionManager,
		});
		const restoredWorkflow = new WorkflowRuntime({
			cwd: harness.tempDir,
			sessionManager: session.sessionManager,
			agentPool: session.agentPool!,
			monitorRuntime: restored,
		});
		expect(restoredWorkflow.list()).toMatchObject([{ status: "lost", nodes: [{ status: "lost" }] }]);
		await restored.initialize();
		const workflowMonitors = restored.list({ kind: "workflow" });
		expect(workflowMonitors.length).toBeGreaterThanOrEqual(2);
		expect(workflowMonitors.every((monitor) => monitor.status === "lost")).toBe(true);
		await restoredWorkflow.dispose();
		restored.dispose();
		const workflowId = session.workflowRuntime!.list().find((workflow) => workflow.status === "running")!.workflowId;
		await session.workflowRuntime!.cancelWorkflow(workflowId);
		await running;
	});

	it("uses isolated Git Worktrees and cleans them safely at Session end", async () => {
		const { harness, session } = await createCoordinator();
		writeFileSync(join(harness.tempDir, "base.txt"), "base\n");
		expect((await execCommand("git", ["init", "--initial-branch=main"], harness.tempDir)).code).toBe(0);
		expect((await execCommand("git", ["add", "base.txt"], harness.tempDir)).code).toBe(0);
		expect(
			(
				await execCommand(
					"git",
					["-c", "user.name=BeauPi Test", "-c", "user.email=beaupi@example.invalid", "commit", "-m", "initial"],
					harness.tempDir,
				)
			).code,
		).toBe(0);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "isolated.txt", content: "isolated\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("isolated complete"),
		]);
		const snapshot = await session.workflowRuntime!.run({
			workflow: definition([
				{ id: "isolated", profile: "implementer", task: "Write isolated.txt", writePolicy: "isolated" },
			]),
		});
		const worktree = snapshot.nodes[0]?.worktree;
		expect(snapshot.status).toBe("completed");
		expect(worktree).toMatchObject({ status: "active", cleanup: "session_end" });
		expect(existsSync(join(harness.tempDir, "isolated.txt"))).toBe(false);
		expect(existsSync(join(worktree!.path, "isolated.txt"))).toBe(true);
		await session.workflowRuntime!.dispose();
		expect(existsSync(worktree!.path)).toBe(false);
		const branches = await execCommand("git", ["branch", "--list", worktree!.branch], harness.tempDir);
		expect(branches.stdout.trim()).toBe("");
	});

	it("exposes Workflow and node activity through the existing Monitor Runtime", async () => {
		const { harness, session } = await createCoordinator();
		harness.setResponses([fauxAssistantMessage("monitored")]);
		const snapshot = await session.workflowRuntime!.run({
			workflow: definition([{ id: "inspect", profile: "reviewer", task: "Inspect", writePolicy: "none" }]),
		});
		const workflowMonitor = session.monitorRuntime.status(snapshot.monitorId);
		const nodeMonitor = session.monitorRuntime.status(snapshot.nodes[0]!.monitorId);
		expect(workflowMonitor).toMatchObject({ kind: "workflow", status: "completed" });
		expect(nodeMonitor).toMatchObject({ kind: "workflow", status: "completed" });
		const logs = await session.monitorRuntime.logs(snapshot.nodes[0]!.monitorId, { mode: "full" });
		expect(logs.missing).toBe(false);
		expect(logs.content).toContain("Workflow node inspect started");
		expect(logs.content).toContain("Workflow node inspect completed");
	});

	it("runs implement-review serially and parallel-review with two concurrent read-only reviewers", async () => {
		const { harness, session } = await createCoordinator();
		let active = 0;
		let maxObserved = 0;
		harness.setResponses([
			fauxAssistantMessage("implemented"),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("implemented");
				return fauxAssistantMessage("reviewed");
			},
		]);
		const serial = await session.workflowRuntime!.run({ workflow: "implement-review", task: "Change one file" });
		expect(serial.nodes.map((node) => node.id)).toEqual(["implement", "review"]);
		expect(serial.nodes.map((node) => node.status)).toEqual(["completed", "completed"]);

		const reviewer = (summary: string) => async () => {
			active++;
			maxObserved = Math.max(maxObserved, active);
			await new Promise((resolve) => setTimeout(resolve, 20));
			active--;
			return fauxAssistantMessage(summary);
		};
		harness.setResponses([reviewer("correct"), reviewer("safe")]);
		const parallel = await session.workflowRuntime!.run({ workflow: "parallel-review", task: "Review changes" });
		expect(parallel.status).toBe("completed");
		expect(maxObserved).toBe(Math.min(2, calculateAgentConcurrencyLimit()));
	});
});
