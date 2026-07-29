import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { BEAUPI_STATUS_SYMBOLS, fitSingleLine, resultGutter } from "./beaupi-style.ts";
import { getThinkingSummaryLinesFromBlocks } from "./status-indicator.ts";

const THOUGHT_CHAIN_TITLE = "Thought Chain";
const THOUGHT_ACTIVITY_SUFFIXES = [".", "..", "..."] as const;

function thoughtChainText(text: string): string {
	return theme.fg("toolTitle", theme.bold(theme.italic(text)));
}

class ThoughtChainComponent implements Component {
	private readonly summaries: readonly string[];
	private readonly getLatestSuffix: () => string;

	constructor(summaries: readonly string[], getLatestSuffix: () => string = () => "") {
		this.summaries = summaries;
		this.getLatestSuffix = getLatestSuffix;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const availableWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (availableWidth === 0 || this.summaries.length === 0) return [];
		const latestIndex = this.summaries.length - 1;
		const renderSummary = (summary: string, index: number): string =>
			thoughtChainText(`${summary}${index === latestIndex ? this.getLatestSuffix() : ""}`);
		if (this.summaries.length === 1) {
			return [
				fitSingleLine(
					[
						{
							text: renderSummary(this.summaries[0]!, 0),
							required: true,
							truncate: true,
						},
					],
					availableWidth,
				),
			];
		}

		const visibleSummaries =
			this.summaries.length === 2
				? this.summaries
				: [this.summaries[0]!, "…", this.summaries[this.summaries.length - 1]!];
		return [
			fitSingleLine(
				[{ text: thoughtChainText(THOUGHT_CHAIN_TITLE), required: true, truncate: true }],
				availableWidth,
			),
			...visibleSummaries.map((summary, index) =>
				resultGutter(
					renderSummary(summary, index === visibleSummaries.length - 1 ? latestIndex : index),
					theme,
					availableWidth,
				),
			),
		];
	}
}

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

class AssistantBlockComponent implements Component {
	private component: Component;
	private outputPad: number;

	constructor(component: Component, outputPad: number) {
		this.component = component;
		this.outputPad = outputPad;
	}

	invalidate(): void {
		this.component.invalidate();
	}

	render(width: number): string[] {
		const availableWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (availableWidth === 0) return [""];
		const requestedPadding = Number.isFinite(this.outputPad) ? Math.max(0, Math.floor(this.outputPad)) : 0;
		const horizontalPadding = Math.min(requestedPadding, Math.max(0, Math.floor((availableWidth - 1) / 2)));
		const contentWidth = Math.max(0, availableWidth - horizontalPadding * 2);
		const padding = " ".repeat(horizontalPadding);
		return this.component.render(Math.max(1, contentWidth)).map((line) => {
			const fittedLine = visibleWidth(line) <= contentWidth ? line : truncateToWidth(line, contentWidth, "");
			const rendered = `${padding}${fittedLine}${padding}`;
			return rendered + " ".repeat(Math.max(0, availableWidth - visibleWidth(rendered)));
		});
	}
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private readonly tui?: TUI;
	private thoughtAnimationTimer: ReturnType<typeof setInterval> | undefined;
	private thoughtAnimationPhase = 0;
	private thoughtAnimationEnabled = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		tui?: TUI,
	) {
		super();

		this.tui = tui;
		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setThoughtAnimationEnabled(enabled: boolean): void {
		if (this.thoughtAnimationEnabled === enabled) return;
		this.thoughtAnimationEnabled = enabled;
		if (enabled && this.tui) {
			this.thoughtAnimationPhase = 0;
			this.thoughtAnimationTimer ??= setInterval(() => {
				this.thoughtAnimationPhase = (this.thoughtAnimationPhase + 1) % THOUGHT_ACTIVITY_SUFFIXES.length;
				this.tui?.requestRender();
			}, 500);
			this.thoughtAnimationTimer.unref?.();
		} else if (this.thoughtAnimationTimer) {
			clearInterval(this.thoughtAnimationTimer);
			this.thoughtAnimationTimer = undefined;
			this.thoughtAnimationPhase = 0;
		}
		if (this.lastMessage) this.updateContent(this.lastMessage);
	}

	override render(width: number): string[] {
		const availableWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		const lines = super
			.render(availableWidth)
			.map((line) => (visibleWidth(line) <= availableWidth ? line : truncateToWidth(line, availableWidth, "")));
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;
		this.contentContainer.clear();

		const blocks: Array<{ component: Component; gapBefore: boolean }> = [];
		let previousVisibleKind: "text" | "thinking" | undefined;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text") {
				const text = content.text.trim();
				if (!text) continue;
				blocks.push({
					component: new Markdown(text, 0, 0, this.markdownTheme),
					gapBefore: previousVisibleKind === "thinking",
				});
				previousVisibleKind = "text";
				continue;
			}
			if (content.type !== "thinking") continue;

			const thinkingBlocks: string[] = [];
			for (; i < message.content.length; i++) {
				const thinkingContent = message.content[i];
				if (thinkingContent.type !== "thinking") break;
				const thinking = thinkingContent.thinking.trim();
				if (thinking) thinkingBlocks.push(thinking);
			}
			i--;
			if (thinkingBlocks.length === 0) continue;

			const thinkingSummaries = getThinkingSummaryLinesFromBlocks(thinkingBlocks);
			const component = this.hideThinkingBlock
				? new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), 0, 0)
				: thinkingSummaries.length > 0
					? new ThoughtChainComponent(thinkingSummaries, () =>
							this.thoughtAnimationEnabled ? THOUGHT_ACTIVITY_SUFFIXES[this.thoughtAnimationPhase]! : "",
						)
					: new Markdown(thinkingBlocks.join("\n\n"), 0, 0, this.markdownTheme, {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						});
			blocks.push({ component, gapBefore: previousVisibleKind !== undefined });
			previousVisibleKind = "thinking";
		}

		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((content) => content.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		let statusMessage: string | undefined;
		if (message.stopReason === "length") {
			statusMessage =
				"Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.";
		} else if (!hasToolCalls && message.stopReason === "aborted") {
			statusMessage =
				message.errorMessage && message.errorMessage !== "Request was aborted"
					? message.errorMessage
					: "Operation aborted";
		} else if (!hasToolCalls && message.stopReason === "error") {
			statusMessage = `Error: ${message.errorMessage || "Unknown error"}`;
		}
		if (statusMessage) {
			blocks.push({
				component: new Text(theme.fg("error", `${BEAUPI_STATUS_SYMBOLS.error} ${statusMessage}`), 0, 0),
				gapBefore: previousVisibleKind !== undefined,
			});
		}

		if (blocks.length === 0) return;
		this.contentContainer.addChild(new Spacer(1));
		for (let i = 0; i < blocks.length; i++) {
			const block = blocks[i]!;
			if (i > 0 && block.gapBefore) this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new AssistantBlockComponent(block.component, this.outputPad));
		}
	}
}
