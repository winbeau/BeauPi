import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { getWorkflowToolDetails } from "../../src/core/workflow/index.ts";
import { createHarness, type Harness } from "./harness.ts";

interface Created {
	harness: Harness;
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
}

const created: Created[] = [];
const harnesses = new Set<Harness>();

async function createWorkflowSession(harnessInput?: Harness, sessionManager?: SessionManager): Promise<Created> {
	const harness = harnessInput ?? (await createHarness());
	const result = await createAgentSession({
		cwd: harness.tempDir,
		model: harness.getModel(),
		modelRuntime: harness.session.modelRuntime,
		resourceLoader: harness.session.resourceLoader,
		sessionManager: sessionManager ?? SessionManager.inMemory(harness.tempDir),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		agentPool: { maxConcurrency: 4 },
	});
	const item = { harness, session: result.session };
	created.push(item);
	harnesses.add(harness);
	return item;
}

afterEach(() => {
	while (created.length > 0) created.pop()?.session.dispose();
	for (const harness of harnesses) harness.cleanup();
	harnesses.clear();
});

describe("M11 Workflow AgentSession lifecycle", () => {
	it("registers Workflow Tools, persists structured results, and restores only current-branch facts across Compact/resume", async () => {
		const harness = await createHarness();
		const { session } = await createWorkflowSession(harness);
		await session.dynamicTaskRuntime?.updatePlan({
			version: 1,
			expectedRevision: 0,
			reason: "initial_plan",
			goal: "Run session workflow",
			tasks: [
				{
					id: "workflow",
					title: "Run session workflow",
					status: "active",
					matchHints: ["session-workflow"],
				},
			],
		});
		expect(session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["workflow_run", "workflow_status", "workflow_cancel"]),
		);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("workflow_run", {
					workflow: {
						version: 1,
						id: "session-workflow",
						nodes: [{ id: "inspect", profile: "reviewer", task: "Inspect", writePolicy: "none" }],
					},
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("child complete"),
			fauxAssistantMessage("coordinator complete"),
		]);
		await session.prompt("Run the Workflow");
		const result = session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "workflow_run",
		);
		expect(result?.role).toBe("toolResult");
		const workflow = result?.role === "toolResult" ? getWorkflowToolDetails(result.details)?.workflow : undefined;
		expect(workflow).toMatchObject({ status: "completed", definitionId: "session-workflow" });
		expect(workflow?.nodes[0]?.output).not.toHaveProperty("messages");
		expect(session.taskLedger.getSnapshot().workflows).toHaveLength(1);
		expect(session.taskLedger.getSnapshot().todos.some((todo) => todo.id.includes("workflow:"))).toBe(true);
		const dynamicWorkflowTask = session.dynamicTaskRuntime
			?.getSnapshot()
			?.tasks.find((task) => task.id === "workflow");
		expect(dynamicWorkflowTask?.status).toBe("completed");
		expect(
			dynamicWorkflowTask?.evidence.some((id) => id.startsWith(`workflow:${workflow?.workflowId}:inspect:`)),
		).toBe(true);

		const originalLeaf = session.sessionManager.getLeafId()!;
		const userEntry = session.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "user")!;
		await session.navigateTree(userEntry.id, { summarize: false });
		expect(session.taskLedger.getSnapshot().workflows).toHaveLength(0);
		expect(session.workflowRuntime!.list()).toHaveLength(0);
		await session.navigateTree(originalLeaf, { summarize: false });
		expect(session.taskLedger.getSnapshot().workflows).toHaveLength(1);
		expect(session.workflowRuntime!.list()).toHaveLength(1);

		harness.setResponses([fauxAssistantMessage("Workflow compact summary")]);
		session.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 1 } });
		await session.compact();
		expect(session.taskLedger.getSnapshot().workflows).toHaveLength(1);

		const manager = session.sessionManager;
		session.dispose();
		const resumed = await createWorkflowSession(harness, manager);
		expect(resumed.session.taskLedger.getSnapshot().workflows).toHaveLength(1);
		expect(resumed.session.workflowRuntime!.list()[0]).toMatchObject({ status: "completed" });
	});

	it("keeps Workflow Tools out of controlled child Tool and Skill/Profile boundaries", async () => {
		const harness = await createHarness();
		const { session } = await createWorkflowSession(harness);
		let childTools: string[] = [];
		harness.setResponses([
			(context) => {
				childTools = context.tools?.map((tool) => tool.name) ?? [];
				return fauxAssistantMessage("bounded child");
			},
		]);
		const child = await session.agentPool!.delegateTask({ task: "Inspect boundaries", profile: "reviewer" });
		expect(child.status).toBe("completed");
		expect(childTools).not.toEqual(
			expect.arrayContaining([
				"delegate_task",
				"ask_user_question",
				"workflow_run",
				"workflow_status",
				"workflow_cancel",
			]),
		);
		await expect(
			session.workflowRuntime!.run({
				workflow: {
					version: 1,
					id: "invalid-profile",
					nodes: [{ id: "node", profile: "missing", task: "No", writePolicy: "none" }],
				},
			}),
		).rejects.toMatchObject({ code: "profile_not_found" });
	});
});
