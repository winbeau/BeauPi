import type { Api, AssistantMessage, Context, Model, ModelsSimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { VisionService } from "../src/core/vision/vision-service.ts";
import { fauxModel } from "./test-harness.ts";

const usage: Usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function visionModel(provider = "openai"): Model<Api> {
	return { ...fauxModel, provider, id: "gpt-5.6-sol", name: `${provider}/gpt-5.6-sol` };
}

function response(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: fauxModel.api,
		provider: "openai",
		model: "gpt-5.6-sol",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createService(
	completeSimple: (
		model: Model<Api>,
		context: Context,
		options?: ModelsSimpleStreamOptions,
	) => Promise<AssistantMessage>,
) {
	const models = [visionModel()];
	return new VisionService({
		modelRuntime: {
			completeSimple,
			getModel: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
			getModels: () => models,
			hasConfiguredAuth: () => true,
		},
		getModelSetting: () => "gpt-5.6-sol",
		getPreferredProvider: () => "deepseek",
	});
}

const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };

describe("VisionService", () => {
	it("describes an image with the vision model and includes the image in the request", async () => {
		const completeSimple = vi.fn(
			async (_model: Model<Api>, _context: Context, _options?: ModelsSimpleStreamOptions) =>
				response("A red 1x1 pixel."),
		);
		const service = createService(completeSimple);
		const description = await service.describeImage(image);
		expect(description).toBe("A red 1x1 pixel.");
		expect(completeSimple).toHaveBeenCalledTimes(1);
		const context = completeSimple.mock.calls[0]![1];
		const userContent = context.messages[0]!.content;
		expect(Array.isArray(userContent)).toBe(true);
		expect(userContent).toContainEqual(image);
	});

	it("caches descriptions by image data hash so repeated turns do not re-call the model", async () => {
		const completeSimple = vi.fn(async () => response("A red 1x1 pixel."));
		const service = createService(completeSimple);
		await service.describeImage(image);
		await service.describeImage(image);
		expect(completeSimple).toHaveBeenCalledTimes(1);
	});

	it("describes distinct images separately", async () => {
		const completeSimple = vi.fn(async () => response("An image."));
		const service = createService(completeSimple);
		await service.describeImage(image);
		await service.describeImage({ type: "image", data: "d29ybGQ=", mimeType: "image/png" });
		expect(completeSimple).toHaveBeenCalledTimes(2);
	});

	it("returns undefined on failure and retries on the next call", async () => {
		const completeSimple = vi
			.fn()
			.mockRejectedValueOnce(new Error("provider error"))
			.mockResolvedValue(response("A red 1x1 pixel."));
		const service = createService(completeSimple);
		expect(await service.describeImage(image)).toBeUndefined();
		expect(await service.describeImage(image)).toBe("A red 1x1 pixel.");
		expect(completeSimple).toHaveBeenCalledTimes(2);
	});

	it("returns undefined when no vision model is configured or available", async () => {
		const service = new VisionService({
			modelRuntime: {
				completeSimple: vi.fn(),
				getModel: () => undefined,
				getModels: () => [],
				hasConfiguredAuth: () => false,
			},
			getModelSetting: () => "gpt-5.6-sol",
			getPreferredProvider: () => "deepseek",
		});
		expect(await service.describeImage(image)).toBeUndefined();
	});
});
