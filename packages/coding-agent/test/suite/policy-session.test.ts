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
	it("advises on a concurrent duplicate check, stores Policy facts in Task Ledger, and restores branch/Compact state", async () => {
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
		expect(policies.map((policy) => policy?.decision.action)).toEqual(["allow", "allow"]);
		expect(policies.flatMap((policy) => policy?.advisories ?? []).map((advisory) => advisory.kind)).toEqual([
			"repeated_operation",
		]);
		expect(session.taskLedger.getSnapshot().policy).toHaveLength(2);
		expect(session.taskLedger.getSnapshot().commands.map((command) => command.status)).toEqual([
			"success",
			"success",
		]);

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

	it("applies advisory-only Policy to user Bash and persists facts without a second state system", async () => {
		const { harness, session } = await createPolicySession();
		await session.executeBash("pwd");
		await session.executeBash("pwd");
		const privilegedExec = vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 0 }));
		const privileged = await session.executeBash("sudo touch should-not-exist", undefined, {
			operations: { exec: privilegedExec },
		});
		expect(privileged.policy?.decision.action).toBe("allow");
		expect(privileged.policy?.advisories?.map((advisory) => advisory.kind)).toContain("privileged_operation");
		expect(privilegedExec).toHaveBeenCalledOnce();

		const exec = vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 127 }));
		const operations: BashOperations = { exec };
		const missing = await session.executeBash("missing-policy-command", undefined, { operations });
		expect(missing.policy?.failure?.category).toBe("missing_dependency");
		const retry = await session.executeBash("missing-policy-command", undefined, { operations });
		expect(retry.policy?.decision.action).toBe("allow");
		expect(retry.policy?.advisories?.map((advisory) => advisory.kind)).toContain("equivalent_failures");
		expect(exec).toHaveBeenCalledTimes(2);

		const facts = session.policyRuntime.getFacts();
		expect(facts.map((fact) => fact.decision.action)).toEqual(["allow", "allow", "allow", "allow", "allow"]);
		expect(session.taskLedger.getSnapshot().policy).toHaveLength(5);
		const customFacts = session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "beaupi.policy.fact");
		expect(customFacts).toHaveLength(5);
		expect(existsSync(join(harness.tempDir, "should-not-exist"))).toBe(false);
	});

	it("never invokes Policy confirmation handlers for sensitive operations", async () => {
		const handler = vi.fn(async () => ({ status: "rejected" as const }));
		const { harness, session } = await createPolicySession({ policyHandler: handler });
		const path = join(harness.tempDir, ".env");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path, content: "advisory-only" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await session.prompt("Write the sensitive file");
		const result = session.messages.find((message) => message.role === "toolResult");
		const policy = result?.role === "toolResult" ? getPolicyToolDetails(result.details) : undefined;
		expect(policy).toMatchObject({ status: "succeeded", executed: true, decision: { action: "allow" } });
		expect(policy?.advisories?.map((advisory) => advisory.kind)).toContain("sensitive_operation");
		expect(existsSync(path)).toBe(true);
		expect(handler).not.toHaveBeenCalled();
		expect(session.policyRuntime.getPending()).toBeUndefined();
	});

	it("keeps sensitive and Search-to-Shell operations executable while preserving advisory metadata", async () => {
		const { harness, session } = await createPolicySession({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role === "toolResult") return { message: { ...event.message, details: undefined } };
					});
				},
			],
		});
		const sensitivePath = join(harness.tempDir, ".env");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("write", { path: sensitivePath, content: "allowed" }, { id: "sensitive-write" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("web_search", { query: "policy docs" }, { id: "search" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("bash", { command: "curl --version" }, { id: "curl" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await session.prompt("Exercise advisory-only Policy");
		const byId = new Map(
			session.messages
				.filter((message) => message.role === "toolResult")
				.map((message) => [message.role === "toolResult" ? message.toolCallId : "", message]),
		);
		const sensitiveWrite = byId.get("sensitive-write");
		const search = byId.get("search");
		const curl = byId.get("curl");
		const writePolicy =
			sensitiveWrite?.role === "toolResult" ? getPolicyToolDetails(sensitiveWrite.details) : undefined;
		expect(writePolicy?.decision.action).toBe("allow");
		expect(writePolicy?.advisories?.map((advisory) => advisory.kind)).toContain("sensitive_operation");
		expect(existsSync(sensitivePath)).toBe(true);
		expect(search?.role === "toolResult" ? getPolicyToolDetails(search.details)?.failure?.category : undefined).toBe(
			"configuration",
		);
		const curlPolicy = curl?.role === "toolResult" ? getPolicyToolDetails(curl.details) : undefined;
		expect(curlPolicy?.decision.action).toBe("allow");
		expect(curlPolicy?.advisories?.map((advisory) => advisory.kind)).toEqual(
			expect.arrayContaining(["network_fallback", "dedicated_tool_available"]),
		);
		expect(session.taskLedger.getSnapshot().policy).toHaveLength(3);
	});
});
