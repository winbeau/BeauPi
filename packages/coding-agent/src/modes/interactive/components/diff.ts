import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import type { ThemeBg, ThemeColor } from "../theme/theme.ts";
import { theme } from "../theme/theme.ts";

export interface RenderDiffOptions {
	filePath?: string;
	width?: number;
	dim?: boolean;
	expanded?: boolean;
}

type DiffLineKind = "context" | "added" | "removed" | "ellipsis";

type DiffSpan = {
	text: string;
	emphasis: boolean;
};

type DiffLine = {
	kind: DiffLineKind;
	lineNum?: string;
	content: string;
	spans?: DiffSpan[];
};

const MAX_WIDTH_CACHE_ENTRIES = 4;
const WORD_EMPHASIS_RATIO_LIMIT = 0.4;

function safeWidth(width: number): number {
	return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function parseDiffLine(line: string): DiffLine {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return { kind: "context", content: replaceTabs(line) };
	const prefix = match[1] ?? " ";
	const lineNum = (match[2] ?? "").trim() || undefined;
	const content = replaceTabs(match[3] ?? "");
	if (prefix === "+") return { kind: "added", lineNum, content };
	if (prefix === "-") return { kind: "removed", lineNum, content };
	if (content.trim() === "...") return { kind: "ellipsis", content: "…" };
	return { kind: "context", lineNum, content };
}

function changedRatio(parts: readonly Diff.Change[], oldContent: string, newContent: string): number {
	let changedCharacters = 0;
	for (const part of parts) {
		if (part.added || part.removed) changedCharacters += part.value.length;
	}
	return changedCharacters / Math.max(1, oldContent.length + newContent.length);
}

function pushChangedSpan(spans: DiffSpan[], text: string): void {
	if (!text) return;
	const leadingWhitespace = text.match(/^\s+/)?.[0] ?? "";
	if (leadingWhitespace) spans.push({ text: leadingWhitespace, emphasis: false });
	const changedText = text.slice(leadingWhitespace.length);
	if (changedText) spans.push({ text: changedText, emphasis: true });
}

function createWordSpans(
	oldContent: string,
	newContent: string,
): { removed: DiffSpan[]; added: DiffSpan[] } | undefined {
	const parts = Diff.diffWords(oldContent, newContent);
	if (changedRatio(parts, oldContent, newContent) > WORD_EMPHASIS_RATIO_LIMIT) return undefined;

	const removed: DiffSpan[] = [];
	const added: DiffSpan[] = [];
	for (const part of parts) {
		if (part.removed) {
			pushChangedSpan(removed, part.value);
		} else if (part.added) {
			pushChangedSpan(added, part.value);
		} else {
			removed.push({ text: part.value, emphasis: false });
			added.push({ text: part.value, emphasis: false });
		}
	}
	return { removed, added };
}

function addWordEmphasis(lines: DiffLine[]): DiffLine[] {
	const output = lines.map((line) => ({ ...line }));
	let index = 0;
	while (index < output.length) {
		if (output[index]?.kind !== "removed") {
			index++;
			continue;
		}
		const removedStart = index;
		while (index < output.length && output[index]?.kind === "removed") index++;
		const addedStart = index;
		while (index < output.length && output[index]?.kind === "added") index++;
		const pairCount = Math.min(addedStart - removedStart, index - addedStart);
		for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
			const removed = output[removedStart + pairIndex];
			const added = output[addedStart + pairIndex];
			if (!removed || !added) continue;
			const spans = createWordSpans(removed.content, added.content);
			if (!spans) continue;
			removed.spans = spans.removed;
			added.spans = spans.added;
		}
	}
	return output;
}

function parseDiff(diffText: string): DiffLine[] {
	return addWordEmphasis(diffText.split("\n").map(parseDiffLine));
}

function lineForeground(kind: DiffLineKind): ThemeColor {
	if (kind === "added") return "toolDiffAdded";
	if (kind === "removed") return "toolDiffRemoved";
	return "toolDiffContext";
}

