import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	attachDocumentRuntimeToolDetails,
	DOCUMENT_CONTRACT_ENTRY_TYPE,
	DocumentRuntime,
	type DocumentRuntimeToolDetails,
	getDocumentRuntimeToolDetails,
} from "../src/core/documents/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { TaskLedger } from "../src/core/state/task-ledger.ts";
import { createTestResourceLoader } from "./utilities.ts";

function createRuntimeProject(): { root: string; runtime: DocumentRuntime } {
	const root = join(tmpdir(), `beaupi-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, ".git"), { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), "# Rules\n- Must preserve policy behavior.\n");
	mkdirSync(join(root, "docs"), { recursive: true });
	writeFileSync(join(root, "docs", "task.md"), "# Documented Check Verification\n- Must run `npm run check`.\n");
	const resourceLoader = createTestResourceLoader();
	return {
		root,
		runtime: new DocumentRuntime({ cwd: root, agentDir: join(root, ".agent"), resourceLoader }),
	};
}

function detailsFor(
	contract: Awaited<ReturnType<DocumentRuntime["resolveTask"]>>["contract"],
): DocumentRuntimeToolDetails {
	return {
		version: 1,
		kind: "resolve_task",
		citations: contract.requirements.flatMap((requirement) => requirement.citations),
		diagnostics: contract.diagnostics,
		contract,
	};
}

describe("TaskLedger Document Runtime projection", () => {
	it("stores contract facts in branch details and deterministically associates required checks", async () => {
		const { root, runtime } = createRuntimeProject();
		try {
			const resolved = await runtime.resolveTask({ task: "run the documented check" });
			const documentDetails = detailsFor(resolved.contract);
			const ledger = new TaskLedger({ taskId: "task", cwd: root });
			ledger.handleAgentEvent({
				type: "tool_execution_start",
				toolCallId: "resolve",
				toolName: "docs_resolve_task",
				args: { task: "run the documented check" },
			});
			ledger.handleAgentEvent({
				type: "tool_execution_end",
				toolCallId: "resolve",
				toolName: "docs_resolve_task",
				result: {
					content: [{ type: "text", text: "contract" }],
					details: attachDocumentRuntimeToolDetails(undefined, documentDetails),
				},
				isError: false,
			});
			const before = ledger.getSnapshot();
			expect(before.documentContract?.contract.id).toBe(resolved.contract.id);
			expect(before.documentContract?.requiredChecks.some((check) => check.status === "pending")).toBe(true);
			expect(before.documentContract?.requiredChecks[0]?.evidenceCommandIds).toEqual([]);
			expect(
				before.documentContract?.requirements.find(
					(requirement) => requirement.text === "Must preserve policy behavior.",
				)?.projection,
			).toBe("policy");
			expect(
				before.documentContract?.requirements.find(
					(requirement) => requirement.text === "Must run `npm run check`.",
				)?.projection,
			).toBe("task");
			const requirementTodos = before.todos.filter((todo) => todo.id.startsWith("requirement:"));
			expect(requirementTodos).toHaveLength(1);
			expect(requirementTodos[0]?.label).toContain("Must run `npm run check`.");
			ledger.handleAgentEvent({
				type: "tool_execution_start",
				toolCallId: "check",
				toolName: "bash",
				args: { command: "npm run check" },
			});
			ledger.handleAgentEvent({
				type: "tool_execution_end",
				toolCallId: "check",
				toolName: "bash",
				result: { content: [{ type: "text", text: "ok" }], details: { command: "npm run check" } },
				isError: false,
			});
			const after = ledger.getSnapshot();
			expect(after.documentContract?.requiredChecks.some((check) => check.status === "completed")).toBe(true);
			expect(after.documentContract?.requiredChecks[0]?.evidenceCommandIds).toEqual(["tool:check"]);
			expect(after.documentContract?.requirements.some((requirement) => requirement.status === "completed")).toBe(
				true,
			);
			const contractTodo = after.todos.find((todo) => todo.id === "document-contract");
			expect(contractTodo?.source).toContain("AGENTS.md:");

			const policyContract = structuredClone(resolved.contract);
			const policyRequirement = policyContract.requirements.find(
				(requirement) => requirement.text === "Must preserve policy behavior.",
			)!;
			policyRequirement.requiredCheckIds = ["policy-check"];
			policyContract.requirements = [policyRequirement];
			policyContract.requiredChecks = [
				{
					id: "policy-check",
					label: "Run policy check",
					commands: ["npm run policy-check"],
					citations: policyRequirement.citations,
				},
			];
			policyContract.completionCriteria = [];
			const policyLedger = new TaskLedger({ taskId: "policy", cwd: root });
			policyLedger.setDocumentRuntimeContract(policyContract);
			const policySnapshot = policyLedger.getSnapshot();
			expect(policySnapshot.documentContract?.requiredChecks[0]?.projection).toBe("policy");
			expect(policySnapshot.todos.some((todo) => todo.id === "required-check:policy-check")).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps stale requirements blocked and does not duplicate current branch facts on restore/fork", async () => {
		const { root, runtime } = createRuntimeProject();
		try {
			const resolved = await runtime.resolveTask({ task: "run the documented check" });
			const details = detailsFor(resolved.contract);
			const manager = SessionManager.inMemory(root);
			manager.appendMessage({ role: "user", content: [{ type: "text", text: "task" }], timestamp: 1 });
			manager.appendMessage(
				fauxAssistantMessage(fauxToolCall("docs_resolve_task", { task: "task" }, { id: "resolve" }), {
					stopReason: "toolUse",
				}),
			);
			manager.appendMessage({
				role: "toolResult",
				toolCallId: "resolve",
				toolName: "docs_resolve_task",
				content: [{ type: "text", text: "contract" }],
				details: attachDocumentRuntimeToolDetails(undefined, details),
				isError: false,
				timestamp: 2,
			});
			manager.appendCustomEntry(DOCUMENT_CONTRACT_ENTRY_TYPE, attachDocumentRuntimeToolDetails(undefined, details));
			const restored = new TaskLedger({ taskId: "restored", cwd: root, entries: manager.getBranch() }).getSnapshot();
			expect(restored.documentContract?.contract.id).toBe(resolved.contract.id);
			expect(restored.documentContract?.requirements.length).toBe(resolved.contract.requirements.length);
			const stale = { ...resolved.contract, status: "stale" as const, staleReasons: ["AGENTS.md changed"] };
			const staleLedger = new TaskLedger({ taskId: "stale", cwd: root });
			staleLedger.recordDocumentRuntimeDetails("resolve", { ...details, contract: stale });
			const staleSnapshot = staleLedger.getSnapshot();
			expect(staleSnapshot.documentContract?.stale).toBe(true);
			expect(staleSnapshot.todos.some((todo) => todo.status === "blocked")).toBe(true);
			expect(getDocumentRuntimeToolDetails(attachDocumentRuntimeToolDetails(undefined, details))?.contract?.id).toBe(
				resolved.contract.id,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
