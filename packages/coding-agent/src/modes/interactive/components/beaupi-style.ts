import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "../theme/theme.ts";

export type BeauPiToolState =
	| "queued"
	| "running"
	| "success"
	| "completed"
	| "warning"
	| "error"
	| "failed"
	| "cancelled"
	| "permission"
	| "permission-waiting";

export type BeauPiSemanticStatus = "queued" | "running" | "success" | "warning" | "error" | "cancelled" | "permission";

export type BeauPiActivityState = "pending" | "active" | "completed" | "failed" | "blocked" | "cancelled";

export const BEAUPI_STATUS_SYMBOLS = Object.freeze({
	queued: "○",
	running: "●",
	success: "●",
	warning: "▲",
	error: "●",
	cancelled: "⊘",
	permission: "!",
} as const satisfies Record<BeauPiSemanticStatus, string>);

export type BeauPiStatusSymbol = (typeof BEAUPI_STATUS_SYMBOLS)[BeauPiSemanticStatus];

export const BEAUPI_STATUS_BY_SYMBOL = Object.freeze({
	[BEAUPI_STATUS_SYMBOLS.queued]: Object.freeze(["queued"]),
	[BEAUPI_STATUS_SYMBOLS.running]: Object.freeze(["running", "success", "error"]),
	[BEAUPI_STATUS_SYMBOLS.warning]: Object.freeze(["warning"]),
	[BEAUPI_STATUS_SYMBOLS.cancelled]: Object.freeze(["cancelled"]),
	[BEAUPI_STATUS_SYMBOLS.permission]: Object.freeze(["permission"]),
} as const satisfies Record<BeauPiStatusSymbol, readonly BeauPiSemanticStatus[]>);

export const BEAUPI_GUTTERS = Object.freeze({
	message: "> ",
	toolResult: "  ⎿  ",
	continuation: "     ",
	treeBranch: "   ├─ ",
	treeLast: "   └─ ",
	treePipe: "   │  ",
} as const);

export type BeauPiIndentKind = "message" | "toolResult" | "continuation" | "tree";

export const BEAUPI_INDENT_COLUMNS = Object.freeze({
	message: 2,
	toolResult: 5,
	continuation: 5,
	tree: 6,
} as const satisfies Record<BeauPiIndentKind, number>);

export const BEAUPI_SPACING_RULES = Object.freeze({
	blockRows: 1,
	toolResultRows: 0,
	metadataSeparator: " · ",
} as const);

export const BEAUPI_ELLIPSIS = "…";

export interface BeauPiResponsiveSpacing {
	readonly blockRows: 0 | 1;
	readonly inlineColumns: 0 | 1 | 2;
	readonly metadataSeparator: "" | " " | " · ";
}

const ZERO_SPACING = Object.freeze({
	blockRows: 0,
	inlineColumns: 0,
	metadataSeparator: "",
} as const satisfies BeauPiResponsiveSpacing);
const COMPACT_SPACING = Object.freeze({
	blockRows: 0,
	inlineColumns: 1,
	metadataSeparator: " ",
} as const satisfies BeauPiResponsiveSpacing);
const NORMAL_SPACING = Object.freeze({
	blockRows: 1,
	inlineColumns: 1,
	metadataSeparator: " · ",
} as const satisfies BeauPiResponsiveSpacing);
const WIDE_SPACING = Object.freeze({
	blockRows: 1,
	inlineColumns: 2,
	metadataSeparator: " · ",
} as const satisfies BeauPiResponsiveSpacing);

export interface ResponsivePart {
	readonly text: string;
	readonly separator?: string;
	readonly priority?: number;
	readonly required?: boolean;
	readonly truncate?: boolean;
}

export interface LabelSuffixMetadata {
	readonly label: string;
	readonly suffix?: string;
	readonly metadata?: readonly string[];
	readonly suffixSeparator?: string;
	readonly metadataSeparator?: string;
}

interface NormalizedPart extends ResponsivePart {
	readonly index: number;
	readonly text: string;
	readonly separator: string;
	readonly priority: number;
}

