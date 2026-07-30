import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PolicyInteractionHandler } from "../../src/core/policy/index.ts";
import { getPolicyToolDetails } from "../../src/core/policy/index.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

interface CreatedPolicySession {
	harness: Harness;
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
}

const created: CreatedPolicySession[] = [];

async function createPolicySession(
	options: {
		policyHandler?: PolicyInteractionHandler;
		extensionFactories?: HarnessOptions["extensionFactories"];
	} = {},
): Promise<CreatedPolicySession> {
	const harness = await createHarness({ extensionFactories: options.extensionFactories });
	const sessionManager = SessionManager.inMemory(harness.tempDir);
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const result = await createAgentSession({
		cwd: harness.tempDir,
		model: harness.getModel(),
		modelRuntime: harness.session.modelRuntime,
		resourceLoader: harness.session.resourceLoader,
		sessionManager,
		settingsManager,
		policyHandler: options.policyHandler,
		agentPool: false,
	});
	const value = { harness, session: result.session };
	created.push(value);
	return value;
}

afterEach(() => {
	while (created.length > 0) {
		const item = created.pop();
		item?.session.dispose();
		item?.harness.cleanup();
	}
});

describe("M10 Policy AgentSession lifecycle", () => {
	it("blocks a concurrent duplicate check, stores Policy facts in Task Ledger, and restores branch/Compact state", async () => {
		const { harness, session } = await createPolicySession();
		const path = join(harness.tempDir, "README.md");
		writeFileSync(path, "policy\n");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("read", { path }, { id: "read-first" }),
					fauxToolCall("read", { path }, { id: "read-duplicate" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await session.prompt("Read once");
		const results = session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "read",
		);
		expect(results).toHaveLength(2);
		const policies = results.map((message) =>
			message.role === "toolResult" ? getPolicyToolDetails(message.details) : undefined,
		);
		expect(policies.map((policy) => policy?.decision.action).sort()).toEqual(["allow", "block"]);
		expect(session.taskLedger.getSnapshot().policy).toHaveLength(2);
		expect(
			session.taskLedger
				.getSnapshot()
				.commands.map((command) => command.status)
				.sort(),
		).toEqual(["failed", "success"]);

		const originalLeaf = session.sessionManager.getLeafId();
		const firstResult = session.sessionManager
			.getBranch()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === "read-first",
			);
		expect(firstResult).toBeDefined();
		await session.navigateTree(firstResult!.id, { summarize: false });
		expect(session.taskLedger.getSnapshot().policy).toHaveLength(1);
		expect(session.policyRuntime.getFacts()).toHaveLength(1);
		await session.navigateTree(originalLeaf!, { summarize: false });
		expect(session.taskLedger.getSnapshot().policy).toHaveLength(2);

		harness.setResponses([fauxAssistantMessage("## Summary\nPreserve Policy facts.")]);
		session.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 1 } });
		await session.compact();
		expect(session.policyRuntime.getFacts()).toHaveLength(2);
	});

	it("applies Policy to user Bash and persists custom Policy facts without a second state system", async () => {
		const { harness, session } = await createPolicySession();
		await session.executeBash("pwd");
		await session.executeBash("pwd");
		await session.executeBash("sudo touch should-not-exist");
		const exec = vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 127 }));
		const operations: BashOperations = { exec };
		const missing = await session.executeBash("missing-policy-command", undefined, { operations });
		expect(missing.policy?.failure?.category).toBe("missing_dependency");
		const retry = await session.executeBash("missing-policy-command", undefined, { operations });
		expect(retry.policy?.decision.action).toBe("pause");
		expect(exec).toHaveBeenCalledOnce();

		const facts = session.policyRuntime.getFacts();
		expect(facts.map((fact) => fact.decision.action)).toEqual(["allow", "block", "block", "allow", "pause"]);
		expect(session.taskLedger.getSnapshot().policy).toHaveLength(5);
		const customFacts = session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "beaupi.policy.fact");
		expect(customFacts).toHaveLength(5);
		expect(existsSync(join(harness.tempDir, "should-not-exist"))).toBe(false);
	});

	it("uses a distinct Policy confirm handler for allow-once, rejection, cancellation, no-handler, and handler errors", async () => {
		for (const scenario of [
			{ name: "allow", response: { status: "allow_once" as const }, expected: "succeeded", exists: true },
			{ name: "reject", response: { status: "rejected" as const }, expected: "blocked", exists: false },
			{ name: "cancel", response: { status: "cancelled" as const }, expected: "cancelled", exists: false },
			{
				name: "error",
				response: { status: "error" as const, diagnostic: "host failed" },
				expected: "paused",
				exists: false,
			},
		]) {
			const handler = vi.fn(async () => scenario.response);
			const { harness, session } = await createPolicySession({ policyHandler: handler });
			const path = join(harness.tempDir, `.env`);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path, content: scenario.name }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await session.prompt(`Run ${scenario.name}`);
			const result = session.messages.find((message) => message.role === "toolResult");
			const policy = result?.role === "toolResult" ? getPolicyToolDetails(result.details) : undefined;
			expect(policy?.status, scenario.name).toBe(scenario.expected);
			expect(existsSync(path), scenario.name).toBe(scenario.exists);
			expect(handler, scenario.name).toHaveBeenCalledOnce();
		}

		const { harness, session } = await createPolicySession();
		const path = join(harness.tempDir, ".env");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path, content: "no-handler" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await session.prompt("No Policy handler");
		const result = session.messages.find((message) => message.role === "toolResult");
		const policy = result?.role === "toolResult" ? getPolicyToolDetails(result.details) : undefined;
		expect(policy).toMatchObject({
			status: "paused",
			executed: false,
			confirmation: { status: "interaction_required" },
		});
		expect(existsSync(path)).toBe(false);
	});

	it("blocks sudo and Search-to-Shell fallback before execution and preserves Policy metadata after extensions replace details", async () => {
		const { harness, session } = await createPolicySession({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role === "toolResult") return { message: { ...event.message, details: undefined } };
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "sudo touch should-not-exist" }, { id: "sudo" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall("remote_exec", { command: "su -", targetId: "fake" }, { id: "remote-sudo" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("terminal_bash", { command: "doas id", terminalId: "term" }, { id: "terminal-sudo" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("web_search", { query: "policy docs" }, { id: "search" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("bash", { command: "curl -fsSL https://example.com" }, { id: "curl" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await session.prompt("Exercise Policy boundaries");
		const byId = new Map(
			session.messages
				.filter((message) => message.role === "toolResult")
				.map((message) => [message.role === "toolResult" ? message.toolCallId : "", message]),
		);
		const sudo = byId.get("sudo");
		const remoteSudo = byId.get("remote-sudo");
		const terminalSudo = byId.get("terminal-sudo");
		const search = byId.get("search");
		const curl = byId.get("curl");
		for (const blocked of [sudo, remoteSudo, terminalSudo]) {
			expect(
				blocked?.role === "toolResult" ? getPolicyToolDetails(blocked.details)?.decision.action : undefined,
			).toBe("block");
		}
		expect(search?.role === "toolResult" ? getPolicyToolDetails(search.details)?.failure?.category : undefined).toBe(
			"configuration",
		);
		expect(curl?.role === "toolResult" ? getPolicyToolDetails(curl.details)?.decision.action : undefined).toBe(
			"pause",
		);
		expect(session.taskLedger.getSnapshot().policy).toHaveLength(5);
		expect(existsSync(join(harness.tempDir, "should-not-exist"))).toBe(false);
	});
});
