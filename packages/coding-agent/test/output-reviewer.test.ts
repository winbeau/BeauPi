import type { Api, AssistantMessage, Context, Model, ModelsSimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	LunaTerminalOutputReviewer,
	reviewTerminalOutput,
	type TerminalOutputReviewer,
	type TerminalReviewInput,
} from "../src/core/remote/output-reviewer.ts";
import { fauxModel } from "./test-harness.ts";

const usage: Usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function response(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: fauxModel.api,
		provider: fauxModel.provider,
		model: fauxModel.id,
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("terminal output review pipeline", () => {
	it("returns short successful output directly without calling the reviewer", async () => {
		const calls: TerminalReviewInput[] = [];
		const reviewer: TerminalOutputReviewer = {
			review: async (input) => {
				calls.push(input);
				return { text: "unexpected", status: "completed", inputTruncated: false };
			},
		};
		const result = await reviewTerminalOutput(
			{
				command: "printf short",
				output: "short output\n",
				exitCode: 0,
				durationMs: 1,
				logPath: "/tmp/work.log",
			},
			reviewer,
		);

		expect(calls).toHaveLength(0);
		expect(result).toMatchObject({
			report: "short output\n@/tmp/work.log",
			review: { status: "skipped", inputTruncated: false },
		});
	});

	it("reviews failures and long successful output", async () => {
		const calls: TerminalReviewInput[] = [];
		const reviewer: TerminalOutputReviewer = {
			review: async (input) => {
				calls.push(structuredClone(input));
				return { text: "reviewed result", status: "completed", inputTruncated: false };
			},
		};
		const failed = await reviewTerminalOutput(
			{
				command: "false",
				output: "failed\n",
				exitCode: 1,
				durationMs: 1,
				logPath: "/tmp/failed.log",
			},
			reviewer,
		);
		const long = await reviewTerminalOutput(
			{
				command: "long",
				output: `${Array.from({ length: 101 }, (_, index) => `line ${index + 1}`).join("\n")}\n`,
				exitCode: 0,
				durationMs: 1,
				logPath: "/tmp/long.log",
			},
			reviewer,
		);

		expect(calls).toHaveLength(2);
		expect(failed.report).toBe("reviewed result\n@/tmp/failed.log");
		expect(long.report).toBe("reviewed result\n@/tmp/long.log");
	});

	it("uses the configured model capacity and enforces the log path footer", async () => {
		let requestOptions: ModelsSimpleStreamOptions | undefined;
		const longReport = `reviewed\n${"detail ".repeat(2_000)}`;
		const modelRuntime = {
			getModel: (provider: string, modelId: string): Model<Api> | undefined =>
				provider === fauxModel.provider && modelId === fauxModel.id ? fauxModel : undefined,
			getModels: (): readonly Model<Api>[] => [fauxModel],
			hasConfiguredAuth: (_provider: string): boolean => true,
			completeSimple: async (
				_model: Model<Api>,
				_context: Context,
				options?: ModelsSimpleStreamOptions,
			): Promise<AssistantMessage> => {
				requestOptions = options;
				return response(`${longReport}\n@/wrong.log`);
			},
		};
		const reviewer = new LunaTerminalOutputReviewer({
			modelRuntime,
			getModelSetting: () => fauxModel.id,
			getPreferredProvider: () => fauxModel.provider,
		});
		const result = await reviewer.review({
			command: "false",
			output: "failed\n",
			exitCode: 1,
			diagnosticCode: "remote_command",
			diagnosticMessage: "failed",
			durationMs: 1,
			logPath: "/tmp/work.log",
		});

		expect(requestOptions).not.toHaveProperty("maxTokens");
		expect(result.status).toBe("completed");
		expect(result.text.endsWith("\n@/tmp/work.log")).toBe(true);
		expect(result.text).not.toContain("@/wrong.log");
		expect(result.text.length).toBeGreaterThan(10_000);
	});
});
