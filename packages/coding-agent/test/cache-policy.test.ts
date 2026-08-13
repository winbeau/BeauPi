import { describe, expect, it } from "vitest";
import { defaultPromptCacheTtlMs } from "../src/core/cache-policy.ts";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

describe("prompt cache policy", () => {
	it("maps DeepSeek hosts to 24 hours", () => {
		expect(defaultPromptCacheTtlMs("https://api.deepseek.com")).toBe(TWENTY_FOUR_HOURS_MS);
		expect(defaultPromptCacheTtlMs("https://custom.deepseek.com/v1")).toBe(TWENTY_FOUR_HOURS_MS);
	});

	it("maps Anthropic and DashScope hosts to 5 minutes", () => {
		expect(defaultPromptCacheTtlMs("https://api.anthropic.com/v1")).toBe(FIVE_MINUTES_MS);
		expect(defaultPromptCacheTtlMs("https://region.dashscope.aliyuncs.com/api/v1")).toBe(FIVE_MINUTES_MS);
		expect(defaultPromptCacheTtlMs("https://workspace.maas.aliyuncs.com/v1")).toBe(FIVE_MINUTES_MS);
	});

	it("defaults unknown hosts and undefined to 24 hours", () => {
		expect(defaultPromptCacheTtlMs("https://example.com/v1")).toBe(TWENTY_FOUR_HOURS_MS);
		expect(defaultPromptCacheTtlMs(undefined)).toBe(TWENTY_FOUR_HOURS_MS);
	});

	it("does not match substring lookalikes", () => {
		expect(defaultPromptCacheTtlMs("https://notdeepseek.com.evil.example.com")).toBe(TWENTY_FOUR_HOURS_MS);
	});
});
