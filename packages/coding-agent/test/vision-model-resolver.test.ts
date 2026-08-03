import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { VisionModelResolver } from "../src/core/vision/model-resolver.ts";
import { fauxModel } from "./test-harness.ts";

function model(provider: string, id = "gpt-5.6-sol"): Model<Api> {
	return { ...fauxModel, provider, id, name: `${provider}/${id}` };
}

describe("VisionModelResolver", () => {
	it("uses one configured provider-qualified model without cross-provider fallback", () => {
		const models = [model("preferred"), model("fallback")];
		const configured = new Set(["preferred", "fallback"]);
		const resolver = new VisionModelResolver({
			modelRuntime: {
				getModel: (provider, id) =>
					models.find((candidate) => candidate.provider === provider && candidate.id === id),
				getModels: () => models,
				hasConfiguredAuth: (provider) => configured.has(provider),
			},
			getModelSetting: () => "fallback/gpt-5.6-sol",
			getPreferredProvider: () => "preferred",
		});
		expect(resolver.resolve().candidates.map((candidate) => candidate.provider)).toEqual(["fallback"]);
		configured.delete("fallback");
		expect(resolver.resolve()).toMatchObject({ candidates: [], error: expect.stringContaining("not configured") });
	});

	it("prefers the active configured provider and falls back in model catalog order", () => {
		const models = [model("one"), model("preferred"), model("two"), model("ignored", "other")];
		const resolver = new VisionModelResolver({
			modelRuntime: {
				getModel: (provider, id) =>
					models.find((candidate) => candidate.provider === provider && candidate.id === id),
				getModels: () => models,
				hasConfiguredAuth: (provider) => provider !== "ignored",
			},
			getModelSetting: () => "gpt-5.6-sol",
			getPreferredProvider: () => "preferred",
		});
		expect(resolver.resolve().candidates.map((candidate) => candidate.provider)).toEqual(["preferred", "one", "two"]);
	});

	it("defaults to the DEFAULT_VISION_MODEL id when unset", () => {
		const models = [model("preferred"), model("fallback")];
		const resolver = new VisionModelResolver({
			modelRuntime: {
				getModel: (provider, id) =>
					models.find((candidate) => candidate.provider === provider && candidate.id === id),
				getModels: () => models,
				hasConfiguredAuth: (provider) => provider === "fallback",
			},
			getModelSetting: () => undefined,
			getPreferredProvider: () => "preferred",
		});
		expect(resolver.resolve().candidates.map((candidate) => candidate.provider)).toEqual(["fallback"]);
	});

	it("reports vision-specific errors when the model is not in the catalog", () => {
		const resolver = new VisionModelResolver({
			modelRuntime: {
				getModel: () => undefined,
				getModels: () => [],
				hasConfiguredAuth: () => true,
			},
			getModelSetting: () => "openai/nope",
			getPreferredProvider: () => "openai",
		});
		expect(resolver.resolve().error).toContain("Vision model openai/nope");
	});
});
