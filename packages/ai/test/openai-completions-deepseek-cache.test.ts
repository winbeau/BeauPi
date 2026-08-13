import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, Model, ToolResultMessage, Usage } from "../src/types.ts";

interface MockUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	prompt_cache_hit_tokens?: number;
	prompt_cache_miss_tokens?: number;
	prompt_tokens_details?: {
		cached_tokens?: number;
		cache_write_tokens?: number;
	};
	completion_tokens_details?: { reasoning_tokens?: number };
}

interface MockChunk {
	choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>;
	usage?: MockUsage;
}

interface CapturedPayload {
	prompt_cache_key?: string;
	prompt_cache_retention?: "24h" | "in-memory" | null;
	thinking?: { type?: string };
	reasoning_effort?: string;
	messages?: Array<Record<string, unknown>>;
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedPayload | undefined,
	chunks: undefined as MockChunk[] | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params as CapturedPayload;
					const chunks = mockState.chunks ?? [
						{
							choices: [{ delta: {}, finish_reason: "stop" }],
							usage: {
								prompt_tokens: 1,
								completion_tokens: 1,
								prompt_tokens_details: { cached_tokens: 0 },
								completion_tokens_details: { reasoning_tokens: 0 },
							},
						},
					];
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) {
								yield chunk;
							}
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

describe("openai-completions DeepSeek prompt caching", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.chunks = undefined;
	});

	function deepSeekModel(): Model<"openai-completions"> {
		return getModel("deepseek", "deepseek-v4-flash");
	}

	function zeroUsage(): Usage {
		return {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	async function captureDeepSeekRequest(
		options: Parameters<typeof streamOpenAICompletions>[2] = {},
		context: Context = {
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		},
	) {
		const response = await streamOpenAICompletions(deepSeekModel(), context, {
			apiKey: "test-key",
			...options,
		}).result();
		return { response, payload: mockState.lastParams };
	}

	it("parses prompt_cache_hit_tokens into usage.cacheRead", async () => {
		mockState.chunks = [
			{
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1000,
					completion_tokens: 50,
					prompt_cache_hit_tokens: 800,
					prompt_cache_miss_tokens: 200,
				},
			},
		];

		const { response } = await captureDeepSeekRequest();

		expect(response.usage.cacheRead).toBe(800);
		expect(response.usage.input).toBe(200);
		expect(response.usage.totalTokens).toBe(1050);
	});

	it("parses prompt_tokens_details.cached_tokens when hit field is absent", async () => {
		mockState.chunks = [
			{
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1000,
					completion_tokens: 50,
					prompt_tokens_details: { cached_tokens: 800 },
				},
			},
		];

		const { response } = await captureDeepSeekRequest();

		expect(response.usage.cacheRead).toBe(800);
		expect(response.usage.input).toBe(200);
	});

	it("derives input as prompt minus hit when miss field is absent", async () => {
		mockState.chunks = [
			{
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1000,
					completion_tokens: 50,
					prompt_cache_hit_tokens: 800,
				},
			},
		];

		const { response } = await captureDeepSeekRequest();

		expect(response.usage.cacheRead).toBe(800);
		expect(response.usage.input).toBe(200);
	});

	it("default short retention sends no prompt_cache_key for DeepSeek", async () => {
		const { payload } = await captureDeepSeekRequest({ sessionId: "deepseek-session" });

		expect(payload?.prompt_cache_key).toBeUndefined();
		expect(payload?.prompt_cache_retention).toBeUndefined();
	});

	it("long retention sends no prompt cache fields for DeepSeek", async () => {
		const { payload } = await captureDeepSeekRequest({ cacheRetention: "long", sessionId: "deepseek-session" });

		expect(payload?.prompt_cache_key).toBeUndefined();
		expect(payload?.prompt_cache_retention).toBeUndefined();
	});

	it("sends thinking type deepseek when reasoning is enabled", async () => {
		const { payload } = await captureDeepSeekRequest({ reasoningEffort: "high" });

		expect(payload?.thinking).toEqual({ type: "enabled" });
		expect(payload?.reasoning_effort).toBe("high");
	});

	it("assistant replay includes empty reasoning_content", async () => {
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "deepseek",
			model: "deepseek-v4-flash",
			content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } }],
			usage: zeroUsage(),
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: "contents" }],
			isError: false,
			timestamp: Date.now(),
		};

		const { payload } = await captureDeepSeekRequest(
			{},
			{
				systemPrompt: "sys",
				messages: [
					{ role: "user", content: "Read README.md", timestamp: Date.now() },
					assistantMessage,
					toolResult,
				],
			},
		);

		const replayedAssistant = payload?.messages?.find((message) => message.role === "assistant");
		expect(replayedAssistant).toMatchObject({ reasoning_content: "" });
	});
});