function lineBackground(kind: DiffLineKind): ThemeBg | undefined {
	if (kind === "added") return "toolDiffAddedBg";
	if (kind === "removed") return "toolDiffRemovedBg";
	return undefined;
}

function emphasisBackground(kind: DiffLineKind): ThemeBg | undefined {
	if (kind === "added") return "toolDiffAddedEmphasisBg";
	if (kind === "removed") return "toolDiffRemovedEmphasisBg";
	return undefined;
}

function styleContent(line: DiffLine): string {
	const foreground = lineForeground(line.kind);
	const background = lineBackground(line.kind);
	const emphasis = emphasisBackground(line.kind);
	if (!line.spans || !background || !emphasis) return theme.fg(foreground, line.content);
	return line.spans
		.map((span) => {
			const styled = theme.fg(foreground, span.text);
			return span.emphasis ? `${theme.getBgAnsi(emphasis)}${styled}${theme.getBgAnsi(background)}` : styled;
		})
		.join("");
}

function maxLineDigits(lines: readonly DiffLine[]): number {
	return Math.max(1, ...lines.map((line) => line.lineNum?.length ?? 0));
}

function createGutter(line: DiffLine, digits: number, continuation: boolean): string {
	if (continuation) return " ".repeat(digits + 2);
	const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
	const number = line.lineNum ? line.lineNum.slice(-digits).padStart(digits, " ") : " ".repeat(digits);
	return `${sign}${number} `;
}

function renderPhysicalLine(line: DiffLine, content: string, gutter: string, width: number): string {
	const availableWidth = safeWidth(width);
	if (availableWidth === 0) return "";
	const fittedGutter = truncateToWidth(gutter, availableWidth, "");
	const contentWidth = Math.max(0, availableWidth - visibleWidth(fittedGutter));
	const fittedContent = truncateToWidth(content, contentWidth, "");
	const foregroundGutter = theme.fg("toolDiffContext", fittedGutter);
	const plainLine = `${foregroundGutter}${fittedContent}`;
	const padding = " ".repeat(Math.max(0, availableWidth - visibleWidth(plainLine)));
	const background = lineBackground(line.kind);
	if (!background) return `${plainLine}${padding}`;
	return `${theme.getBgAnsi(background)}${plainLine}${padding}\x1b[49m`;
}

function renderLine(line: DiffLine, width: number, digits: number): string[] {
	const availableWidth = safeWidth(width);
	if (availableWidth === 0) return [];
	const effectiveDigits = Math.min(digits, Math.max(0, availableWidth - 3));
	const gutter = createGutter(line, effectiveDigits, false);
	const contentWidth = Math.max(1, availableWidth - Math.min(visibleWidth(gutter), availableWidth));
	const wrapped = wrapTextWithAnsi(styleContent(line), contentWidth);
	const physicalLines = wrapped.length > 0 ? wrapped : [""];
	return physicalLines.map((content, index) =>
		renderPhysicalLine(line, content, createGutter(line, effectiveDigits, index > 0), availableWidth),
	);
}

export class StructuredDiffComponent implements Component {
	private readonly lines: DiffLine[];
	private readonly cache = new Map<number, string[]>();

	constructor(diffText: string, _options: RenderDiffOptions = {}) {
		this.lines = parseDiff(diffText);
	}

	invalidate(): void {
		this.cache.clear();
	}

	render(width: number): string[] {
		const availableWidth = safeWidth(width);
		if (availableWidth === 0) return [];
		const cached = this.cache.get(availableWidth);
		if (cached) return cached;

		const border = theme.fg("borderMuted", "─".repeat(availableWidth));
		const digits = maxLineDigits(this.lines);
		const rendered = [border, ...this.lines.flatMap((line) => renderLine(line, availableWidth, digits)), border];
		this.cache.set(availableWidth, rendered);
		while (this.cache.size > MAX_WIDTH_CACHE_ENTRIES) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
		return rendered;
	}
}

export function renderDiff(diffText: string, options: RenderDiffOptions = {}): string {
	return new StructuredDiffComponent(diffText, options).render(options.width ?? 120).join("\n");
}
