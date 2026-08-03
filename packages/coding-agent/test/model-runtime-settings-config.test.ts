import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { ReviewModelResolver } from "../src/core/review/model-resolver.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("ModelRuntime settings.json model configuration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function createTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "beaupi-settings-models-"));
		tempDirs.push(dir);
		return dir;
	}

	it("uses settings.json and auth.json as a complete DeepSeek configuration", async () => {
		const agentDir = createTempDir();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "deepseek",
				defaultModel: "deepseek-v4-pro",
				review: { model: "deepseek/deepseek-v4-flash" },
				models: {
					providers: {
						openai: { baseUrl: "https://openai-proxy.example.test/v1" },
					},
				},
			}),
		);
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				deepseek: { type: "api_key", key: "deepseek-key" },
				openai: { type: "api_key", key: "openai-key" },
			}),
			modelsPath: join(agentDir, "models.json"),
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});

		expect(runtime.getError()).toBeUndefined();
		expect(runtime.getModels("openai")[0]?.baseUrl).toBe("https://openai-proxy.example.test/v1");
		const deepseekReviewModel = runtime.getModel("deepseek", "deepseek-v4-flash");
		expect(deepseekReviewModel).toMatchObject({
			provider: "deepseek",
			reasoning: true,
			compat: { thinkingFormat: "deepseek" },
		});
		expect((await runtime.getAvailable("deepseek")).map((model) => model.id)).toContain("deepseek-v4-pro");

		const settingsManager = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
		const reviewResolution = new ReviewModelResolver({
			modelRuntime: runtime,
			getModelSetting: () => settingsManager.getReviewModel(),
			getPreferredProvider: () => settingsManager.getDefaultProvider(),
		}).resolve();
		expect(reviewResolution.candidates.map((model) => `${model.provider}/${model.id}`)).toEqual([
			"deepseek/deepseek-v4-flash",
		]);
	});

	it("hot-reloads settings providers while keeping models.json as the higher-priority override", async () => {
		const agentDir = createTempDir();
		const settingsPath = join(agentDir, "settings.json");
		const modelsPath = join(agentDir, "models.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({
				models: {
					providers: {
						openai: {
							baseUrl: "https://settings-one.example.test/v1",
							modelOverrides: { "gpt-5.6-sol": { contextWindow: 4242 } },
						},
					},
				},
			}),
		);
		writeFileSync(modelsPath, "{}");
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({ openai: { type: "api_key", key: "openai-key" } }),
			modelsPath,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});

		expect(runtime.getModels("openai")[0]?.baseUrl).toBe("https://settings-one.example.test/v1");
		expect(runtime.getModel("openai", "gpt-5.6-sol")?.contextWindow).toBe(4242);
		writeFileSync(
			modelsPath,
			JSON.stringify({ providers: { openai: { baseUrl: "https://models.example.test/v1" } } }),
		);
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModels("openai")[0]?.baseUrl).toBe("https://models.example.test/v1");
		expect(runtime.getModel("openai", "gpt-5.6-sol")?.contextWindow).toBe(4242);

		writeFileSync(
			settingsPath,
			JSON.stringify({ models: { providers: { openai: { baseUrl: "https://settings-two.example.test/v1" } } } }),
		);
		rmSync(modelsPath);
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModels("openai")[0]?.baseUrl).toBe("https://settings-two.example.test/v1");
	});
});
