import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/index.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getWorkflowToolDetails, type WorkflowToolDetails } from "../src/core/workflow/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

interface Setup {
	harness: Harness;
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	definitions: Record<string, ToolDefinition>;
}

const setups: Setup[] = [];

afterEach(() => {
	while (setups.length > 0) {
		const setup = setups.pop();
		setup?.session.dispose();
		setup?.harness.cleanup();
	}
});

async function createSetup(): Promise<Setup> {
	const harness = await createHarness();
	const result = await createAgentSession({
		cwd: harness.tempDir,
		model: harness.getModel(),
		modelRuntime: harness.session.modelRuntime,
		resourceLoader: harness.session.resourceLoader,
		sessionManager: SessionManager.inMemory(harness.tempDir),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		agentPool: { maxConcurrency: 4 },
	});
	const definitions = Object.fromEntries(
		["workflow_run", "workflow_status", "workflow_cancel", "monitor_status", "monitor_logs"].map((name) => [
			name,
			result.session.getToolDefinition(name)!,
		]),
	);
	const setup = { harness, session: result.session, definitions };
	setups.push(setup);
	return setup;
}

async function execute(
	definition: ToolDefinition,
	params: unknown,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	return await definition.execute("workflow-tool-test", params as never, signal, undefined, {} as ExtensionContext);
}

function details(result: AgentToolResult<unknown>): WorkflowToolDetails {
	const parsed = getWorkflowToolDetails(result.details);
	if (!parsed) throw new Error("Missing Workflow Tool details");
	return parsed;
}

describe("workflow_* Tools", () => {
	it("adds Workflow construction constraints to the system prompt", async () => {
		const setup = await createSetup();
		const prompt = setup.session.systemPrompt;

		expect(prompt).toContain(
			"put background only at the workflow_run top level next to workflow, never inside the Workflow object",
		);
		expect(prompt).toContain("Workflow and node ids must match ^[A-Za-z][A-Za-z0-9_-]*$");
		expect(prompt).toContain("dots are invalid");
		expect(prompt).toContain("Put timeoutMs on the Workflow node itself, not in budget");
		expect(prompt).toContain("budget accepts only maxTokens and maxTurns");
		expect(prompt).toContain("never send an empty budget object");
	});

	it("returns versioned run/status/cancel details and idempotent duplicate cancellation", async () => {
		const setup = await createSetup();
		setup.harness.setResponses([fauxAssistantMessage("done")]);
		const run = await execute(setup.definitions.workflow_run!, {
			workflow: {
				id: "tool-run",
				nodes: [{ id: "inspect", task: "Inspect", writePolicy: "none" }],
			},
		});
		const runDetails = details(run);
		expect(runDetails).toMatchObject({ version: 1, operation: "workflow_run", ok: true });
		expect(runDetails.workflow?.status).toBe("completed");
		const workflowId = runDetails.workflow!.workflowId;

		const status = details(await execute(setup.definitions.workflow_status!, { workflowId }));
		expect(status).toMatchObject({ operation: "workflow_status", ok: true, workflow: { workflowId } });
		const list = details(await execute(setup.definitions.workflow_status!, {}));
		expect(list.workflows).toHaveLength(1);
		const monitorStatus = await execute(setup.definitions.monitor_status!, {
			monitorId: runDetails.workflow!.nodes[0]!.monitorId,
		});
		expect(monitorStatus.details).toMatchObject({
			operation: "monitor_status",
			monitor: { kind: "workflow", status: "completed" },
		});
		const monitorLogs = await execute(setup.definitions.monitor_logs!, {
			monitorId: runDetails.workflow!.nodes[0]!.monitorId,
			mode: "full",
		});
		expect(monitorLogs.content[0]?.type === "text" ? monitorLogs.content[0].text : "").toContain(
			"Workflow node inspect",
		);
		const cancel = details(await execute(setup.definitions.workflow_cancel!, { workflowId }));
		expect(cancel).toMatchObject({
			operation: "workflow_cancel",
			ok: true,
			cancel: { accepted: false, reason: "already_terminal" },
		});
	});

	it("starts background Workflows without waiting for the DAG to finish", async () => {
		const setup = await createSetup();
		let childStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			childStarted = resolve;
		});
		setup.harness.setResponses([
			async () => {
				childStarted();
				await new Promise((resolve) => setTimeout(resolve, 100));
				return fauxAssistantMessage("late");
			},
		]);

		const run = details(
			await execute(setup.definitions.workflow_run!, {
				workflow: { id: "background-run", nodes: [{ id: "wait", task: "Wait" }] },
				background: true,
			}),
		);
		expect(run).toMatchObject({ ok: true, workflow: { status: "running" } });
		await started;
		const workflowId = run.workflow!.workflowId;
		expect(details(await execute(setup.definitions.workflow_status!, { workflowId }))).toMatchObject({
			ok: true,
			workflow: { status: "running", nodes: [{ agentId: `${workflowId}:wait`, status: "running" }] },
		});
		expect(details(await execute(setup.definitions.workflow_cancel!, { workflowId }))).toMatchObject({
			ok: true,
			workflow: { status: "cancelled" },
		});

		setup.harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "background provider failure" }),
		]);
		const failedRun = details(
			await execute(setup.definitions.workflow_run!, {
				workflow: { id: "background-failure", nodes: [{ id: "fail", task: "Fail" }] },
				background: true,
			}),
		);
		await setup.session.monitorRuntime.wait(failedRun.workflow!.monitorId, 1_000);
		expect(
			details(await execute(setup.definitions.workflow_status!, { workflowId: failedRun.workflow!.workflowId })),
		).toMatchObject({ ok: true, workflow: { status: "failed", nodes: [{ status: "failed" }] } });
	});

	it("returns structured validation/not-found errors and cancels workflow_run through AbortSignal", async () => {
		const setup = await createSetup();
		const invalid = details(
			await execute(setup.definitions.workflow_run!, {
				workflow: {
					version: 1,
					id: "invalid",
					nodes: [{ id: "node", profile: "missing", task: "No", writePolicy: "none" }],
				},
			}),
		);
		expect(invalid).toMatchObject({ ok: false, error: { code: "profile_not_found" } });
		expect(invalid.error?.message).toContain("reviewer, researcher, implementer");
		expect(invalid.error?.message).toContain("Omit agent/profile");
		expect(details(await execute(setup.definitions.workflow_status!, { workflowId: "missing" }))).toMatchObject({
			ok: false,
			error: { code: "workflow_not_found" },
		});
		expect(details(await execute(setup.definitions.workflow_cancel!, { workflowId: "missing" }))).toMatchObject({
			ok: false,
			cancel: { accepted: false, reason: "workflow_not_found" },
		});

		let childStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			childStarted = resolve;
		});
		setup.harness.setResponses([
			async () => {
				childStarted();
				await new Promise((resolve) => setTimeout(resolve, 50));
				return fauxAssistantMessage("late");
			},
		]);
		const controller = new AbortController();
		const running = execute(
			setup.definitions.workflow_run!,
			{
				workflow: {
					version: 1,
					id: "abort",
					nodes: [{ id: "wait", profile: "reviewer", task: "Wait", writePolicy: "none" }],
				},
			},
			controller.signal,
		);
		await started;
		controller.abort();
		const cancelled = details(await running);
		expect(cancelled).toMatchObject({
			operation: "workflow_run",
			ok: false,
			workflow: { status: "cancelled", nodes: [{ status: "cancelled" }] },
		});
	});
});
