import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { type BeauPiToolState, resultGutter, toolTitle } from "../../modes/interactive/components/beaupi-style.ts";
import { StructuredDiffComponent } from "../../modes/interactive/components/diff.ts";
import { theme as activeTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	applyEditsToNormalizedContent,
	computeEditsDiff,
	detectLineEnding,
	type Edit,
	type EditDiffError,
	type EditDiffResult,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { renderToolPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

type EditPreview = EditDiffResult | EditDiffError;

type EditRenderState = {
	callComponent?: EditCallRenderComponent;
};

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{},
);

export const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		}),
	},
	{},
);

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

export interface EditToolDetails {
	/** Resolved file path modified by the tool. */
	path: string;
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
	/** Resolve a tool path before invoking operations. Defaults to the local cwd resolver. */
	resolvePath?: (path: string, cwd: string) => string;
	/** Override the mutation queue key when the path is not local to this process. */
	mutationQueueKey?: (resolvedPath: string) => string;
	/** Whether to build the pre-execution diff preview. Default: true. */
	previewDiff?: boolean;
	/** Renderer title. Default: Update */
	displayName?: string;
	/** Optional renderer context shown in brackets before the path. */
	displayContext?: string;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as Record<string, unknown>;

	// Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
		} catch {}
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

type RenderableEditArgs = {
	path?: string;
	file_path?: string;
	edits?: Edit[];
	oldText?: string;
	newText?: string;
};

type EditToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: EditToolDetails;
};

class EditCallRenderComponent extends Container {
	preview?: EditPreview;
	previewArgsKey?: string;
	previewPending = false;
	settledError = false;
}

class GutteredTextComponent implements Component {
	private readonly text: string;
	private readonly color: "error" | "warning" | "muted";

	constructor(text: string, color: "error" | "warning" | "muted" = "error") {
		this.text = text;
		this.color = color;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.text.split("\n").map((line) => resultGutter(activeTheme.fg(this.color, line), activeTheme, width));
	}
}

function getEditCallRenderComponent(state: EditRenderState, lastComponent: unknown): EditCallRenderComponent {
	if (lastComponent instanceof EditCallRenderComponent) {
		state.callComponent = lastComponent;
		return lastComponent;
	}
	if (state.callComponent) return state.callComponent;
	const component = new EditCallRenderComponent();
	state.callComponent = component;
	return component;
}

function getRenderablePreviewInput(args: RenderableEditArgs | undefined): { path: string; edits: Edit[] } | null {
	if (!args) {
		return null;
	}

	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
	if (!path) {
		return null;
	}

	if (
		Array.isArray(args.edits) &&
		args.edits.length > 0 &&
		args.edits.every((edit) => typeof edit?.oldText === "string" && typeof edit?.newText === "string")
	) {
		return { path, edits: args.edits };
	}

	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		return { path, edits: [{ oldText: args.oldText, newText: args.newText }] };
	}

	return null;
}

function formatEditCall(
	args: RenderableEditArgs | undefined,
	theme: Theme,
	cwd: string,
	state: BeauPiToolState,
	displayName: string,
	displayContext: string | undefined,
): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	const title = displayContext ? `${displayName} [${displayContext}]` : displayName;
	return toolTitle(title, pathDisplay, state, theme, Number.MAX_SAFE_INTEGER);
}

type EditRenderedResult = { type: "error"; text: string } | { type: "diff"; diff: string };

function formatEditResult(
	preview: EditPreview | undefined,
	result: EditToolResultLike,
	isError: boolean,
): EditRenderedResult | undefined {
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		if (!errorText || errorText === previewError) return undefined;
		return { type: "error", text: errorText };
	}

	const resultDiff = result.details?.diff;
	return resultDiff && resultDiff !== previewDiff ? { type: "diff", diff: resultDiff } : undefined;
}

function buildEditCallComponent(
	component: EditCallRenderComponent,
	args: RenderableEditArgs | undefined,
	theme: Theme,
	cwd: string,
	state: BeauPiToolState,
	displayName: string,
	displayContext: string | undefined,
): EditCallRenderComponent {
	component.clear();
	component.addChild(new Text(formatEditCall(args, theme, cwd, state, displayName, displayContext), 0, 0));
	if (!component.preview) return component;
	component.addChild(
		"error" in component.preview
			? new GutteredTextComponent(component.preview.error)
			: new StructuredDiffComponent(component.preview.diff),
	);
	return component;
}

function getEditToolState(
	component: EditCallRenderComponent,
	context: { executionStarted: boolean; isPartial: boolean; isError: boolean },
): BeauPiToolState {
	if (!context.isPartial) {
		if (context.isError || component.settledError) return "error";
		return "success";
	}
	return context.executionStarted ? "running" : "queued";
}

