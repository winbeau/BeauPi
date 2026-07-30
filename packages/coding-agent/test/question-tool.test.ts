import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
	ASK_USER_QUESTION_PARAMETERS,
	type AskUserQuestionInput,
	createAskUserQuestionToolDefinition,
	QUESTION_RESULT_SCHEMA,
	type QuestionInteractionResponse,
	QuestionRuntime,
} from "../src/core/question.ts";

function input(overrides: Partial<AskUserQuestionInput["questions"][number]> = {}): AskUserQuestionInput {
	return {
		questions: [
			{
				question: "Which implementation should we use?",
				header: "Library",
				options: [
					{ label: "React", description: "Use React", preview: "# React\n\n```ts\nconst ui = 'react';\n```" },
					{ label: "Vue", description: "Use Vue" },
				],
				multiSelect: false,
				...overrides,
			},
		],
	};
}

describe("ask_user_question tool", () => {
	it("uses strict TypeBox schemas and a sequential execution boundary", () => {
		const inputValidator = Compile(ASK_USER_QUESTION_PARAMETERS);
		const resultValidator = Compile(QUESTION_RESULT_SCHEMA);
		expect(inputValidator.Check(input())).toBe(true);
		expect(inputValidator.Check({ ...input(), extra: true })).toBe(false);
		expect(inputValidator.Check(input({ options: [{ label: "One", description: "Only one" }] }))).toBe(false);
		expect(inputValidator.Check(input({ header: "1234567890123" }))).toBe(false);
		const nestedExtra = input();
		(nestedExtra.questions[0].options[0] as unknown as Record<string, unknown>).extra = true;
		expect(inputValidator.Check(nestedExtra)).toBe(false);
		const tool = createAskUserQuestionToolDefinition();
		expect(tool.executionMode).toBe("sequential");
		expect(
			resultValidator.Check({
				version: 1,
				requestId: "request-1",
				status: "cancelled",
				answers: [],
				createdAt: "2026-03-15T00:00:00.000Z",
			}),
		).toBe(true);
	});

	it("normalizes text and rejects duplicate headers, duplicate options, reserved Other labels, and preview overflow", async () => {
		const runtime = new QuestionRuntime({ handler: async () => ({ status: "cancelled" }) });
		const duplicateLabel = await runtime.execute(
			"duplicate-label",
			input({
				options: [
					{ label: "Ａ", description: "Full width" },
					{ label: "A", description: "ASCII" },
				],
			}),
		);
		expect(duplicateLabel.details.status).toBe("interaction_error");
		expect(duplicateLabel.details.diagnostic).toContain("duplicate option label");

		const duplicateHeader = await runtime.execute("duplicate-header", {
			questions: [input().questions[0], { ...input().questions[0], question: "Second", header: "Ｌｉｂｒａｒｙ" }],
		});
		expect(duplicateHeader.details.status).toBe("interaction_error");
		expect(duplicateHeader.details.diagnostic).toContain("duplicate header");

		const multiPreview = await runtime.execute("multi-preview", input({ multiSelect: true }));
		expect(multiPreview.details.status).toBe("interaction_error");
		expect(multiPreview.details.diagnostic).toContain("cannot use Markdown preview");

		const reservedOther = await runtime.execute(
			"reserved-other",
			input({
				options: [
					{ label: "Other (please specify)", description: "Model supplied Other" },
					{ label: "Vue", description: "Use Vue" },
				],
			}),
		);
		expect(reservedOther.details.status).toBe("interaction_error");
		expect(reservedOther.details.diagnostic).toContain("built-in Other");

		const previewOverflow = await runtime.execute("preview-overflow", {
			questions: Array.from({ length: 3 }, (_, index) => ({
				...input().questions[0],
				header: `Header ${index}`,
				options: [
					{ label: `A${index}`, description: "A", preview: "x".repeat(8_000) },
					{ label: `B${index}`, description: "B" },
				],
			})),
		});
		expect(previewOverflow.details.status).toBe("interaction_error");
		expect(previewOverflow.details.diagnostic).toContain("preview budget");
	});

	it("returns versioned structured answers with a controllable clock", async () => {
		const runtime = new QuestionRuntime({
			now: () => new Date("2026-03-15T12:00:00.000Z"),
			handler: async (request) => ({
				status: "answered",
				answers: [
					{
						header: request.questions[0].header,
						selectedLabels: ["Ｒｅａｃｔ"],
						notes: " Keep the existing renderer. ",
					},
				],
			}),
		});
		const result = await runtime.execute("request-answered", input());
		expect(result.details).toEqual({
			version: 1,
			requestId: "request-answered",
			status: "answered",
			answers: [
				{
					header: "Library",
					selectedLabels: ["React"],
					notes: "Keep the existing renderer.",
				},
			],
			createdAt: "2026-03-15T12:00:00.000Z",
		});
	});

	it("returns immediately without a handler and contains handler failures", async () => {
		const missingHandler = await new QuestionRuntime().execute("headless", input());
		expect(missingHandler.details.status).toBe("interaction_required");

		const invalidAnswerHandler = new QuestionRuntime({
			handler: async (request) => ({
				status: "answered",
				answers: [
					{
						header: request.questions[0].header,
						selectedLabels: [request.questions[0].options[0].label],
						extra: true,
					},
				],
			}),
		});
		const invalidAnswer = await invalidAnswerHandler.execute("invalid-answer", input());
		expect(invalidAnswer.details).toMatchObject({ status: "interaction_error" });

		const rejectingHandler = new QuestionRuntime({
			handler: async () => ({ status: "rejected", diagnostic: "Decision deferred" }),
		});
		const rejected = await rejectingHandler.execute("rejected", input());
		expect(rejected.details).toMatchObject({ status: "rejected", diagnostic: "Decision deferred" });

		const failingHandler = new QuestionRuntime({
			handler: async () => {
				throw new Error("host UI failed");
			},
		});
		const failed = await failingHandler.execute("failed", input());
		expect(failed.details).toMatchObject({ status: "interaction_error", diagnostic: "host UI failed" });
	});

	it("supports cancellation and rejects overlapping requests", async () => {
		let resolveFirst: ((response: QuestionInteractionResponse) => void) | undefined;
		const runtime = new QuestionRuntime({
			handler: async () =>
				await new Promise<QuestionInteractionResponse>((resolve) => {
					resolveFirst = resolve;
				}),
		});
		const first = runtime.execute("first", input());
		expect(runtime.getPending()?.requestId).toBe("first");
		const overlapping = await runtime.execute("second", input());
		expect(overlapping.details).toMatchObject({ status: "interaction_error" });
		resolveFirst?.({ status: "cancelled" });
		expect((await first).details.status).toBe("cancelled");
		expect(runtime.getPending()).toBeUndefined();

		const abortRuntime = new QuestionRuntime({
			handler: async (_request, signal) =>
				await new Promise<QuestionInteractionResponse>((resolve) => {
					signal?.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
				}),
		});
		const controller = new AbortController();
		const aborted = abortRuntime.execute("aborted", input(), controller.signal);
		controller.abort();
		expect((await aborted).details.status).toBe("cancelled");
	});
});
