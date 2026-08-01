import type { Api, AssistantMessage, Context, Model, ModelsSimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { ReviewModelResolver } from "../src/core/review/model-resolver.ts";
import { ModelTaskReviewer, parseTaskPatchOutput } from "../src/core/tasks/task-reviewer.ts";
import type { DynamicTaskFactV1, DynamicTaskPlanV1 } from "../src/core/tasks/types.ts";
import { fauxModel } from "./test-harness.ts";

const usage: Usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model(provider: string): Model<Api> {
	return { ...fauxModel, provider, id: "review-small", name: `${provider}/review-small` };
}

function response(
	provider: string,
	text: string,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: fauxModel.api,
		provider,
		model: "review-small",
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

function snapshot(): DynamicTaskPlanV1 {
	return {
		version: 1,
		planId: "plan-1",
		revision: 3,
		goal: "Implement feature",
		createdAt: 1,
		updatedAt: 3,
		factSequence: 1,
		tasks: [
			{
				id: "implement",
				title: "Implement feature",
				status: "active",
				dependsOn: [],
				matchHints: ["src/a.ts"],
				activity: "Editing",
				evidence: [],
				blockedBy: [],
				createdAt: 1,
				updatedAt: 3,
			},
		],
		facts: [fact()],
	};
}

function fact(): DynamicTaskFactV1 {
	return {
		version: 1,
		sequence: 1,
		id: "verify:check-1:passed",
		kind: "verification",
		ref: "check-1",
		status: "passed",
		summary: "Verification passed",
		createdAt: 3,
	};
}

function createReviewer(
	completeSimple: (
		model: Model<Api>,
		context: Context,
		options?: ModelsSimpleStreamOptions,
	) => Promise<AssistantMessage>,
	providers = ["preferred", "fallback"],
) {
	const models = providers.map(model);
	const runtime = {
		getModel: (provider: string, id: string) =>
			models.find((candidate) => candidate.provider === provider && candidate.id === id),
		getModels: () => models,
		hasConfiguredAuth: () => true,
		completeSimple,
	};
	const resolver = new ReviewModelResolver({
		modelRuntime: runtime,
		getModelSetting: () => "review-small",
		getPreferredProvider: () => "preferred",
	});
	return new ModelTaskReviewer({ modelRuntime: runtime, modelResolver: resolver });
}

function reviewInput(overrides: Record<string, unknown> = {}) {
	return {
		snapshot: snapshot(),
		expectedRevision: 3,
		factsHash: "a".repeat(64),
		lastReviewedFactsHash: undefined,
		facts: [fact()],
		trigger: "agent_settled" as const,
		limits: { timeoutMs: 1_000, maxInputCharacters: 16_000, maxOutputCharacters: 16_000 },
		...overrides,
	};
}

describe("ModelTaskReviewer", () => {
	it("returns a strict valid patch with no Tools and no feature-specific maxTokens", async () => {
		let requestContext: Context | undefined;
		let requestOptions: ModelsSimpleStreamOptions | undefined;
		const reviewer = createReviewer(async (_model, context, options) => {
			requestContext = context;
			requestOptions = options;
			return response(
				"preferred",
				`<task_patch>{"version":1,"expectedRevision":3,"factsHash":"${"a".repeat(64)}","updates":[{"id":"implement","status":"completed","activity":"Verified","evidence":["verify:check-1:passed"]}]}</task_patch>`,
			);
		});
		const result = await reviewer.review(reviewInput());
		expect(result).toMatchObject({ status: "completed", model: "preferred/review-small" });
		expect(result.patch?.updates[0]).toMatchObject({ id: "implement", status: "completed" });
		expect(requestContext).not.toHaveProperty("tools");
		expect(requestOptions).toMatchObject({ cacheRetention: "none" });
		expect(requestOptions).not.toHaveProperty("maxTokens");
	});

	it("performs zero model calls when the facts hash is unchanged", async () => {
		const completeSimple = vi.fn(async () => response("preferred", "unused"));
		const reviewer = createReviewer(completeSimple);
		const result = await reviewer.review(reviewInput({ lastReviewedFactsHash: "a".repeat(64) }));
		expect(result.status).toBe("skipped");
		expect(completeSimple).not.toHaveBeenCalled();
	});

	it("keeps bounded input as valid structured JSON instead of slicing it mid-value", async () => {
		let material = "";
		const reviewer = createReviewer(async (_model, context) => {
			const text = context.messages
				.filter((message) => message.role === "user")
				.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
				.map((part) => (part.type === "text" ? part.text : ""))
				.join("");
			material = text.match(/<task_review_input>([\s\S]*)<\/task_review_input>/)?.[1] ?? "";
			return response(
				"preferred",
				`<task_patch>{"version":1,"expectedRevision":3,"factsHash":"${"a".repeat(64)}","updates":[{"id":"implement","activity":"Bounded"}]}</task_patch>`,
			);
		});
		const largeSnapshot = snapshot();
		largeSnapshot.goal = "goal ".repeat(300);
		largeSnapshot.tasks[0]!.activity = "activity ".repeat(300);
		largeSnapshot.tasks[0]!.evidence = Array.from(
			{ length: 32 },
			(_, index) => `evidence-${index}-${"x".repeat(100)}`,
		);
		const result = await reviewer.review(
			reviewInput({
				snapshot: largeSnapshot,
				facts: Array.from({ length: 8 }, (_, index) => ({
					...fact(),
					sequence: index + 1,
					id: `fact-${index}`,
					summary: "fact summary ".repeat(100),
				})),
				limits: { timeoutMs: 1_000, maxInputCharacters: 256, maxOutputCharacters: 16_000 },
			}),
		);
		expect(result).toMatchObject({ status: "completed", inputTruncated: true });
		expect(material.length).toBeLessThanOrEqual(256);
		expect(() => JSON.parse(material)).not.toThrow();
	});

	it("preserves stable evidence IDs without truncating protocol values", async () => {
		const evidenceId = `file:${"x".repeat(230)}`;
		let suppliedEvidenceId: string | undefined;
		const reviewer = createReviewer(async (_model, context) => {
			const text = context.messages
				.filter((message) => message.role === "user")
				.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
				.map((part) => (part.type === "text" ? part.text : ""))
				.join("");
			const material = text.match(/<task_review_input>([\s\S]*)<\/task_review_input>/)?.[1] ?? "{}";
			const payload = JSON.parse(material) as { facts?: Array<{ id?: string }> };
			suppliedEvidenceId = payload.facts?.[0]?.id;
			return response(
				"preferred",
				`<task_patch>{"version":1,"expectedRevision":3,"factsHash":"${"a".repeat(64)}","updates":[{"id":"implement","activity":"Evidence retained","evidence":["${evidenceId}"]}]}</task_patch>`,
			);
		});
		const result = await reviewer.review(
			reviewInput({
				facts: [{ ...fact(), id: evidenceId }],
			}),
		);
		expect(result).toMatchObject({ status: "completed" });
		expect(suppliedEvidenceId).toBe(evidenceId);
		expect(result.patch?.updates[0]?.evidence).toEqual([evidenceId]);
	});

	it("falls back after provider failure or malformed output and aggregates usage", async () => {
		const attempts: string[] = [];
		const reviewer = createReviewer(async (candidate) => {
			attempts.push(candidate.provider);
			if (candidate.provider === "preferred") return response("preferred", "malformed");
			return response(
				"fallback",
				`<task_patch>{"version":1,"expectedRevision":3,"factsHash":"${"a".repeat(64)}","updates":[{"id":"implement","activity":"Still active"}]}</task_patch>`,
			);
		});
		const result = await reviewer.review(reviewInput());
		expect(attempts).toEqual(["preferred", "fallback"]);
		expect(result).toMatchObject({ status: "completed", model: "fallback/review-small" });
		expect(result.usage).toMatchObject({ input: 20, output: 10, totalTokens: 30 });
	});

	it("rejects structural, duplicate, unknown-id, and revision-mismatched output", () => {
		expect(
			parseTaskPatchOutput(
				`<task_patch>{"version":1,"expectedRevision":3,"factsHash":"${"a".repeat(64)}","updates":[{"id":"implement","title":"rename"}]}</task_patch>`,
				3,
				"a".repeat(64),
				new Set(["implement"]),
			),
		).toBeUndefined();
		expect(
			parseTaskPatchOutput(
				`<task_patch>{"version":1,"expectedRevision":2,"factsHash":"${"a".repeat(64)}","updates":[{"id":"implement","activity":"x"}]}</task_patch>`,
				3,
				"a".repeat(64),
				new Set(["implement"]),
			),
		).toBeUndefined();
		expect(
			parseTaskPatchOutput(
				`<task_patch>{"version":1,"expectedRevision":3,"factsHash":"${"a".repeat(64)}","updates":[{"id":"missing","activity":"x"}]}</task_patch>`,
				3,
				"a".repeat(64),
				new Set(["implement"]),
			),
		).toBeUndefined();
	});

	it("returns timeout and abort without a patch", async () => {
		const reviewer = createReviewer(
			async (_model, _context, options) =>
				await new Promise<AssistantMessage>((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
						once: true,
					});
				}),
			["preferred"],
		);
		const timedOut = await reviewer.review(reviewInput({ limits: { ...reviewInput().limits, timeoutMs: 5 } }));
		expect(timedOut).toMatchObject({ status: "timed_out", patch: undefined });

		const controller = new AbortController();
		controller.abort();
		const aborted = await reviewer.review(reviewInput({ factsHash: "b".repeat(64) }), controller.signal);
		expect(aborted).toMatchObject({ status: "aborted", patch: undefined });
	});
});
