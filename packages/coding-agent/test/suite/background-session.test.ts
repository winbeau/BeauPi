import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { getBackgroundToolDetails } from "../../src/core/background/index.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const created: Array<{ session: Awaited<ReturnType<typeof createAgentSession>>["session"]; harness: Harness }> = [];

afterEach(() => {
	while (created.length > 0) {
		const item = created.pop()!;
		item.session.dispose();
		item.harness.cleanup();
	}
});

function assistantTexts(session: Awaited<ReturnType<typeof createAgentSession>>["session"]): string[] {
	return session.messages.filter((message) => message.role === "assistant").map((message) => getMessageText(message));
}

async function createCoordinator(harness: Harness, options: { tools?: string[]; customTools?: AgentTool[] } = {}) {
	const result = await createAgentSession({
		cwd: harness.tempDir,
		model: harness.getModel(),
		modelRuntime: harness.session.modelRuntime,
		resourceLoader: harness.session.resourceLoader,
		sessionManager: SessionManager.inMemory(harness.tempDir),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		agentPool: { maxConcurrency: 2 },
		tools: options.tools,
		customTools: options.customTools,
	});
	const item = { session: result.session, harness };
	created.push(item);
	return item.session;
}

describe("M12 Background AgentSession integration", () => {
	it("registers Background Tools and wakes an idle Coordinator through the existing Session message path", async () => {
		const harness = await createHarness();
		const session = await createCoordinator(harness);
		expect(session.getActiveToolNames()).toEqual(
			expect.arrayContaining([
				"background_start",
				"background_attach",
				"background_status",
				"background_logs",
				"background_wait",
				"background_cancel",
			]),
		);
		let taskId = "";
		const wakeStarted = new Promise<void>((resolve) => {
			const unsubscribe = session.subscribe((event) => {
				if (
					event.type === "message_start" &&
					event.message.role === "custom" &&
					event.message.customType === "beaupi.background.wake"
				) {
					unsubscribe();
					resolve();
				}
			});
		});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("background_start", {
					executable: process.execPath,
					args: ["-e", "setTimeout(() => process.stdout.write('wake me\\n'), 35)"],
					goal: "wake after process completion",
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				const result = context.messages.find(
					(message) => message.role === "toolResult" && message.toolName === "background_start",
				);
				if (result?.role === "toolResult") taskId = getBackgroundToolDetails(result.details)?.task?.id ?? "";
				return fauxAssistantMessage(fauxToolCall("background_wait", { taskId }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("waiting"),
			fauxAssistantMessage("process completed; continue the task"),
		]);
		await session.prompt("Start and wait for the background process");
		expect(taskId).toMatch(/^bg-/);
		for (let attempt = 0; attempt < 100; attempt++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
			await session.backgroundRuntime.poll();
			if (session.backgroundRuntime.get(taskId)?.status === "completed") break;
		}
		await wakeStarted;
		await session.waitForIdle();
		expect(assistantTexts(session)).toContain("process completed; continue the task");
		expect(
			session.messages.some(
				(message) => message.role === "custom" && message.customType === "beaupi.background.wake",
			),
		).toBe(true);
	});

	it("queues a real Background wake as existing AgentSession follow-up while Coordinator is busy", async () => {
		let release!: () => void;
		const waitPromise = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait_for_background",
			label: "Wait",
			description: "Hold the current turn",
			parameters: Type.Object({}, { additionalProperties: false }),
			execute: async () => {
				await waitPromise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const names = [
			"wait_for_background",
			"background_start",
			"background_attach",
			"background_status",
			"background_logs",
			"background_wait",
			"background_cancel",
		];
		const harness = await createHarness();
		const session = await createCoordinator(harness, { tools: names, customTools: [waitTool] });
		const task = await session.backgroundRuntime.start({
			executable: process.execPath,
			args: ["-e", "setTimeout(() => {}, 30)"],
			goal: "busy wake",
		});
		await session.backgroundRuntime.wait(task.id, [{ type: "completed" }]);
		const started = new Promise<void>((resolve) => {
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait_for_background") {
					unsubscribe();
					resolve();
				}
			});
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait_for_background", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			fauxAssistantMessage("follow-up wake handled"),
		]);
		const prompt = session.prompt("Keep the Coordinator busy");
		await started;
		for (let attempt = 0; attempt < 100; attempt++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
			await session.backgroundRuntime.poll();
			if (session.backgroundRuntime.get(task.id)?.status === "completed") break;
		}
		release();
		await prompt;
		expect(assistantTexts(session)).toContain("follow-up wake handled");
		expect(session.getFollowUpMessages()).toHaveLength(0);
	});

	it("rebuilds only the current branch Background facts and reattaches when switching back", async () => {
		const harness = await createHarness();
		const session = await createCoordinator(harness);
		harness.setResponses([fauxAssistantMessage("base branch")]);
		await session.prompt("Create a branch anchor");
		const task = await session.backgroundRuntime.start({
			executable: process.execPath,
			args: ["-e", "setTimeout(() => {}, 1000)"],
			goal: "branch-aware task",
		});
		await session.backgroundRuntime.wait(task.id);
		const originalLeaf = session.sessionManager.getLeafId()!;
		const userEntry = session.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "user")!;
		await session.navigateTree(userEntry.id, { summarize: false });
		expect(session.backgroundRuntime.list({ includeTerminal: true })).toHaveLength(0);
		expect(session.taskLedger.getSnapshot().todos.some((todo) => todo.id.startsWith("background:"))).toBe(false);
		await session.navigateTree(originalLeaf, { summarize: false });
		expect(session.backgroundRuntime.get(task.id)).toMatchObject({ id: task.id, status: "healthy" });
		await session.backgroundRuntime.cancel(task.id, 0);
	});

	it("reuses the faux AgentPool reviewer with bounded input and zero calls for unchanged logs", async () => {
		const harness = await createHarness();
		const session = await createCoordinator(harness);
		let reviewerPrompt = "";
		harness.setResponses([
			(context) => {
				reviewerPrompt = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message))
					.join("\n");
				return fauxAssistantMessage(
					'<progress_review>{"version":1,"state":"progressing","summary":"bounded progress","shouldWakeCoordinator":false}</progress_review>',
				);
			},
		]);
		const task = await session.backgroundRuntime.start({
			executable: process.execPath,
			args: [
				"-e",
				"setTimeout(() => process.stdout.write('x'.repeat(1000) + '\\n'), 20); setTimeout(() => {}, 250)",
			],
			goal: "review bounded progress",
			triggers: [{ type: "progress-review" }],
			progressReview: {
				enabled: true,
				minimumIntervalMs: 1,
				maxReviews: 1,
				maxInputCharacters: 256,
				timeoutMs: 1000,
				maxOutputTokens: 128,
			},
		});
		await session.backgroundRuntime.wait(task.id);
		for (let attempt = 0; attempt < 100 && harness.faux.state.callCount === 0; attempt++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
			await session.backgroundRuntime.poll();
		}
		expect(harness.faux.state.callCount).toBe(1);
		expect(reviewerPrompt).toContain("review bounded progress");
		expect(reviewerPrompt).not.toContain("x".repeat(300));
		await session.backgroundRuntime.poll();
		expect(harness.faux.state.callCount).toBe(1);
		await session.backgroundRuntime.cancel(task.id, 0);
	});

	it("does not expose Background Tools to controlled child Agents", async () => {
		const harness = await createHarness();
		const session = await createCoordinator(harness);
		let childTools: string[] = [];
		harness.setResponses([
			(context) => {
				childTools = context.tools?.map((tool) => tool.name) ?? [];
				return fauxAssistantMessage("bounded");
			},
		]);
		const result = await session.agentPool!.delegateTask({
			task: "Inspect the child tool boundary",
			profile: "reviewer",
		});
		expect(result.status).toBe("completed");
		expect(childTools).not.toEqual(
			expect.arrayContaining(["background_start", "background_wait", "background_cancel"]),
		);
	});
});
