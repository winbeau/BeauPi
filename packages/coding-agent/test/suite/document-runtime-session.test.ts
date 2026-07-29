import { writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getDocumentRuntimeToolDetails } from "../../src/core/documents/index.ts";
import { TaskLedger } from "../../src/core/state/task-ledger.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function setupRules(harness: Harness): string {
	const path = `${harness.tempDir}/AGENTS.md`;
	writeFileSync(path, "# Rules\n- Must run `npm run check`.\n# Completion\n- All documented checks must pass.\n");
	return path;
}

describe("AgentSession Document Runtime integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("automatically resolves a contract into the existing system prompt and Task Ledger", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const rulesPath = setupRules(harness);
		let providerSystemPrompt = "";
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("run the documented check");

		expect(providerSystemPrompt).toContain("<execution_contract>");
		expect(providerSystemPrompt).toContain("Must run `npm run check`");
		expect(providerSystemPrompt).toContain("AGENTS.md:");
		expect(harness.session.taskLedger.getSnapshot().documentContract?.contract.documents[0]?.path).toBe(rulesPath);
		expect(harness.session.taskLedger.getSnapshot().todos.some((todo) => todo.id === "document-contract")).toBe(true);
	});

	it("removes stale contract constraints after a file mutation and rebuilds after restoration", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const rulesPath = setupRules(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("write", { path: rulesPath, content: "# Rules\n- Must run a different check.\n" }),
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("changed"),
		]);
		await harness.session.prompt("update the document");
		expect(harness.session.taskLedger.getSnapshot().documentContract?.stale).toBe(true);
		expect(harness.session.systemPrompt).not.toContain("<execution_contract>");

		writeFileSync(
			rulesPath,
			"# Rules\n- Must run `npm run check`.\n# Completion\n- All documented checks must pass.\n",
		);
		harness.setResponses([fauxAssistantMessage("restored")]);
		await harness.session.prompt("continue the documented task");
		expect(harness.session.taskLedger.getSnapshot().documentContract?.stale).toBe(false);
		expect(harness.session.systemPrompt).toContain("<execution_contract>");
	});

	it("records docs_read facts and reattaches contract details after an extension replacement", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role === "toolResult" && event.message.toolName === "docs_resolve_task") {
							return { message: { ...event.message, details: undefined } };
						}
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		setupRules(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("docs_resolve_task", { task: "run the documented check" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("resolved"),
		]);
		await harness.session.prompt("resolve documents");
		const resultEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(resultEntry?.type).toBe("message");
		if (resultEntry?.type !== "message" || resultEntry.message.role !== "toolResult") return;
		expect(getDocumentRuntimeToolDetails(resultEntry.message.details)?.contract).toBeDefined();

		const readPath = `${harness.tempDir}/README.md`;
		writeFileSync(readPath, "# Read me\ncontent\n");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("docs_read", { document: readPath, heading: "Read me" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("read"),
		]);
		await harness.session.prompt("read the local document");
		const snapshot = harness.session.taskLedger.getSnapshot();
		expect(snapshot.filesRead.map((record) => record.path)).toContain(readPath);
		expect(getMessageText(harness.session.messages.at(-1))).toBe("read");

		const restored = new TaskLedger({
			taskId: harness.session.sessionId,
			cwd: harness.tempDir,
			entries: harness.sessionManager.getBranch(),
		}).getSnapshot();
		expect(restored.documentContract?.contract.id).toBe(snapshot.documentContract?.contract.id);
	});
});
