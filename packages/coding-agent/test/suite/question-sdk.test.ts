import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionInteractionRequest } from "../../src/core/question.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const params = {
	questions: [
		{
			question: "Choose a target",
			header: "Target",
			options: [
				{ label: "A", description: "Use A" },
				{ label: "B", description: "Use B" },
			],
			multiSelect: false,
		},
	],
};

describe("ask_user_question SDK integration", () => {
	const harnesses: Harness[] = [];
	const sessions: Array<{ dispose(): void }> = [];

	afterEach(() => {
		while (sessions.length > 0) sessions.pop()?.dispose();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("accepts a custom in-process handler and advertises focused prompt guidance", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const handler = vi.fn(async (request: QuestionInteractionRequest) => ({
			status: "answered" as const,
			answers: [{ header: request.questions[0].header, selectedLabels: [request.questions[0].options[1].label] }],
		}));
		const created = await createAgentSession({
			cwd: harness.tempDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
			sessionManager: SessionManager.inMemory(harness.tempDir),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
			questionHandler: handler,
			agentPool: false,
		});
		sessions.push(created.session);
		harness.setResponses([
			(context) => {
				expect(context.tools?.map((tool) => tool.name)).toContain("ask_user_question");
				expect(context.systemPrompt).toContain("Use ask_user_question only when a user decision is required");
				expect(context.systemPrompt).toContain("Never use ask_user_question to request passwords");
				return fauxAssistantMessage(fauxToolCall("ask_user_question", params), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);

		await created.session.prompt("Choose");
		expect(handler).toHaveBeenCalledOnce();
		const result = created.session.messages.find((message) => message.role === "toolResult");
		expect(result?.role === "toolResult" ? result.details : undefined).toMatchObject({
			status: "answered",
			answers: [{ header: "Target", selectedLabels: ["B"] }],
		});
	});

	it("can be explicitly excluded from an SDK session", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const created = await createAgentSession({
			cwd: harness.tempDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
			sessionManager: SessionManager.inMemory(harness.tempDir),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
			excludeTools: ["ask_user_question"],
			agentPool: false,
		});
		sessions.push(created.session);
		expect(created.session.getToolDefinition("ask_user_question")).toBeUndefined();
		expect(created.session.getActiveToolNames()).not.toContain("ask_user_question");
	});

	it("does not read stdin or hang when the SDK host omits a handler", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const created = await createAgentSession({
			cwd: harness.tempDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
			sessionManager: SessionManager.inMemory(harness.tempDir),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
			agentPool: false,
		});
		sessions.push(created.session);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ask_user_question", params), { stopReason: "toolUse" }),
			fauxAssistantMessage("Cannot ask interactively in this host."),
		]);

		await created.session.prompt("Choose");
		const result = created.session.messages.find((message) => message.role === "toolResult");
		expect(result?.role === "toolResult" ? result.details : undefined).toMatchObject({
			status: "interaction_required",
		});
	});
});
