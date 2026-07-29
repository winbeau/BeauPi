import { mkdirSync, writeFileSync } from "node:fs";
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

function setupNoisyRules(harness: Harness): void {
	writeFileSync(
		`${harness.tempDir}/AGENTS.md`,
		[
			"# Rules",
			"- Read files in full before wide-ranging changes.",
			"- Check node_modules for external API types; don't guess.",
			"- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.",
			"- Do not preserve backward compatibility unless the user asks for it.",
			"- Never hardcode key checks.",
		].join("\n"),
	);
	mkdirSync(`${harness.tempDir}/docs`, { recursive: true });
	writeFileSync(
		`${harness.tempDir}/docs/task.md`,
		"# Task Requirements\n- Must keep the task-specific requirement visible in the Tasks panel.\n",
	);
	writeFileSync(
		`${harness.tempDir}/README.md`,
		[
			"# Project",
			"## Permissions & Containerization",
			"- Plain Docker: run the whole process in a local container for simple isolation.",
			"- OpenShell: run the whole process in a policy-controlled sandbox.",
			"## Development",
			"```bash",
			"npm run build",
			"npm run check",
			"```",
			"## Supply-chain hardening",
			"- Release smoke tests use `npm run release:local` before tagging.",
		].join("\n"),
	);
	writeFileSync(
		`${harness.tempDir}/package.json`,
		JSON.stringify({
			scripts: { clean: "npm run clean --workspaces", build: "npm run build", check: "npm run lint" },
		}),
	);
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

	it("does not project generic policy requirements as Todos across Session branch rebuild", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		setupNoisyRules(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("Keep the task-specific requirement visible in the Tasks panel.");

		const genericRules = [
			"Read files in full before wide-ranging changes.",
			"Check node_modules for external API types; don't guess.",
			"Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.",
			"Do not preserve backward compatibility unless the user asks for it.",
			"Never hardcode key checks.",
		];
		expect(harness.session.systemPrompt).toContain("Never hardcode key checks.");
		const snapshot = harness.session.taskLedger.getSnapshot();
		const requirements = snapshot.documentContract?.requirements ?? [];
		const todos = snapshot.todos.map((todo) => todo.label);
		const policyRequirements = requirements.filter((requirement) => genericRules.includes(requirement.text));
		expect(policyRequirements).toHaveLength(genericRules.length);
		for (const requirement of policyRequirements) expect(requirement.projection).toBe("policy");
		expect(
			requirements.find((requirement) => requirement.text.startsWith("Must keep the task-specific"))?.projection,
		).toBe("task");
		for (const rule of genericRules) expect(todos).not.toContain(`Requirement: ${rule}`);
		for (const genericRequirement of [
			"Plain Docker: run the whole process in a local container for simple isolation.",
			"OpenShell: run the whole process in a policy-controlled sandbox.",
			"Release smoke tests use `npm run release:local` before tagging.",
		]) {
			expect(requirements.map((requirement) => requirement.text)).not.toContain(genericRequirement);
			expect(todos).not.toContain(`Requirement: ${genericRequirement}`);
		}
		const requiredCheckCommands = snapshot.documentContract?.requiredChecks.flatMap((check) => check.commands) ?? [];
		for (const genericCheck of ["npm run clean --workspaces", "npm run build", "npm run lint"]) {
			expect(requiredCheckCommands).not.toContain(genericCheck);
		}
		expect(todos).toContain("Requirement: Must keep the task-specific requirement visible in the Tasks panel.");

		const restored = new TaskLedger({
			taskId: harness.session.sessionId,
			cwd: harness.tempDir,
			entries: harness.sessionManager.getBranch(),
		}).getSnapshot();
		const restoredTodos = restored.todos.map((todo) => todo.label);
		for (const rule of genericRules) expect(restoredTodos).not.toContain(`Requirement: ${rule}`);
		expect(restoredTodos).toContain(
			"Requirement: Must keep the task-specific requirement visible in the Tasks panel.",
		);
	});

	it("does not project broad explicitly injected requirement docs as fresh-session Todos", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		mkdirSync(`${harness.tempDir}/docs/beaupi`, { recursive: true });
		writeFileSync(
			`${harness.tempDir}/docs/beaupi/requirements.md`,
			[
				"# Core Requirements",
				"- Original commands and complete output must be collapsed by default and expandable on demand.",
				"- Skill guidance remains workflow knowledge; deterministic structured or permissioned behavior must be a Tool.",
				"- Model polling must set a minimum interval, maximum attempts, and token budget.",
			].join("\n"),
		);
		writeFileSync(
			`${harness.tempDir}/docs/beaupi/skills.md`,
			[
				"# M4-R3 Skill Allowlist",
				"- Skill allowlist policy must match Skill names and keep deny after allow.",
				"# M5",
				"- Agent Pool creation must wait for the next milestone.",
			].join("\n"),
		);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt(
			[
				"Implement M4-R3 Skill allowlist projection with allow and deny policy. Read docs/beaupi/requirements.md and docs/beaupi/skills.md.",
				"Tasks · discover ·  · contract active",
				"  □ Requirement: Original commands and complete output must be collapsed by default and expandable on demand.",
				"  … +21 pending, 1 completed",
			].join("\n"),
		);

		const snapshot = harness.session.taskLedger.getSnapshot();
		const requirements = snapshot.documentContract?.requirements.map((requirement) => requirement.text) ?? [];
		const todos = snapshot.todos.map((todo) => todo.label);
		expect(requirements).toContain("Skill allowlist policy must match Skill names and keep deny after allow.");
		for (const unrelatedRequirement of [
			"Original commands and complete output must be collapsed by default and expandable on demand.",
			"Skill guidance remains workflow knowledge; deterministic structured or permissioned behavior must be a Tool.",
			"Model polling must set a minimum interval, maximum attempts, and token budget.",
			"Agent Pool creation must wait for the next milestone.",
		]) {
			expect(requirements).not.toContain(unrelatedRequirement);
			expect(todos).not.toContain(`Requirement: ${unrelatedRequirement}`);
		}
		expect(todos).toContain("Requirement: Skill allowlist policy must match Skill names and keep deny after allow.");
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
