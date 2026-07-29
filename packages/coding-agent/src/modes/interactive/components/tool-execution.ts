import {
	type Component,
	Container,
	getCapabilities,
	Image,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import { getTaskLedgerToolDetails } from "../../../core/state/task-ledger.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import {
	BEAUPI_GUTTERS,
	type BeauPiToolState,
	continuationGutter,
	fitSingleLine,
	resultGutter,
	toolStateSymbol,
} from "./beaupi-style.ts";

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}

const TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
	read: "Read",
	edit: "Update",
	write: "Write",
	bash: "Bash",
	grep: "Search",
	find: "Find",
	ls: "List",
	web_search: "Web Search",
	web_fetch: "Fetch",
	delegate_task: "Agent",
	workflow_run: "Workflow",
	background_start: "Background",
	monitor_attach: "Monitor Attach",
	monitor_list: "Monitor List",
	monitor_status: "Monitor Status",
	monitor_logs: "Monitor Logs",
	monitor_wait: "Monitor Wait",
	monitor_stop: "Monitor Stop",
	docs_search: "Docs Search",
	docs_read: "Docs Read",
	docs_resolve_task: "Docs Resolve",
});

const GROUPABLE_TOOL_NAMES = new Set(["read", "grep", "find", "ls", "bash"]);

function safeWidth(width: number): number {
	return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function trimOuterEmptyLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && visibleWidth(lines[start] ?? "") === 0) start++;
	while (end > start && visibleWidth(lines[end - 1] ?? "") === 0) end--;
	return lines.slice(start, end);
}

function removeGapAfterTitle(lines: string[]): string[] {
	if (lines.length < 2) return lines;
	let bodyStart = 1;
	while (bodyStart < lines.length && visibleWidth(lines[bodyStart] ?? "") === 0) bodyStart++;
	return [lines[0]!, ...lines.slice(bodyStart)];
}

function prefixLine(prefix: string, line: string, width: number): string {
	const availableWidth = safeWidth(width);
	if (availableWidth === 0) return "";
	const prefixWidth = visibleWidth(prefix);
	if (prefixWidth >= availableWidth) return truncateToWidth(prefix, availableWidth, "");
	return `${prefix}${truncateToWidth(line, availableWidth - prefixWidth, "")}`;
}

function summarizeValue(value: unknown): string | undefined {
	if (typeof value === "string") {
		const firstLine = value.split(/\r\n|\r|\n/, 1)[0] ?? "";
		return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
	return undefined;
}

function summarizeArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	for (const key of ["path", "file_path", "command", "pattern", "query", "url", "task"]) {
		const summary = summarizeValue(record[key]);
		if (summary !== undefined && summary !== "") return summary;
	}
	for (const value of Object.values(record)) {
		const summary = summarizeValue(value);
		if (summary !== undefined && summary !== "") return summary;
	}
	return "";
}

function isCancellationResult(result: ToolExecutionComponent["result"]): boolean {
	return getTaskLedgerToolDetails(result?.details)?.status === "cancelled";
}

class MinimalToolShellComponent implements Component {
	private callComponent: Component | undefined;
	private resultComponent: Component | undefined;
	private readonly getState: () => BeauPiToolState;

	constructor(getState: () => BeauPiToolState) {
		this.getState = getState;
	}

	setComponents(callComponent: Component | undefined, resultComponent: Component | undefined): void {
		this.callComponent = callComponent;
		this.resultComponent = resultComponent;
	}

	invalidate(): void {
		this.callComponent?.invalidate();
		this.resultComponent?.invalidate();
	}

	render(width: number): string[] {
		const availableWidth = safeWidth(width);
		if (availableWidth === 0) return [];

		const contentWidth = Math.max(1, availableWidth - visibleWidth(BEAUPI_GUTTERS.toolResult));
		const callLines = this.callComponent
			? removeGapAfterTitle(trimOuterEmptyLines(this.callComponent.render(contentWidth)))
			: [];
		const resultLines = this.resultComponent ? trimOuterEmptyLines(this.resultComponent.render(contentWidth)) : [];
		if (callLines.length === 0 && resultLines.length === 0) return [];

		const output: string[] = [];
		if (callLines.length > 0) {
			output.push(prefixLine(`${toolStateSymbol(this.getState(), theme)} `, callLines[0] ?? "", availableWidth));
			for (let index = 1; index < callLines.length; index++) {
				const line = callLines[index] ?? "";
				output.push(
					index === 1
						? resultGutter(line, theme, availableWidth)
						: continuationGutter(line, theme, availableWidth),
				);
			}
		}
		for (let index = 0; index < resultLines.length; index++) {
			const line = resultLines[index] ?? "";
			output.push(
				index === 0 ? resultGutter(line, theme, availableWidth) : continuationGutter(line, theme, availableWidth),
			);
		}
		return output;
	}
}

