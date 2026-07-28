import { existsSync, writeFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { getTaskLedgerToolDetails, TaskLedger } from "../../src/core/state/task-ledger.ts";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession TaskLedger integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("records built-in Tool lifecycle, file reads, file modifications, and structured Session details", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sourcePath = `${harness.tempDir}/source.txt`;
		const outputPath = `${harness.tempDir}/output.txt`;
		writeFileSync(sourcePath, "source\n");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: sourcePath }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("write", { path: outputPath, content: "output\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("copy the file");

		const snapshot = harness.session.taskLedger.getSnapshot();
		expect(snapshot.commands.map((command) => [command.toolName, command.status])).toEqual([
			["read", "success"],
			["write", "success"],
		]);
		expect(snapshot.filesRead.map((record) => record.path)).toEqual([sourcePath]);
		expect(snapshot.filesModified).toEqual([outputPath]);
		expect(snapshot.phase).toBe("execute");
		expect(existsSync(outputPath)).toBe(true);

		const toolResults = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(toolResults).toHaveLength(2);
		for (const entry of toolResults) {
			if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
			const details = getTaskLedgerToolDetails(entry.message.details);
			expect(details?.status).toBe("success");
			expect(details?.eventId).toBe(`tool:${entry.message.toolCallId}`);
		}

		const restored = new TaskLedger({
			taskId: harness.session.sessionId,
			cwd: harness.sessionManager.getCwd(),
			entries: harness.sessionManager.getBranch(),
		}).getSnapshot();
		expect(restored.commands).toHaveLength(2);
		expect(restored.filesRead).toHaveLength(1);
		expect(restored.fileModifications).toHaveLength(1);
	});

	it("reattaches TaskLedger details after message_end extensions replace Tool Result details", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: { original: true } }),
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "toolResult") return;
						return { message: { ...event.message, details: undefined } };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("echo");

		const toolResult = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(toolResult?.type).toBe("message");
		if (toolResult?.type !== "message" || toolResult.message.role !== "toolResult") return;
		expect(getTaskLedgerToolDetails(toolResult.message.details)?.status).toBe("success");
	});

	it("records failed and cancelled Tool results with stable status after Session rebuild", async () => {
		let blockingStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			blockingStarted = resolve;
		});
		const tools: AgentTool[] = [
			{
				name: "fail",
				label: "Fail",
				description: "Fail immediately",
				parameters: Type.Object({}),
				execute: async () => {
					throw new Error("expected failure");
				},
			},
			{
				name: "block",
				label: "Block",
				description: "Wait for cancellation",
				parameters: Type.Object({}),
				execute: async (_toolCallId, _params, signal) => {
					blockingStarted();
					await new Promise<void>((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(new Error("Operation aborted")), { once: true });
					});
					return { content: [{ type: "text", text: "unreachable" }], details: {} };
				},
			},
		];
		const harness = await createHarness({ tools });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("fail", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("continue"),
			fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" }),
		]);

		await harness.session.prompt("fail first");
		const blockingPrompt = harness.session.prompt("then block");
		await started;
		await harness.session.abort();
		await blockingPrompt;

		const snapshot = harness.session.taskLedger.getSnapshot();
		expect(snapshot.commands.map((command) => command.status)).toEqual(["failed", "cancelled"]);
		expect(snapshot.failures.map((failure) => failure.status)).toEqual(["failed", "cancelled"]);

		const restored = new TaskLedger({
			taskId: harness.session.sessionId,
			cwd: harness.sessionManager.getCwd(),
			entries: harness.sessionManager.getBranch(),
		}).getSnapshot();
		expect(restored.commands.map((command) => command.status)).toEqual(["failed", "cancelled"]);
		expect(restored.failures).toHaveLength(2);
	});

	it("preserves a successful parallel Tool result when another Tool is cancelled", async () => {
		let blockingStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			blockingStarted = resolve;
		});
		const tools: AgentTool[] = [
			{
				name: "complete",
				label: "Complete",
				description: "Complete immediately",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
			},
			{
				name: "wait",
				label: "Wait",
				description: "Wait for cancellation",
				parameters: Type.Object({}),
				execute: async (_toolCallId, _params, signal) => {
					blockingStarted();
					await new Promise<void>((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(new Error("Operation aborted")), { once: true });
					});
					return { content: [{ type: "text", text: "unreachable" }], details: {} };
				},
			},
		];
		const harness = await createHarness({ tools });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("complete", {}), fauxToolCall("wait", {})], {
				stopReason: "toolUse",
			}),
		]);

		const prompt = harness.session.prompt("run both");
		await started;
		await harness.session.abort();
		await prompt;

		expect(harness.session.taskLedger.getSnapshot().commands.map((command) => command.status)).toEqual([
			"success",
			"cancelled",
		]);
	});

	it("records user Shell success, failure, and cancellation across Session rebuild", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.executeBash("printf ok");
		await expect(
			harness.session.executeBash("broken", undefined, {
				operations: {
					exec: async () => {
						throw new Error("backend unavailable");
					},
				},
			}),
		).rejects.toThrow("backend unavailable");
		const cancellingOperations: BashOperations = {
			exec: async (_command, _cwd, options) =>
				await new Promise<{ exitCode: number | null }>((resolve) => {
					options.signal?.addEventListener("abort", () => resolve({ exitCode: null }), { once: true });
				}),
		};
		const cancelling = harness.session.executeBash("wait", undefined, { operations: cancellingOperations });
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortBash();
		await cancelling;

		const snapshot = harness.session.taskLedger.getSnapshot();
		expect(snapshot.commands.map((command) => command.status)).toEqual(["success", "failed", "cancelled"]);
		const bashMessages = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "bashExecution")
			.map((entry) =>
				entry.type === "message" && entry.message.role === "bashExecution" ? entry.message : undefined,
			);
		expect(bashMessages).toHaveLength(3);
		expect(bashMessages[1]?.output).toBe("backend unavailable");
		expect(bashMessages[1]?.exitCode).toBe(1);

		const restored = new TaskLedger({
			taskId: harness.session.sessionId,
			cwd: harness.sessionManager.getCwd(),
			entries: harness.sessionManager.getBranch(),
		}).getSnapshot();
		expect(restored.commands.map((command) => command.status)).toEqual(["success", "failed", "cancelled"]);
	});
});
