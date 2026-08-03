import type { Context, ImageContent, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { createHash } from "crypto";
import type { ModelRuntime } from "../model-runtime.ts";
import { type VisionModelResolution, VisionModelResolver, visionModelLabel } from "./model-resolver.ts";

export const VISION_DESCRIBE_SYSTEM_PROMPT =
	"You describe images for an AI coding assistant whose main model cannot process images. " +
	"Describe each image accurately and completely in plain text: all visible text verbatim, layout, " +
	"UI elements, colors, and notable objects. Return only the description, no markdown or commentary.";

export const VISION_DESCRIBE_MAX_CHARACTERS = 8000;

export interface VisionServiceOptions {
	modelRuntime: Pick<ModelRuntime, "completeSimple" | "getModel" | "getModels" | "hasConfiguredAuth">;
	getModelSetting: () => string | undefined;
	getPreferredProvider: () => string | undefined;
}

/**
 * Describes images with the configured vision model (like review.model) so that
 * non-multimodal Agent models can still see image attachments and tool results.
 * Descriptions are cached per image data hash for the lifetime of the session.
 */
export class VisionService {
	private readonly modelRuntime: Pick<ModelRuntime, "completeSimple" | "getModel" | "getModels" | "hasConfiguredAuth">;
	private readonly resolver: VisionModelResolver;
	private readonly cache = new Map<string, Promise<string>>();

	constructor(options: VisionServiceOptions) {
		this.modelRuntime = options.modelRuntime;
		this.resolver = new VisionModelResolver({
			modelRuntime: options.modelRuntime,
			getModelSetting: options.getModelSetting,
			getPreferredProvider: options.getPreferredProvider,
		});
	}

	resolve(): VisionModelResolution {
		return this.resolver.resolve();
	}

	/**
	 * Describe an image via the vision model. Returns undefined when no vision model
	 * is available or the description fails; failures are evicted from the cache so a
	 * later turn can retry.
	 */
	async describeImage(image: ImageContent): Promise<string | undefined> {
		const key = createHash("sha256").update(image.data).digest("hex");
		const cached = this.cache.get(key);
		if (cached) {
			try {
				return await cached;
			} catch {
				return undefined;
			}
		}
		const pending = this.describeImageUncached(image);
		this.cache.set(key, pending);
		try {
			return await pending;
		} catch {
			this.cache.delete(key);
			return undefined;
		}
	}

	private async describeImageUncached(image: ImageContent): Promise<string> {
		const resolution = this.resolver.resolve();
		const model = resolution.candidates[0];
		if (!model) {
			throw new Error(resolution.error ?? "No vision model available");
		}
		const context: Context = {
			systemPrompt: VISION_DESCRIBE_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [
						{ type: "image", data: image.data, mimeType: image.mimeType },
						{ type: "text", text: "Describe this image in detail." },
					],
					timestamp: Date.now(),
				},
			],
		};
		const response = await this.modelRuntime.completeSimple(model, context, {
			cacheRetention: "none",
		} satisfies ModelsSimpleStreamOptions);
		const text = response.content
			.filter((part): part is Extract<(typeof response.content)[number], { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("")
			.trim();
		if (!text) {
			throw new Error(`Vision model ${visionModelLabel(model)} returned no text`);
		}
		return text.length > VISION_DESCRIBE_MAX_CHARACTERS
			? `${text.slice(0, VISION_DESCRIBE_MAX_CHARACTERS - 1)}…`
			: text;
	}
}
