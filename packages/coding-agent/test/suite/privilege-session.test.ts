import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { FakePrivilegeTerminalAdapter, getPrivilegeToolDetails } from "../../src/core/privilege/index.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const created: Array<{ harness: Harness; session: Awaited<ReturnType<typeof createAgentSession>>["session"] }> = [];
afterEach(() => {
	while (created.length > 0) {
		const item = created.pop();
		item?.session.dispose();
		item?.harness.cleanup();
	}
});

describe("M13 Privilege AgentSession lifecycle", () => {
	it("returns controlled sudo facts to the next faux turn without exposing authentication input", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role === "toolResult") return { message: { ...event.message, details: undefined } };
					});
				},
			],
		});
		const adapter = new FakePrivilegeTerminalAdapter();
		adapter.setResult({ output: "uid=0(root)\n", exitCode: 0, logPath: join(harness.tempDir, "privilege.log") });
		const secret = Buffer.from("M13-faux-secret-fixture\r", "utf8");
		const result = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
			sessionManager: SessionManager.inMemory(harness.tempDir),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
			privilegeTerminalAdapter: adapter,
			privilegeHandler: async (_request, control) => {
				await control.start();
				await control.sendSensitive(secret);
				await control.wait();
				return { status: "completed" };
			},
			agentPool: false,
		});
		created.push({ harness, session: result.session });
		let nextContext: unknown;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "sudo id" }, { id: "sudo-call" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				nextContext = structuredClone(context.messages);
				return fauxAssistantMessage("done");
			},
		]);

		await result.session.prompt("Run the controlled sudo command");
		const toolResult = result.session.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "sudo-call",
		);
		const privilege = toolResult?.role === "toolResult" ? getPrivilegeToolDetails(toolResult.details) : undefined;
		expect(privilege).toMatchObject({ status: "succeeded", sourceTool: "bash", route: "local_bash" });
		expect(adapter.getReceivedInputForTest()).toEqual(secret);
		expect(result.session.taskLedger.getSnapshot().privilege).toHaveLength(1);
		expect(privilege?.monitorId).toBeDefined();
		expect(result.session.monitorRuntime.status(privilege!.monitorId!)).toMatchObject({ status: "completed" });

		const secretText = secret.toString("utf8").trim();
		const serialized = JSON.stringify({
			nextContext,
			messages: result.session.messages,
			session: result.session.sessionManager.getBranch(),
			ledger: result.session.taskLedger.getSnapshot(),
			monitor: result.session.monitorRuntime.list(),
		});
		expect(serialized).not.toContain(secretText);
		expect(privilege).not.toHaveProperty("input");
		expect(toolResult).not.toHaveProperty("input");
		const auditDir = join(harness.tempDir, "audit", "privileged");
		expect(existsSync(auditDir)).toBe(true);
		const audit = readdirSync(auditDir)
			.map((file) => readFileSync(join(auditDir, file), "utf8"))
			.join("\n");
		expect(audit).not.toContain(secretText);
	});
});