function setEditPreview(
	component: EditCallRenderComponent,
	preview: EditPreview,
	argsKey: string | undefined,
): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview
			? current.error !== preview.error
			: "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;
	return changed;
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	const displayName = options?.displayName ?? "Update";
	const displayContext = options?.displayContext;
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		promptSnippet:
			"Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		promptGuidelines: [
			"Use edit for precise changes (edits[].oldText must match exactly)",
			"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
			"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
			"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
		],
		parameters: editSchema,
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const { path, edits } = validateEditInput(input);
			const absolutePath = options?.resolvePath?.(path, cwd) ?? resolveToCwd(path, cwd);
			const mutationQueueKey = options?.mutationQueueKey?.(absolutePath);

			return withFileMutationQueue(
				absolutePath,
				async () => {
					// Do not reject from an abort event listener here: that would release the
					// mutation queue while an in-flight filesystem operation may still finish.
					// Checking signal.aborted after each await observes the same aborts while
					// keeping the queue locked until the current operation has settled.
					const throwIfAborted = (): void => {
						if (signal?.aborted) throw new Error("Operation aborted");
					};

					throwIfAborted();

					// Check if file exists.
					try {
						await ops.access(absolutePath);
					} catch (error: unknown) {
						throwIfAborted();
						const errorMessage =
							error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
						throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
					}
					throwIfAborted();

					// Read the file.
					const buffer = await ops.readFile(absolutePath);
					const rawContent = buffer.toString("utf-8");
					throwIfAborted();

					// Strip BOM before matching. The model will not include an invisible BOM in oldText.
					const { bom, text: content } = stripBom(rawContent);
					const originalEnding = detectLineEnding(content);
					const normalizedContent = normalizeToLF(content);
					const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
					throwIfAborted();

					const finalContent = bom + restoreLineEndings(newContent, originalEnding);
					await ops.writeFile(absolutePath, finalContent);
					throwIfAborted();

					const diffResult = generateDiffString(baseContent, newContent);
					const patch = generateUnifiedPatch(path, baseContent, newContent);
					return {
						content: [
							{
								type: "text",
								text: `Successfully replaced ${edits.length} block(s) in ${path}.`,
							},
						],
						details: {
							path: absolutePath,
							diff: diffResult.diff,
							patch,
							firstChangedLine: diffResult.firstChangedLine,
						},
					};
				},
				mutationQueueKey ? { key: mutationQueueKey } : undefined,
			);
		},
		renderCall(args, theme, context) {
			const component = getEditCallRenderComponent(context.state, context.lastComponent);
			const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);
			const argsKey = previewInput
				? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
				: undefined;

			if (component.previewArgsKey !== argsKey) {
				component.preview = undefined;
				component.previewArgsKey = argsKey;
				component.previewPending = false;
				component.settledError = false;
			}

			if (
				context.argsComplete &&
				previewInput &&
				!component.preview &&
				!component.previewPending &&
				options?.previewDiff !== false
			) {
				component.previewPending = true;
				const requestKey = argsKey;
				void computeEditsDiff(previewInput.path, previewInput.edits, context.cwd).then((preview) => {
					if (component.previewArgsKey === requestKey) {
						setEditPreview(component, preview, requestKey);
						context.invalidate();
					}
				});
			}

			return buildEditCallComponent(
				component,
				args,
				theme,
				context.cwd,
				getEditToolState(component, context),
				displayName,
				displayContext,
			);
		},
		renderResult(result, _options, theme, context) {
			const callComponent = context.state.callComponent;
			const previewInput = getRenderablePreviewInput(context.args as RenderableEditArgs | undefined);
			const argsKey = previewInput
				? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
				: undefined;
			const typedResult = result as EditToolResultLike;
			const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
			if (callComponent) {
				if (typeof resultDiff === "string") {
					setEditPreview(
						callComponent,
						{ diff: resultDiff, firstChangedLine: typedResult.details?.firstChangedLine },
						argsKey,
					);
				}
				callComponent.settledError = context.isError;
				buildEditCallComponent(
					callComponent,
					context.args as RenderableEditArgs | undefined,
					theme,
					context.cwd,
					getEditToolState(callComponent, context),
					displayName,
					displayContext,
				);
			}

			const output = formatEditResult(callComponent?.preview, typedResult, context.isError);
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			if (!output) return component;
			component.addChild(
				output.type === "error" ? new GutteredTextComponent(output.text) : new StructuredDiffComponent(output.diff),
			);
			return component;
		},
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
