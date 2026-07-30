import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { ToolDefinition } from "./extensions/types.ts";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
export const QUESTION_RESULT_VERSION = 1;
export const QUESTION_LIMITS = Object.freeze({
	maxQuestions: 4,
	minOptions: 2,
	maxOptions: 4,
	maxQuestionLength: 500,
	maxHeaderLength: 12,
	maxLabelLength: 120,
	maxDescriptionLength: 500,
	maxPreviewLength: 8_000,
	maxTotalPreviewLength: 20_000,
	maxCustomAnswerLength: 4_000,
	maxNotesLength: 4_000,
	maxDiagnosticLength: 2_000,
});

export const QUESTION_OPTION_SCHEMA = Type.Object(
	{
		label: Type.String({
			minLength: 1,
			maxLength: QUESTION_LIMITS.maxLabelLength,
			description: "Concrete option label; never use Other or an equivalent label",
		}),
		description: Type.String({
			minLength: 1,
			maxLength: QUESTION_LIMITS.maxDescriptionLength,
			description: "Concise consequence or trade-off for this option",
		}),
		preview: Type.Optional(
			Type.String({
				maxLength: QUESTION_LIMITS.maxPreviewLength,
				description: "Optional untrusted Markdown preview for a single-select option",
			}),
		),
	},
	{ additionalProperties: false },
);

export const QUESTION_SCHEMA = Type.Object(
	{
		question: Type.String({
			minLength: 1,
			maxLength: QUESTION_LIMITS.maxQuestionLength,
			description: "Focused question that requires a user decision",
		}),
		header: Type.String({
			minLength: 1,
			maxLength: QUESTION_LIMITS.maxHeaderLength,
			description: "Unique short tab label, at most 12 characters",
		}),
		options: Type.Array(QUESTION_OPTION_SCHEMA, {
			minItems: QUESTION_LIMITS.minOptions,
			maxItems: QUESTION_LIMITS.maxOptions,
			description: "Two to four concrete options; the runtime adds Other automatically",
		}),
		multiSelect: Type.Boolean({ description: "Whether the user may choose more than one option" }),
	},
	{ additionalProperties: false },
);

export const ASK_USER_QUESTION_PARAMETERS = Type.Object(
	{
		questions: Type.Array(QUESTION_SCHEMA, {
			minItems: 1,
			maxItems: QUESTION_LIMITS.maxQuestions,
			description: "One to four unique questions",
		}),
	},
	{ additionalProperties: false },
);

export const QUESTION_ANSWER_SCHEMA = Type.Object(
	{
		header: Type.String(),
		selectedLabels: Type.Array(Type.String()),
		customAnswer: Type.Optional(Type.String({ maxLength: QUESTION_LIMITS.maxCustomAnswerLength })),
		notes: Type.Optional(Type.String({ maxLength: QUESTION_LIMITS.maxNotesLength })),
	},
	{ additionalProperties: false },
);

export const QUESTION_RESULT_SCHEMA = Type.Object(
	{
		version: Type.Literal(QUESTION_RESULT_VERSION),
		requestId: Type.String({ minLength: 1 }),
		status: Type.Union([
			Type.Literal("answered"),
			Type.Literal("cancelled"),
			Type.Literal("rejected"),
			Type.Literal("interaction_required"),
			Type.Literal("interaction_error"),
		]),
		answers: Type.Array(QUESTION_ANSWER_SCHEMA),
		createdAt: Type.String(),
		diagnostic: Type.Optional(Type.String({ maxLength: QUESTION_LIMITS.maxDiagnosticLength })),
	},
	{ additionalProperties: false },
);

export type QuestionOption = Static<typeof QUESTION_OPTION_SCHEMA>;
export type UserQuestion = Static<typeof QUESTION_SCHEMA>;
export type AskUserQuestionInput = Static<typeof ASK_USER_QUESTION_PARAMETERS>;
export type QuestionAnswer = Static<typeof QUESTION_ANSWER_SCHEMA>;
export type QuestionResult = Static<typeof QUESTION_RESULT_SCHEMA>;

