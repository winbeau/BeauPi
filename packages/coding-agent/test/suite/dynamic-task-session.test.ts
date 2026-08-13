import { existsSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../../src/core/sdk.ts";
import { getDynamicTaskReviewEntry } from "../../src/core/tasks/dynamic-task-runtime.ts";
import { DYNAMIC_TASK_REVIEW_ENTRY_TYPE, DYNAMIC_TASK_SNAPSHOT_ENTRY_TYPE } from "../../src/core/tasks/types.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

describe("Dynamic Task AgentSession integration", () => {
	it("requests initial planning in the existing first provider turn and persists the Tool snapshot", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let firstSystemPrompt = "";
		let secondSystemPrompt = "";
		let secondUserText = "";
		let firstTools: string[] = [];
		harness.setResponses([
			(context) => {
				firstSystemPrompt = context.systemPrompt ?? "";
				firstTools = context.tools?.map((tool) => tool.name) ?? [];
				return fauxAssistantMessage(
					fauxToolCall("tasks_update", {
						version: 1,
						expectedRevision: 0,
						reason: "initial_plan",
						goal: "Implement the requested change",
						tasks: [
							{ id: "inspect", title: "Inspect the implementation", status: "pending" },
							{
								id: "implement",
								title: "Implement the change",
								status: "pending",
								dependsOn: ["inspect"],
							},
							{
								id: "verify",
								title: "Run verification",
								status: "pending",
								dependsOn: ["implement"],
							},
						],
					}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				secondSystemPrompt = context.systemPrompt ?? "";
				secondUserText = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message))
					.join("\n");
				return fauxAssistantMessage("Plan created.");
			},
		]);

		await harness.session.prompt("Implement the dynamic task runtime");

		expect(harness.faux.state.callCount).toBe(2);
		expect(firstTools).toContain("tasks_update");
		expect(secondSystemPrompt).toBe(firstSystemPrompt);
		expect(firstSystemPrompt).not.toContain("<dynamic_tasks");
		expect(secondSystemPrompt).not.toContain("<dynamic_tasks");
		expect(secondUserText).not.toContain("<dynamic_tasks");
		expect(secondUserText).not.toContain("task_patch");
		expect(harness.session.dynamicTaskRuntime?.getSnapshot()).toMatchObject({ revision: 1 });
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === DYNAMIC_TASK_SNAPSHOT_ENTRY_TYPE),
		).toBe(true);
	});

	it("auto-activates the matching pending Task before the first Write without blocking the mutation", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const outputPath = `${harness.tempDir}/src/runtime.ts`;
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("tasks_update", {
					version: 1,
					expectedRevision: 0,
					reason: "initial_plan",
					goal: "Implement runtime",
					tasks: [
						{ id: "inspect", title: "Inspect runtime", status: "completed" },
						{
							id: "implement",
							title: "Implement runtime",
							status: "pending",
							dependsOn: ["inspect"],
							matchHints: ["src/runtime.ts"],
						},
					],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("write", { path: outputPath, content: "export const ok = true;\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done."),
		]);

		await harness.session.prompt("Implement the runtime file");

		expect(existsSync(outputPath)).toBe(true);
		const task = harness.session.dynamicTaskRuntime?.getSnapshot()?.tasks.find((item) => item.id === "implement");
		expect(task?.status).toBe("active");
		expect(task?.evidence).toContain(
			`file:${harness.session.taskLedger.getSnapshot().commands[1]?.toolCallId}:${outputPath}`,
		);
	});

	it("runs one bounded shared-model review after settlement and keeps reviewer text out of the main conversation", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.settingsManager.applyOverrides({ review: { model: harness.getModel().id } });
		const outputPath = `${harness.tempDir}/reviewed.ts`;
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("tasks_update", {
					version: 1,
					expectedRevision: 0,
					reason: "initial_plan",
					goal: "Implement reviewed file",
					tasks: [
						{ id: "implement", title: "Implement reviewed file", status: "pending", matchHints: ["reviewed.ts"] },
					],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("write", { path: outputPath, content: "export const reviewed = true;\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Implementation finished."),
			(context) => {
				const reviewInput = context.messages.map((message) => getMessageText(message)).join("\n");
				const material = reviewInput.match(/<task_review_input>([\s\S]*?)<\/task_review_input>/)?.[1] ?? "{}";
				const payload = JSON.parse(material) as {
					expectedRevision?: number;
					factsHash?: string;
					facts?: Array<{ id?: string; kind?: string }>;
				};
				const evidence = payload.facts?.find((fact) => fact.kind === "file")?.id ?? "";
				return fauxAssistantMessage(
					`<task_patch>{"version":1,"expectedRevision":${payload.expectedRevision ?? 0},"factsHash":"${payload.factsHash ?? ""}","updates":[{"id":"implement","status":"completed","activity":"Reviewed deterministic file evidence","evidence":["${evidence}"]}]}</task_patch>`,
				);
			},
		]);

		await harness.session.prompt("Implement the reviewed file");

		expect(harness.faux.state.callCount).toBe(4);
		const review = harness.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "custom" && entry.customType === DYNAMIC_TASK_REVIEW_ENTRY_TYPE
					? [getDynamicTaskReviewEntry(entry.data)]
					: [],
			)
			.filter((entry) => entry !== undefined)
			.at(-1);
		expect(review?.status, JSON.stringify(review)).toBe("completed");
		expect(harness.session.dynamicTaskRuntime?.getSnapshot()?.tasks[0]).toMatchObject({ status: "completed" });
		expect(harness.session.messages.map((message) => getMessageText(message)).join("\n")).not.toContain("task_patch");
		expect(harness.session.messages.map((message) => getMessageText(message)).join("\n")).not.toContain(
			"Reviewed deterministic file evidence",
		);

		harness.setResponses([fauxAssistantMessage("No new work facts.")]);
		await harness.session.prompt("What is the current plan revision?");
		expect(harness.faux.state.callCount).toBe(5);
	});

	it("keeps the current plan through Compact and session resume", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("tasks_update", {
					version: 1,
					expectedRevision: 0,
					reason: "initial_plan",
					goal: "Persist dynamic plan",
					tasks: [{ id: "persist", title: "Persist dynamic plan", status: "pending" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Plan persisted."),
		]);
		await harness.session.prompt("Create a persistent implementation plan");
		expect(harness.session.dynamicTaskRuntime?.getSnapshot()?.revision).toBe(1);
		harness.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 1 } });
		harness.setResponses([fauxAssistantMessage("Compact summary")]);
		await harness.session.compact();
		expect(harness.session.dynamicTaskRuntime?.getSnapshot()?.revision).toBe(1);

		const manager = harness.sessionManager;
		harness.session.dispose();
		const { session: resumed } = await createAgentSession({
			cwd: harness.tempDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
			sessionManager: manager,
			settingsManager: harness.settingsManager,
		});
		try {
			expect(resumed.dynamicTaskRuntime?.getSnapshot()).toMatchObject({ revision: 1, goal: "Persist dynamic plan" });
			let resumedPrompt = "";
			harness.setResponses([
				(context) => {
					resumedPrompt = context.systemPrompt ?? "";
					return fauxAssistantMessage("Resumed.");
				},
			]);
			await resumed.prompt("Report current progress");
			expect(resumedPrompt).not.toContain("<dynamic_tasks");
			const runtimeBeforeReload = resumed.dynamicTaskRuntime;
			await resumed.reload();
			expect(resumed.dynamicTaskRuntime).toBe(runtimeBeforeReload);
			expect(resumed.dynamicTaskRuntime?.getSnapshot()).toMatchObject({ goal: "Persist dynamic plan" });
		} finally {
			resumed.dispose();
		}
	});

	it("injects blocked Reviewer state once as next-turn custom context rather than system history", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.settingsManager.applyOverrides({ review: { model: harness.getModel().id } });
		const outputPath = `${harness.tempDir}/blocked.ts`;
		let nextTurnNotice = "";
		let nextTurnSystemPrompt = "";
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("tasks_update", {
					version: 1,
					expectedRevision: 0,
					reason: "initial_plan",
					goal: "Handle a blocked task",
					tasks: [{ id: "blocked-work", title: "Handle blocked work", status: "active" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("write", { path: outputPath, content: "export const blocked = true;\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Work attempted."),
			(context) => {
				const input = context.messages.map((message) => getMessageText(message)).join("\n");
				const revision = Number(input.match(/"expectedRevision":(\d+)/)?.[1]);
				const factsHash = input.match(/"factsHash":"([a-f0-9]{64})"/)?.[1] ?? "";
				return fauxAssistantMessage(
					`<task_patch>{"version":1,"expectedRevision":${revision},"factsHash":"${factsHash}","updates":[{"id":"blocked-work","status":"blocked","activity":"Waiting for dependency","blockedBy":["dependency unavailable"]}]}</task_patch>`,
				);
			},
		]);
		await harness.session.prompt("Attempt the blocked work");
		expect(harness.session.dynamicTaskRuntime?.getSnapshot()?.tasks[0]?.status).toBe("blocked");

		harness.setResponses([
			(context) => {
				nextTurnSystemPrompt = context.systemPrompt ?? "";
				nextTurnNotice = context.messages.map((message) => getMessageText(message)).join("\n");
				return fauxAssistantMessage("I will resolve the blocker.");
			},
		]);
		await harness.session.prompt("Continue");
		expect(nextTurnNotice).toContain("blocked-work (blocked)");
		expect(nextTurnSystemPrompt).not.toContain("Dynamic Tasks need attention");
	});

	it("does not request or create a plan for pure question answering", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let systemPrompt = "";
		harness.setResponses([
			(context) => {
				systemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("TypeScript is a typed superset of JavaScript.");
			},
		]);

		await harness.session.prompt("What is TypeScript?");

		expect(harness.faux.state.callCount).toBe(1);
		expect(systemPrompt).not.toContain('<dynamic_tasks required="initial_plan">');
		expect(harness.session.dynamicTaskRuntime?.getSnapshot()).toBeUndefined();
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === DYNAMIC_TASK_SNAPSHOT_ENTRY_TYPE),
		).toBe(false);
	});
});
