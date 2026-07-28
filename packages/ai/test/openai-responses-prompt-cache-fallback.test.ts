import type { ResponseCreateParamsStreaming, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { Context, Model } from "../src/types.ts";

interface PromptCachePayload extends ResponseCreateParamsStreaming {
	prompt_cache_options?: { mode: "explicit" };
}

class FakeAPIError extends Error {
	status: number;
	headers: Headers;
	error: unknown;

	constructor(message: string, parsedBody: unknown) {
		super(message);
		this.name = "BadRequestError";
		this.status = 400;
		this.headers = new Headers();
		this.error = parsedBody;
	}
}

const openaiMock = vi.hoisted(() => ({
	calls: [] as PromptCachePayload[],
	errorMessage: "Unsupported parameter: prompt_cache_options",
	errorParam: "prompt_cache_options",
}));

vi.mock("openai", () => {
	async function* createCompletedStream(): AsyncIterable<ResponseStreamEvent> {
		yield {
			type: "response.completed",
			sequence_number: 0,
			response: {
				id: "resp_prompt_cache_fallback",
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
			},
		} as ResponseStreamEvent;
	}

	class FakeOpenAI {
		responses = {
			create: (params: PromptCachePayload) => {
				openaiMock.calls.push(structuredClone(params));
				const promise = Promise.resolve(createCompletedStream()) as Promise<AsyncIterable<ResponseStreamEvent>> & {
					withResponse: () => Promise<{
						data: AsyncIterable<ResponseStreamEvent>;
						response: { status: number; headers: Headers };
					}>;
				};
				promise.withResponse = async () => {
					if (openaiMock.calls.length === 1) {
						throw new FakeAPIError(openaiMock.errorMessage, {
							message: openaiMock.errorMessage,
							type: "invalid_request_error",
							param: openaiMock.errorParam,
							code: "unsupported_parameter",
						});
					}
					return {
						data: createCompletedStream(),
						response: { status: 200, headers: new Headers() },
					};
				};
				return promise;
			},
		};
	}

	return { default: FakeOpenAI };
});

const model: Model<"openai-responses"> = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1 },
	contextWindow: 272000,
	maxTokens: 128000,
	compat: { supportsExplicitPromptCacheMode: true },
};

const context: Context = {
	systemPrompt: "",
	messages: [{ role: "user", content: "Summarize this conversation", timestamp: 0 }],
};

describe("OpenAI Responses prompt cache compatibility fallback", () => {
	beforeEach(() => {
		openaiMock.calls = [];
		openaiMock.errorMessage = "Unsupported parameter: prompt_cache_options";
		openaiMock.errorParam = "prompt_cache_options";
	});

	it("retries once without prompt_cache_options when the endpoint rejects that parameter", async () => {
		const output = await streamOpenAIResponses(model, context, {
			apiKey: "test",
			cacheRetention: "none",
		}).result();

		expect(output.stopReason).toBe("stop");
		expect(openaiMock.calls).toHaveLength(2);
		expect(openaiMock.calls[0]?.prompt_cache_options).toEqual({ mode: "explicit" });
		expect(openaiMock.calls[1]?.prompt_cache_options).toBeUndefined();
	});

	it("does not retry unrelated bad requests", async () => {
		openaiMock.errorMessage = "Invalid value for max_output_tokens";
		openaiMock.errorParam = "max_output_tokens";

		const output = await streamOpenAIResponses(model, context, {
			apiKey: "test",
			cacheRetention: "none",
		}).result();

		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toContain("max_output_tokens");
		expect(openaiMock.calls).toHaveLength(1);
	});
});