export type QuestionInteractionResponse =
	| { status: "answered"; answers: QuestionAnswer[] }
	| { status: "cancelled" }
	| { status: "rejected"; diagnostic?: string }
	| { status: "error"; diagnostic: string };

export interface QuestionInteractionRequest {
	requestId: string;
	questions: UserQuestion[];
}

export type QuestionInteractionHandler = (
	request: QuestionInteractionRequest,
	signal: AbortSignal | undefined,
) => Promise<QuestionInteractionResponse>;

export interface PendingQuestionInteraction extends QuestionInteractionRequest {
	createdAt: string;
}

export interface QuestionRuntimeOptions {
	handler?: QuestionInteractionHandler;
	now?: () => Date;
}

const askUserQuestionValidator = Compile(ASK_USER_QUESTION_PARAMETERS);
const questionAnswersValidator = Compile(Type.Array(QUESTION_ANSWER_SCHEMA));

const RESERVED_OTHER_LABELS = new Set([
	"other",
	"other...",
	"other…",
	"something else",
	"none of the above",
	"其他",
	"其它",
	"其他选项",
	"其它选项",
	"别的",
	"以上都不是",
	"都不是",
	"自定义",
	"自行输入",
	"手动输入",
	"自由输入",
]);

function normalizeText(value: string): string {
	return value.normalize("NFKC");
}

function isReservedOtherLabel(value: string): boolean {
	const comparison = value.trim().toLocaleLowerCase("en-US");
	if (RESERVED_OTHER_LABELS.has(comparison)) return true;
	const compact = comparison.replace(/[\s._\-:：()（）…]+/g, "");
	return (
		/^other(?:option|answer|pleasespecify)?$/.test(compact) ||
		/^(?:其他|其它|别的)(?:选项|答案|请说明)?$/.test(compact) ||
		/^(?:自定义|手动输入|自由输入|自行输入)(?:选项|答案)?$/.test(compact)
	);
}

function countCharacters(value: string): number {
	return [...value].length;
}

function truncateCharacters(value: string, maximum: number): string {
	return [...value].slice(0, maximum).join("");
}

