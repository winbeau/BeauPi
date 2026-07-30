import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AskUserQuestionInput } from "../../src/core/question.ts";
import { TaskLedger } from "../../src/core/state/task-ledger.ts";
import { createHarness, type Harness } from "./harness.ts";

function question(header: string, labels: [string, string]): AskUserQuestionInput {
	return {
		questions: [
			{
				question: `Choose ${header}`,
				header,
				options: labels.map((label) => ({ label, description: `Use ${label}` })),
				multiSelect: false,
			},
		],
	};
}

describe("ask_user_question session lifecycle", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("round-trips multiple same-turn questions sequentially through messages, Task Ledger, branches, and compaction", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		const calls: string[] = [];
		let active = 0;
		let maxActive = 0;
		harness.session.setQuestionInteractionHandler(async (request) => {
			active++;
			maxActive = Math.max(maxActive, active);
			calls.push(request.questions[0].header);
			const pending = harness.session.taskLedger
				.getSnapshot()
				.todos.find((todo) => todo.id === `interaction:${request.requestId}`);
			expect(pending).toMatchObject({ status: "blocked", owner: "user", source: "ask_user_question" });
			await Promise.resolve();
			active--;
			return {
				status: "answered",
				answers: [
					{
						header: request.questions[0].header,
						selectedLabels: [request.questions[0].options[0].label],
					},
				],
			};
		});
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("ask_user_question", question("Library", ["React", "Vue"]), { id: "ask-library" }),
					fauxToolCall("ask_user_question", question("Scope", ["Agent", "TUI"]), { id: "ask-scope" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Proceeding with the selected answers."),
		]);

		await harness.session.prompt("Decide implementation details");

		expect(calls).toEqual(["Library", "Scope"]);
		expect(maxActive).toBe(1);
		const toolResults = harness.session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "ask_user_question",
		);
		expect(toolResults).toHaveLength(2);
		for (const result of toolResults) {
			if (result.role !== "toolResult") continue;
			expect(result.details).toMatchObject({ version: 1, status: "answered" });
			expect(result.details).toHaveProperty("taskLedger");
		}
		const completedSnapshot = harness.session.taskLedger.getSnapshot();
		expect(completedSnapshot.interactions.map((interaction) => interaction.answerSummaries[0])).toEqual([
			"Library: React",
			"Scope: Agent",
		]);
		expect(completedSnapshot.todos.some((todo) => todo.id.startsWith("interaction:"))).toBe(false);

		const originalLeafId = harness.session.sessionManager.getLeafId();
		const firstResultEntry = harness.session.sessionManager
			.getBranch()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "ask_user_question",
			);
		expect(firstResultEntry).toBeDefined();
		await harness.session.navigateTree(firstResultEntry!.id, { summarize: false });
		expect(harness.session.taskLedger.getSnapshot().interactions).toHaveLength(1);
		await harness.session.navigateTree(originalLeafId!, { summarize: false });
		expect(harness.session.taskLedger.getSnapshot().interactions).toHaveLength(2);

		harness.setResponses([fauxAssistantMessage("## Goal\nPreserve the question decisions.")]);
		await harness.session.compact();
		const restoredLedger = new TaskLedger({
			taskId: harness.session.sessionId,
			cwd: harness.session.sessionManager.getCwd(),
			entries: harness.session.sessionManager.getBranch(),
		});
		expect(restoredLedger.getSnapshot().interactions).toHaveLength(2);
	});
});
