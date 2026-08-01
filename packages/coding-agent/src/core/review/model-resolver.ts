import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../model-runtime.ts";
import { DEFAULT_REVIEW_MODEL } from "../settings-manager.ts";

export type ReviewModelRuntime = Pick<ModelRuntime, "getModel" | "getModels" | "hasConfiguredAuth">;

export interface ReviewModelResolverOptions {
	modelRuntime: ReviewModelRuntime;
	getModelSetting: () => string | undefined;
	getPreferredProvider: () => string | undefined;
}

export interface ReviewModelResolution {
	setting: string;
	candidates: readonly Model<Api>[];
	error?: string;
}

export function reviewModelLabel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function mergeReviewUsage(left: Usage | undefined, right: Usage): Usage {
	if (!left) return structuredClone(right);
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		cacheWrite1h:
			left.cacheWrite1h === undefined && right.cacheWrite1h === undefined
				? undefined
				: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0),
		reasoning:
			left.reasoning === undefined && right.reasoning === undefined
				? undefined
				: (left.reasoning ?? 0) + (right.reasoning ?? 0),
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}

export class ReviewModelResolver {
	private readonly modelRuntime: ReviewModelRuntime;
	private readonly getModelSetting: () => string | undefined;
	private readonly getPreferredProvider: () => string | undefined;

	constructor(options: ReviewModelResolverOptions) {
		this.modelRuntime = options.modelRuntime;
		this.getModelSetting = options.getModelSetting;
		this.getPreferredProvider = options.getPreferredProvider;
	}

	resolve(): ReviewModelResolution {
		const setting = this.getModelSetting()?.trim() || DEFAULT_REVIEW_MODEL;
		const separator = setting.indexOf("/");
		if (separator > 0) {
			const provider = setting.slice(0, separator);
			const modelId = setting.slice(separator + 1);
			const candidate = this.modelRuntime.getModel(provider, modelId);
			if (!candidate) {
				return { setting, candidates: [], error: `Review model ${setting} is not present in the model catalog` };
			}
			if (!this.modelRuntime.hasConfiguredAuth(provider)) {
				return { setting, candidates: [], error: `Review provider ${provider} is not configured` };
			}
			return { setting, candidates: [candidate] };
		}

		const preferredProvider = this.getPreferredProvider();
		const candidates: Model<Api>[] = [];
		const seen = new Set<string>();
		const add = (candidate: Model<Api> | undefined): void => {
			if (!candidate || candidate.id !== setting || !this.modelRuntime.hasConfiguredAuth(candidate.provider)) return;
			const key = reviewModelLabel(candidate);
			if (seen.has(key)) return;
			seen.add(key);
			candidates.push(candidate);
		};
		if (preferredProvider) add(this.modelRuntime.getModel(preferredProvider, setting));
		for (const candidate of this.modelRuntime.getModels()) add(candidate);
		return candidates.length > 0
			? { setting, candidates }
			: { setting, candidates, error: `No configured provider exposes review model ${setting}` };
	}
}