function safeWidth(width: number): number {
	return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function firstLine(text: string): string {
	return text.split(/\r\n|\r|\n/, 1)[0] ?? "";
}

function renderParts(parts: readonly NormalizedPart[]): string {
	let output = "";
	let hasPart = false;
	for (const part of parts) {
		if (part.text === "") continue;
		if (hasPart) output += part.separator;
		output += part.text;
		hasPart = true;
	}
	return output;
}

export function semanticStatus(state: BeauPiToolState): BeauPiSemanticStatus {
	switch (state) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "permission-waiting":
			return "permission";
		default:
			return state;
	}
}

export function statusSymbol(state: BeauPiToolState): BeauPiStatusSymbol {
	return BEAUPI_STATUS_SYMBOLS[semanticStatus(state)];
}

export function activityStateSymbol(state: BeauPiActivityState): BeauPiStatusSymbol {
	switch (state) {
		case "pending":
			return BEAUPI_STATUS_SYMBOLS.queued;
		case "active":
			return BEAUPI_STATUS_SYMBOLS.running;
		case "completed":
			return BEAUPI_STATUS_SYMBOLS.success;
		case "failed":
			return BEAUPI_STATUS_SYMBOLS.error;
		case "blocked":
			return BEAUPI_STATUS_SYMBOLS.permission;
		case "cancelled":
			return BEAUPI_STATUS_SYMBOLS.cancelled;
	}
}

export function activityStateToolState(state: BeauPiActivityState): BeauPiToolState {
	switch (state) {
		case "pending":
			return "queued";
		case "active":
			return "running";
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "blocked":
			return "permission";
		case "cancelled":
			return "cancelled";
	}
}

function statusColor(status: BeauPiSemanticStatus): ThemeColor {
	switch (status) {
		case "running":
			return "accent";
		case "success":
			return "success";
		case "warning":
		case "permission":
			return "warning";
		case "error":
			return "error";
		case "queued":
			return "dim";
		case "cancelled":
			return "muted";
	}
}

export function toolStateSymbol(state: BeauPiToolState, theme: Theme): string {
	const status = semanticStatus(state);
	return theme.fg(statusColor(status), BEAUPI_STATUS_SYMBOLS[status]);
}

export function responsiveSpacing(width: number): BeauPiResponsiveSpacing {
	const availableWidth = safeWidth(width);
	if (availableWidth === 0) return ZERO_SPACING;
	if (availableWidth < 40) return COMPACT_SPACING;
	if (availableWidth < 120) return NORMAL_SPACING;
	return WIDE_SPACING;
}

export function indent(kind: BeauPiIndentKind, width: number): string {
	return " ".repeat(Math.min(safeWidth(width), BEAUPI_INDENT_COLUMNS[kind]));
}

export function fitSingleLine(
	parts: readonly ResponsivePart[],
	width: number,
	ellipsis: string = BEAUPI_ELLIPSIS,
): string {
	const availableWidth = safeWidth(width);
	if (availableWidth === 0) return "";

	let activeParts: NormalizedPart[] = parts
		.map((part, index) => ({
			...part,
			index,
			text: firstLine(part.text),
			separator: firstLine(part.separator ?? ""),
			priority: part.priority ?? 0,
		}))
		.filter((part) => part.text !== "");

	let output = renderParts(activeParts);
	if (visibleWidth(output) <= availableWidth) return output;

	const removableParts = activeParts
		.filter((part) => !part.required && !part.truncate)
		.sort((left, right) => left.priority - right.priority || right.index - left.index);
	for (const removable of removableParts) {
		activeParts = activeParts.filter((part) => part.index !== removable.index);
		output = renderParts(activeParts);
		if (visibleWidth(output) <= availableWidth) return output;
	}

	const truncatableIndex = activeParts.findIndex((part) => part.truncate);
	if (truncatableIndex !== -1) {
		const truncatable = activeParts[truncatableIndex]!;
		const before = activeParts.slice(0, truncatableIndex);
		const after = activeParts.slice(truncatableIndex + 1);
		const beforeText = renderParts(before);
		const truncatableSeparator = before.length > 0 ? truncatable.separator : "";
		const afterText = after.map((part) => `${part.separator}${part.text}`).join("");
		const textWidth =
			availableWidth - visibleWidth(beforeText) - visibleWidth(truncatableSeparator) - visibleWidth(afterText);
		if (textWidth <= 0) {
			output = renderParts([...before, ...after]);
		} else {
			output = `${beforeText}${truncatableSeparator}${truncateToWidth(
				truncatable.text,
				textWidth,
				ellipsis,
			)}${afterText}`;
		}
		if (visibleWidth(output) <= availableWidth) return output;
	}

	return truncateToWidth(output, availableWidth, ellipsis);
}