function normalizeAndValidateInput(input: AskUserQuestionInput): AskUserQuestionInput {
	if (!askUserQuestionValidator.Check(input)) throw new Error("ask_user_question received invalid parameters");
	if (
		!Array.isArray(input.questions) ||
		input.questions.length < 1 ||
		input.questions.length > QUESTION_LIMITS.maxQuestions
	) {
		throw new Error(`questions must contain 1-${QUESTION_LIMITS.maxQuestions} items`);
	}
	const questions = input.questions.map((question, questionIndex) => {
		if (
			!Array.isArray(question.options) ||
			question.options.length < QUESTION_LIMITS.minOptions ||
			question.options.length > QUESTION_LIMITS.maxOptions
		) {
			throw new Error(
				`questions[${questionIndex}].options must contain ${QUESTION_LIMITS.minOptions}-${QUESTION_LIMITS.maxOptions} items`,
			);
		}
		const normalizedQuestion = normalizeText(question.question);
		const normalizedHeader = normalizeText(question.header);
		if (normalizedQuestion.trim().length === 0) {
			throw new Error(`questions[${questionIndex}].question must not be blank`);
		}
		if (normalizedHeader.trim().length === 0) {
			throw new Error(`questions[${questionIndex}].header must not be blank`);
		}
		if (countCharacters(normalizedQuestion) > QUESTION_LIMITS.maxQuestionLength) {
			throw new Error(
				`questions[${questionIndex}].question exceeds ${QUESTION_LIMITS.maxQuestionLength} characters`,
			);
		}
		if (countCharacters(normalizedHeader) > QUESTION_LIMITS.maxHeaderLength) {
			throw new Error(`questions[${questionIndex}].header exceeds ${QUESTION_LIMITS.maxHeaderLength} characters`);
		}
		if (question.multiSelect && question.options.some((option) => option.preview !== undefined)) {
			throw new Error(`questions[${questionIndex}] cannot use Markdown preview with multiSelect`);
		}
		const seenLabels = new Set<string>();
		const options = question.options.map((option, optionIndex) => {
			const label = normalizeText(option.label);
			const description = normalizeText(option.description);
			const preview = option.preview === undefined ? undefined : normalizeText(option.preview);
			if (label.trim().length === 0) {
				throw new Error(`questions[${questionIndex}].options[${optionIndex}].label must not be blank`);
			}
			if (description.trim().length === 0) {
				throw new Error(`questions[${questionIndex}].options[${optionIndex}].description must not be blank`);
			}
			if (countCharacters(label) > QUESTION_LIMITS.maxLabelLength) {
				throw new Error(
					`questions[${questionIndex}].options[${optionIndex}].label exceeds ${QUESTION_LIMITS.maxLabelLength} characters`,
				);
			}
			if (countCharacters(description) > QUESTION_LIMITS.maxDescriptionLength) {
				throw new Error(
					`questions[${questionIndex}].options[${optionIndex}].description exceeds ${QUESTION_LIMITS.maxDescriptionLength} characters`,
				);
			}
			if (preview !== undefined && countCharacters(preview) > QUESTION_LIMITS.maxPreviewLength) {
				throw new Error(
					`questions[${questionIndex}].options[${optionIndex}].preview exceeds ${QUESTION_LIMITS.maxPreviewLength} characters`,
				);
			}
			const comparisonLabel = label.trim().toLocaleLowerCase("en-US");
			if (isReservedOtherLabel(label)) {
				throw new Error(
					`questions[${questionIndex}].options[${optionIndex}].label must not duplicate the built-in Other option`,
				);
			}
			if (seenLabels.has(comparisonLabel)) {
				throw new Error(`questions[${questionIndex}] contains duplicate option label ${JSON.stringify(label)}`);
			}
			seenLabels.add(comparisonLabel);
			return { label, description, ...(preview === undefined ? {} : { preview }) };
		});
		return {
			question: normalizedQuestion,
			header: normalizedHeader,
			options,
			multiSelect: question.multiSelect,
		};
	});
	const seenHeaders = new Set<string>();
	for (const question of questions) {
		const header = question.header.trim().toLocaleLowerCase("en-US");
		if (seenHeaders.has(header))
			throw new Error(`questions contains duplicate header ${JSON.stringify(question.header)}`);
		seenHeaders.add(header);
	}
	const totalPreviewLength = questions.reduce(
		(total, question) =>
			total +
			question.options.reduce((questionTotal, option) => questionTotal + countCharacters(option.preview ?? ""), 0),
		0,
	);
	if (totalPreviewLength > QUESTION_LIMITS.maxTotalPreviewLength) {
		throw new Error(`questions preview budget exceeds ${QUESTION_LIMITS.maxTotalPreviewLength} characters`);
	}
	return { questions };
}

export function validateQuestionAnswers(
	questions: readonly UserQuestion[],
	answers: readonly QuestionAnswer[],
): QuestionAnswer[] {
	if (!questionAnswersValidator.Check(answers)) throw new Error("Question response contains invalid answers");
	if (answers.length !== questions.length) {
		throw new Error(`Expected ${questions.length} answers, received ${answers.length}`);
	}
	return questions.map((question, index) => {
		const answer = answers[index];
		if (!answer || normalizeText(answer.header) !== question.header) {
			throw new Error(`Answer ${index + 1} does not match question header ${JSON.stringify(question.header)}`);
		}
		const knownLabels = new Set(question.options.map((option) => option.label));
		const selectedLabels = answer.selectedLabels.map(normalizeText);
		if (selectedLabels.some((label) => !knownLabels.has(label))) {
			throw new Error(`Answer for ${JSON.stringify(question.header)} contains an unknown option label`);
		}
		if (new Set(selectedLabels).size !== selectedLabels.length) {
			throw new Error(`Answer for ${JSON.stringify(question.header)} contains duplicate option labels`);
		}
		const customAnswer = answer.customAnswer === undefined ? undefined : normalizeText(answer.customAnswer).trim();
		const notes = answer.notes === undefined ? undefined : normalizeText(answer.notes).trim();
		if (customAnswer !== undefined && countCharacters(customAnswer) > QUESTION_LIMITS.maxCustomAnswerLength) {
			throw new Error(`Custom answer for ${JSON.stringify(question.header)} is too long`);
		}
		if (notes !== undefined && countCharacters(notes) > QUESTION_LIMITS.maxNotesLength) {
			throw new Error(`Notes for ${JSON.stringify(question.header)} are too long`);
		}
		const choiceCount = selectedLabels.length + (customAnswer ? 1 : 0);
		if (question.multiSelect ? choiceCount < 1 : choiceCount !== 1) {
			throw new Error(
				`Answer for ${JSON.stringify(question.header)} must contain ${question.multiSelect ? "at least one" : "exactly one"} selection`,
			);
		}
		return {
			header: question.header,
			selectedLabels,
			...(customAnswer ? { customAnswer } : {}),
			...(notes ? { notes } : {}),
		};
	});
}