export class ToolExecutionComponent extends Container {
	private readonly minimalShell: MinimalToolShellComponent;
	private readonly selfRenderContainer = new Container();
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private readonly toolName: string;
	private readonly toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private readonly toolDefinition?: ToolDefinition<any, any>;
	private readonly builtInToolDefinition?: ToolDefinition<any, any>;
	private readonly ui: TUI;
	private readonly cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private readonly convertedImages = new Map<number, { data: string; mimeType: string }>();
	private hideComponent = false;
	private forcedState: BeauPiToolState | undefined;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;
		this.minimalShell = new MinimalToolShellComponent(() => this.getDisplayState());
		this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.minimalShell);
		this.updateDisplay();
	}

	getToolName(): string {
		return this.toolName;
	}

	getDisplayName(): string {
		return TOOL_DISPLAY_NAMES[this.toolName] ?? this.toolDefinition?.label ?? this.toolName;
	}

	getDisplayState(): BeauPiToolState {
		if (this.forcedState) return this.forcedState;
		if (this.result && !this.isPartial) {
			if (isCancellationResult(this.result)) return "cancelled";
			return this.result.isError ? "error" : "success";
		}
		if (this.executionStarted || this.result) return "running";
		return "queued";
	}

	isGroupable(): boolean {
		return GROUPABLE_TOOL_NAMES.has(this.toolName) && !this.hasImageResults();
	}

	hasImageResults(): boolean {
		return this.result?.content.some((item) => item.type === "image") ?? false;
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) return this.toolDefinition?.renderCall;
		if (!this.toolDefinition) return this.builtInToolDefinition.renderCall;
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) return this.toolDefinition?.renderResult;
		if (!this.toolDefinition) return this.builtInToolDefinition.renderResult;
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) return this.toolDefinition?.renderShell ?? "default";
		if (!this.toolDefinition) return this.builtInToolDefinition.renderShell ?? "default";
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		const displayName = this.getDisplayName();
		const summary = summarizeArgs(this.args);
		let text = summary ? `${theme.bold(displayName)}(${summary})` : theme.bold(displayName);
		if (this.expanded && this.args && typeof this.args === "object" && Object.keys(this.args).length > 0) {
			text += `\n${theme.fg("toolOutput", JSON.stringify(this.args, null, 2))}`;
		}
		return {
			render: (width: number) =>
				text.split("\n").map((line) => truncateToWidth(line, Math.max(0, safeWidth(width)), "…")),
			invalidate: () => {},
		};
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) return undefined;
		const lines = output.split("\n");
		const displayLines = this.expanded || this.result?.isError ? lines : lines.slice(-5);
		const hidden = lines.length - displayLines.length;
		const text = [
			...(hidden > 0 ? [theme.fg("dim", `… ${hidden} earlier lines hidden`)] : []),
			...displayLines.map((line) => theme.fg(this.result?.isError ? "error" : "toolOutput", line)),
		].join("\n");
		return {
			render: (width: number) =>
				text.split("\n").map((line) => truncateToWidth(line, Math.max(0, safeWidth(width)), "…")),
			invalidate: () => {},
		};
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.forcedState = undefined;
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	markCancelled(message: string): void {
		this.forcedState = "cancelled";
		this.result = { content: [{ type: "text", text: message }], isError: true };
		this.isPartial = false;
		this.updateDisplay();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty" || !this.result) return;

		const imageBlocks = this.result.content.filter((item) => item.type === "image");
		for (let index = 0; index < imageBlocks.length; index++) {
			const image = imageBlocks[index];
			if (!image?.data || !image.mimeType || image.mimeType === "image/png" || this.convertedImages.has(index)) {
				continue;
			}
			convertToPng(image.data, image.mimeType).then((converted) => {
				if (!converted) return;
				this.convertedImages.set(index, converted);
				this.updateDisplay();
				this.ui.requestRender();
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) return [];
		const availableWidth = safeWidth(width);
		const shell = this.getRenderShell() === "self" ? this.selfRenderContainer : this.minimalShell;
		const contentLines = shell.render(availableWidth);
		if (contentLines.length === 0 && this.imageComponents.length === 0) return [];

		const lines: string[] = contentLines.length > 0 ? ["", ...contentLines] : [];
		for (const image of this.imageComponents) {
			lines.push("");
			lines.push(...image.render(availableWidth));
		}
		return lines;
	}

	private updateDisplay(): void {
		let hasContent = false;
		this.hideComponent = false;
		let callComponent: Component | undefined;
		let resultComponent: Component | undefined;

		if (this.hasRendererDefinition()) {
			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				callComponent = this.createCallFallback();
			} else {
				try {
					callComponent = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = callComponent;
				} catch {
					this.callRendererComponent = undefined;
					callComponent = this.createCallFallback();
				}
			}
			hasContent = callComponent !== undefined;

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					resultComponent = this.createResultFallback();
				} else {
					try {
						resultComponent = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = resultComponent;
					} catch {
						this.resultRendererComponent = undefined;
						resultComponent = this.createResultFallback();
					}
				}
				hasContent = hasContent || resultComponent !== undefined;
			}
		} else {
			callComponent = this.createCallFallback();
			resultComponent = this.createResultFallback();
			hasContent = true;
		}

		if (this.getRenderShell() === "self") {
			this.selfRenderContainer.clear();
			if (callComponent) this.selfRenderContainer.addChild(callComponent);
			if (resultComponent) this.selfRenderContainer.addChild(resultComponent);
		} else {
			this.minimalShell.setComponents(callComponent, resultComponent);
		}

		this.imageComponents = [];
		if (this.result) {
			const imageBlocks = this.result.content.filter((item) => item.type === "image");
			const caps = getCapabilities();
			for (let index = 0; index < imageBlocks.length; index++) {
				const image = imageBlocks[index];
				if (!caps.images || !this.showImages || !image?.data || !image.mimeType) continue;
				const converted = this.convertedImages.get(index);
				const imageData = converted?.data ?? image.data;
				const imageMimeType = converted?.mimeType ?? image.mimeType;
				if (caps.images === "kitty" && imageMimeType !== "image/png") continue;
				this.imageComponents.push(
					new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
						{ maxWidthCells: this.imageWidthCells },
					),
				);
			}
		}

		if (!hasContent && this.imageComponents.length === 0) this.hideComponent = true;
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	getGroupSummary(width: number): string {
		return fitSingleLine(
			[
				{ text: toolStateSymbol(this.getDisplayState(), theme), required: true },
				{ text: this.getDisplayName(), separator: " ", required: true, truncate: true },
			],
			width,
		);
	}
}
