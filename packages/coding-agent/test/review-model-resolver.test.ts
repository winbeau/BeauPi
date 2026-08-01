import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ReviewModelResolver } from "../src/core/review/model-resolver.ts";
import { fauxModel } from "./test-harness.ts";

function model(provider: string, id = "review-small"): Model<Api> {
	return { ...fauxModel, provider, id, name: `${provider}/${id}` };
}

describe("ReviewModelResolver", () => {
	it("uses one configured provider-qualified model without cross-provider fallback", () => {
		const models = [model("preferred"), model("fallback")];
		const configured = new Set(["preferred", "fallback"]);
		const resolver = new ReviewModelResolver({
			modelRuntime: {
				getModel: (provider, id) =>
					models.find((candidate) => candidate.provider === provider && candidate.id === id),
				getModels: () => models,
				hasConfiguredAuth: (provider) => configured.has(provider),
			},
			getModelSetting: () => "fallback/review-small",
			getPreferredProvider: () => "preferred",
		});
		expect(resolver.resolve().candidates.map((candidate) => candidate.provider)).toEqual(["fallback"]);
		configured.delete("fallback");
		expect(resolver.resolve()).toMatchObject({ candidates: [], error: expect.stringContaining("not configured") });
	});

	it("prefers the active configured provider and falls back in model catalog order", () => {
		const models = [model("one"), model("preferred"), model("two"), model("ignored", "other")];
		const resolver = new ReviewModelResolver({
			modelRuntime: {
				getModel: (provider, id) =>
					models.find((candidate) => candidate.provider === provider && candidate.id === id),
				getModels: () => models,
				hasConfiguredAuth: (provider) => provider !== "ignored",
			},
			getModelSetting: () => "review-small",
			getPreferredProvider: () => "preferred",
		});
		expect(resolver.resolve().candidates.map((candidate) => candidate.provider)).toEqual(["preferred", "one", "two"]);
	});

	it("skips an unauthenticated preferred provider instead of forcing a failed first attempt", () => {
		const models = [model("preferred"), model("fallback")];
		const resolver = new ReviewModelResolver({
			modelRuntime: {
				getModel: (provider, id) =>
					models.find((candidate) => candidate.provider === provider && candidate.id === id),
				getModels: () => models,
				hasConfiguredAuth: (provider) => provider === "fallback",
			},
			getModelSetting: () => "review-small",
			getPreferredProvider: () => "preferred",
		});
		expect(resolver.resolve().candidates.map((candidate) => candidate.provider)).toEqual(["fallback"]);
	});
});