function resultText(result: QuestionResult): string {
	switch (result.status) {
		case "answered":
			return `User answered ${result.answers.length} question${result.answers.length === 1 ? "" : "s"}.`;
		case "cancelled":
			return "User cancelled the question request.";
		case "rejected":
			return `User rejected the question request${result.diagnostic ? `: ${result.diagnostic}` : "."}`;
		case "interaction_required":
			return "User interaction is required, but no question handler is available in this run mode.";
		case "interaction_error":
			return `Question interaction failed: ${result.diagnostic ?? "Unknown error"}`;
	}
}

export class QuestionRuntime {
	private handler: QuestionInteractionHandler | undefined;
	private readonly now: () => Date;
	private active: { request: PendingQuestionInteraction; controller: AbortController } | undefined;
	private readonly listeners = new Set<(pending: PendingQuestionInteraction | undefined) => void>();

	constructor(options: QuestionRuntimeOptions = {}) {
		this.handler = options.handler;
		this.now = options.now ?? (() => new Date());
	}

	setHandler(handler: QuestionInteractionHandler | undefined): void {
		this.handler = handler;
	}

	getPending(): PendingQuestionInteraction | undefined {
		return this.active ? structuredClone(this.active.request) : undefined;
	}

	subscribe(listener: (pending: PendingQuestionInteraction | undefined) => void): () => void {
		this.listeners.add(listener);
		try {
			listener(this.getPending());
		} catch {
			// Observers are non-authoritative.
		}
		return () => this.listeners.delete(listener);
	}

	private emitPending(pending: PendingQuestionInteraction | undefined): void {
		for (const listener of this.listeners) {
			try {
				listener(pending ? structuredClone(pending) : undefined);
			} catch {
				// Observers are non-authoritative.
			}
		}
	}

	cancelPending(): void {
		this.active?.controller.abort();
	}

