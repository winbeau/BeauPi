import { Compile } from "typebox/compile";
import type { AgentPool } from "../agents/agent-pool.ts";
import { PROGRESS_REVIEW_OUTPUT_SCHEMA } from "./schema.ts";
import {
	BACKGROUND_DETAILS_VERSION,
	type BackgroundProgressReviewer,
	type ProgressReviewerInput,
	type ProgressReviewV1,
} from "./types.ts";

const outputValidator = Compile(PROGRESS_REVIEW_OUTPUT_SCHEMA);

interface ProgressReviewOutput {
	version: 1;
	state: ProgressReviewV1["state"];
	summary: string;
	shouldWakeCoordinator: boolean;
	suggestedAction?: string;
}

export class AgentPoolProgressReviewer implements BackgroundProgressReviewer {
	private readonly pool: AgentPool;
	private readonly now: () => number;

	constructor(pool: AgentPool, now: () => number = () => Date.now()) {
		this.pool = pool;
		this.now = now;
	}

	async review(input: ProgressReviewerInput, signal?: AbortSignal): Promise<ProgressReviewV1> {
		const boundedLog = input.newLog.slice(-input.config.maxInputCharacters);
		const prompt = [
			"Review one background task using only the supplied structured facts.",
			"Do not call tools, modify files, delegate, or infer facts absent from the input.",
			"Return exactly one <progress_review> JSON block with version, state, summary, shouldWakeCoordinator, and optional suggestedAction.",
			`Task ID: ${input.taskId}`,
			`Goal: ${input.goal}`,
			`Runtime ms: ${input.runtimeMs}`,
			`Previous summary: ${input.previousSummary ?? "none"}`,
			`Resources: ${JSON.stringify(input.resources ?? {})}`,
			`New log hash: ${input.logHash}`,
			"New log:",
			boundedLog,
		].join("\n");
		const result = await this.pool.delegateTask(
			{
				task: prompt,
				profile: "reviewer",
				allowFileModifications: false,
				budget: {
					maxTokens: input.config.maxOutputTokens,
					maxTurns: 1,
					timeoutMs: input.config.timeoutMs,
				},
				cancelStrategy: "abort",
			},
			signal,
		);
		if (result.status !== "completed") {
			throw new Error(result.error?.message ?? `Progress reviewer ended with ${result.status}`);
		}
		const parsed = parseProgressReviewOutput(result.summary);
		if (!parsed) throw new Error("Progress reviewer returned invalid structured output");
		return {
			...parsed,
			version: BACKGROUND_DETAILS_VERSION,
			reviewedAt: this.now(),
			logHash: input.logHash,
		};
	}
}

export function parseProgressReviewOutput(text: string): ProgressReviewOutput | undefined {
	const match = text.match(/^\s*<progress_review>\s*([\s\S]*?)\s*<\/progress_review>\s*$/);
	if (!match?.[1]) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(match[1]);
	} catch {
		return undefined;
	}
	if (!outputValidator.Check(value)) return undefined;
	return structuredClone(value as ProgressReviewOutput);
}