export function fitLabelSuffixMetadata(
	parts: LabelSuffixMetadata,
	width: number,
	ellipsis: string = BEAUPI_ELLIPSIS,
): string {
	const spacing = responsiveSpacing(width);
	const suffixSeparator = parts.suffixSeparator ?? " ".repeat(spacing.inlineColumns);
	const metadataSeparator = parts.metadataSeparator ?? spacing.metadataSeparator;
	const metadata = parts.metadata ?? [];
	const responsiveParts: ResponsivePart[] = [
		{ text: parts.label, required: true, truncate: true },
		...(parts.suffix ? [{ text: parts.suffix, separator: suffixSeparator, required: true }] : []),
		...metadata.map((text, index) => ({
			text,
			separator: metadataSeparator,
			priority: metadata.length - index,
		})),
	];
	return fitSingleLine(responsiveParts, width, ellipsis);
}

function textWithGutter(gutter: string, text: string, theme: Theme, width: number, color: ThemeColor): string {
	const availableWidth = safeWidth(width);
	if (availableWidth === 0) return "";
	const singleLineText = firstLine(text);
	if (availableWidth < visibleWidth(gutter)) {
		return fitSingleLine([{ text: singleLineText, required: true, truncate: true }], availableWidth);
	}
	return fitSingleLine(
		[
			{ text: theme.fg(color, gutter), required: true },
			{ text: singleLineText, required: true, truncate: true },
		],
		availableWidth,
	);
}

export function messageGutter(text: string, theme: Theme, width: number): string {
	return textWithGutter(BEAUPI_GUTTERS.message, text, theme, width, "accent");
}

export function resultGutter(text: string, theme: Theme, width: number): string {
	return textWithGutter(BEAUPI_GUTTERS.toolResult, text, theme, width, "dim");
}

export function continuationGutter(text: string, theme: Theme, width: number): string {
	return textWithGutter(BEAUPI_GUTTERS.continuation, text, theme, width, "dim");
}

export type BeauPiTreeGutterKind = "branch" | "last" | "pipe";

export function treeGutter(kind: BeauPiTreeGutterKind, theme: Theme, width: number): string {
	const availableWidth = safeWidth(width);
	if (availableWidth === 0) return "";
	const fullGutter =
		kind === "branch"
			? BEAUPI_GUTTERS.treeBranch
			: kind === "last"
				? BEAUPI_GUTTERS.treeLast
				: BEAUPI_GUTTERS.treePipe;
	const narrowGutter = kind === "branch" ? "├" : kind === "last" ? "└" : "│";
	return theme.fg("dim", availableWidth < visibleWidth(fullGutter) ? narrowGutter : fullGutter);
}

export function toolTitle(name: string, argument: string, state: BeauPiToolState, theme: Theme, width: number): string {
	const argumentText = firstLine(argument);
	const body = argumentText === "" ? theme.bold(firstLine(name)) : `${theme.bold(firstLine(name))}(${argumentText})`;
	return fitSingleLine(
		[
			{ text: toolStateSymbol(state, theme), required: true },
			{ text: body, separator: " ", required: true, truncate: true },
		],
		width,
	);
}
