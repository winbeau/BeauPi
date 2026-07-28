import { Container, Markdown, type MarkdownTheme, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { BEAUPI_GUTTERS } from "./beaupi-style.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private text: string;
	private content: Markdown;
	private outputPad: number;

	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme(), outputPad = 1) {
		super();
		this.text = text;
		this.outputPad = outputPad;
		this.content = new Markdown(
			text,
			0,
			0,
			markdownTheme,
			{
				color: (content: string) => theme.fg("userMessageText", content),
			},
			{ preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
		);
		this.addChild(this.content);
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
	}

	override render(width: number): string[] {
		if (this.text.trim() === "") return [];

		const availableWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		const requestedPadding = Number.isFinite(this.outputPad) ? Math.max(0, Math.floor(this.outputPad)) : 0;
		const minimumLayoutWidth = visibleWidth(BEAUPI_GUTTERS.message) + 1;
		const horizontalPadding = Math.min(
			requestedPadding,
			Math.max(0, Math.floor((availableWidth - minimumLayoutWidth) / 2)),
		);
		const innerWidth = Math.max(0, availableWidth - horizontalPadding * 2);
		const gutter =
			innerWidth >= visibleWidth(BEAUPI_GUTTERS.message) ? BEAUPI_GUTTERS.message : innerWidth > 0 ? ">" : "";
		const gutterWidth = visibleWidth(gutter);
		const contentWidth = Math.max(0, innerWidth - gutterWidth);
		const contentLines = contentWidth > 0 ? this.content.render(contentWidth) : [""];
		const leftPadding = " ".repeat(horizontalPadding);
		const rightPadding = " ".repeat(horizontalPadding);
		const renderedLines = contentLines.map((line, index) => {
			const fittedLine = visibleWidth(line) <= contentWidth ? line : truncateToWidth(line, contentWidth, "");
			const prefix = index === 0 && gutter ? theme.fg("accent", gutter) : " ".repeat(gutterWidth);
			const rendered = `${leftPadding}${prefix}${fittedLine}${rightPadding}`;
			return rendered + " ".repeat(Math.max(0, availableWidth - visibleWidth(rendered)));
		});
		const emptyLine = " ".repeat(availableWidth);
		return [OSC133_ZONE_START + emptyLine, ...renderedLines, OSC133_ZONE_END + OSC133_ZONE_FINAL + emptyLine];
	}
}