	async execute(
		requestId: string,
		input: AskUserQuestionInput,
		signal?: AbortSignal,
	): Promise<AgentToolResult<QuestionResult>> {
		const createdAt = this.now().toISOString();
		const finish = (
			status: QuestionResult["status"],
			answers: QuestionAnswer[] = [],
			diagnostic?: string,
		): AgentToolResult<QuestionResult> => {
			const normalizedDiagnostic = diagnostic
				? truncateCharacters(normalizeText(diagnostic), QUESTION_LIMITS.maxDiagnosticLength)
				: undefined;
			const result: QuestionResult = {
				version: QUESTION_RESULT_VERSION,
				requestId,
				status,
				answers,
				createdAt,
				...(normalizedDiagnostic ? { diagnostic: normalizedDiagnostic } : {}),
			};
			return { content: [{ type: "text", text: resultText(result) }], details: result };
		};

		let normalized: AskUserQuestionInput;
		try {
			normalized = normalizeAndValidateInput(input);
		} catch (error) {
			return finish("interaction_error", [], error instanceof Error ? error.message : String(error));
		}
		if (this.active) {
			return finish("interaction_error", [], `Question request ${this.active.request.requestId} is already active`);
		}
		if (signal?.aborted) return finish("cancelled");
		if (!this.handler) {
			return finish("interaction_required", [], "No question interaction handler is configured");
		}

		const controller = new AbortController();
		const request: PendingQuestionInteraction = {
			requestId,
			questions: normalized.questions,
			createdAt,
		};
		this.active = { request, controller };
		this.emitPending(request);
		const onAbort = (): void => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const response = await Promise.race([
				this.handler({ requestId, questions: normalized.questions }, controller.signal),
				new Promise<QuestionInteractionResponse>((resolve) => {
					if (controller.signal.aborted) {
						resolve({ status: "cancelled" });
						return;
					}
					controller.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
				}),
			]);
			if (response.status === "cancelled") return finish("cancelled");
			if (response.status === "rejected") return finish("rejected", [], response.diagnostic);
			if (response.status === "error") return finish("interaction_error", [], response.diagnostic);
			try {
				return finish("answered", validateQuestionAnswers(normalized.questions, response.answers));
			} catch (error) {
				return finish("interaction_error", [], error instanceof Error ? error.message : String(error));
			}
		} catch (error) {
			return finish("interaction_error", [], error instanceof Error ? error.message : String(error));
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (this.active?.request.requestId === requestId) {
				this.active = undefined;
				this.emitPending(undefined);
			}
		}
	}
}

export function createAskUserQuestionToolDefinition(
	runtime = new QuestionRuntime(),
): ToolDefinition<typeof ASK_USER_QUESTION_PARAMETERS, QuestionResult> {
	return {
		name: ASK_USER_QUESTION_TOOL_NAME,
		label: "Question",
		description:
			"Ask the user one to four bounded multiple-choice questions when a decision is required. The runtime adds an Other option and supports optional notes.",
		promptSnippet: "Ask the user bounded single- or multi-select questions and receive structured answers",
		promptGuidelines: [
			"Use ask_user_question only when a user decision is required to proceed; otherwise make a reasonable assumption and continue.",
			"Do not ask questions that can be answered by reading available files, documents, tool results, or prior conversation context.",
			"Do not use ask_user_question for routine confirmations, progress updates, or decisions that have a safe obvious default.",
			"Never use ask_user_question to request passwords, API keys, access tokens, private keys, or other secrets.",
			"Keep questions focused, provide 2-4 concrete options, and do not add an Other option because the runtime adds it automatically.",
		],
		parameters: ASK_USER_QUESTION_PARAMETERS,
		executionMode: "sequential",
		execute: async (toolCallId, params, signal) => await runtime.execute(toolCallId, params, signal),
		renderCall: (_args, currentTheme, context) =>
			new Text(
				currentTheme.fg(
					"toolTitle",
					currentTheme.bold(
						context.executionStarted && context.isPartial ? "Question — waiting for user response" : "Question",
					),
				),
				0,
				0,
			),
		renderResult: (result, _options, currentTheme) => {
			const details = result.details;
			if (details.status === "interaction_error") {
				return new Text(currentTheme.fg("error", details.diagnostic ?? "Question interaction failed"), 0, 0);
			}
			if (details.status === "interaction_required") {
				return new Text(
					currentTheme.fg("warning", "Interaction required — no question handler is available"),
					0,
					0,
				);
			}
			if (details.status === "cancelled") {
				return new Text(currentTheme.fg("muted", "Cancelled by user"), 0, 0);
			}
			if (details.status === "rejected") {
				return new Text(currentTheme.fg("warning", details.diagnostic ?? "Rejected by user"), 0, 0);
			}
			const summary = details.answers
				.map((answer) => {
					const values = [
						...answer.selectedLabels,
						...(answer.customAnswer ? [`Other: ${answer.customAnswer}`] : []),
					];
					return `${answer.header}: ${values.join(", ")}`;
				})
				.join(" · ");
			const concise = countCharacters(summary) > 240 ? `${truncateCharacters(summary, 239)}…` : summary;
			return new Text(currentTheme.fg("success", concise || "Answered"), 0, 0);
		},
	};
}
