import type { Api, AssistantMessage, Context, Model, ModelsSimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { LunaTerminalOutputReviewer } from "../src/core/remote/output-reviewer.ts";
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

describe("Luna terminal output reviewer", () => {
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
