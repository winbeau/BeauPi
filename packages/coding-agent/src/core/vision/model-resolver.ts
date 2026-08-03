import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type ReviewModelResolution,
	type ReviewModelRuntime,
	resolveModelSetting,
	reviewModelLabel,
} from "../review/model-resolver.ts";
import { DEFAULT_VISION_MODEL } from "../settings-manager.ts";

export type VisionModelRuntime = ReviewModelRuntime;

export interface VisionModelResolverOptions {
	modelRuntime: VisionModelRuntime;
	getModelSetting: () => string | undefined;
	getPreferredProvider: () => string | undefined;
}

export type VisionModelResolution = ReviewModelResolution;

export function visionModelLabel(model: Model<Api>): string {
	return reviewModelLabel(model);
}

/**
 * Resolves the `vision.model` setting (like `review.model`):
 * `provider/model` fixes the provider; a bare id follows the preferred provider
 * first, then any configured provider exposing that id.
 */
export class VisionModelResolver {
	private readonly modelRuntime: VisionModelRuntime;
	private readonly getModelSetting: () => string | undefined;
	private readonly getPreferredProvider: () => string | undefined;

	constructor(options: VisionModelResolverOptions) {
		this.modelRuntime = options.modelRuntime;
		this.getModelSetting = options.getModelSetting;
		this.getPreferredProvider = options.getPreferredProvider;
	}

	resolve(): VisionModelResolution {
		return resolveModelSetting(
			this.modelRuntime,
			this.getModelSetting,
			this.getPreferredProvider,
			DEFAULT_VISION_MODEL,
			"Vision",
		);
	}
}
