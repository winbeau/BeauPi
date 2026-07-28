import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Loader, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { WorkingIndicatorOptions } from "../../../core/extensions/index.ts";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { keyText } from "./keybinding-hints.ts";

export type StatusIndicatorKind = "working" | "retry" | "compaction" | "branchSummary";

const MAX_THINKING_STATUS_WIDTH = 120;

function normalizeThinkingStatusLine(line: string): string | undefined {
	let normalized = line
		.trim()
		.replace(/^#{1,6}\s+/, "")
		.replace(/^>\s*/, "")
		.replace(/^(?:[-+*]|\d+[.)])\s+/, "")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.replace(/(?:\.{3}|…)+$/u, "")
		.replace(/[.!?;:,]+$/u, "")
		.trim();
	if (!normalized || /^```/.test(normalized)) return undefined;
	normalized = truncateToWidth(normalized, MAX_THINKING_STATUS_WIDTH - 1, "");
	return normalized ? `${normalized}…` : undefined;
}

export function getThinkingStatusMessage(message: AssistantMessage): string | undefined {
	for (let contentIndex = message.content.length - 1; contentIndex >= 0; contentIndex--) {
		const content = message.content[contentIndex];
		if (content?.type !== "thinking") continue;
		const lines = content.thinking.split(/\r\n|\r|\n/);
		for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex--) {
			const status = normalizeThinkingStatusLine(lines[lineIndex] ?? "");
			if (status) return status;
		}
	}
	return undefined;
}

export function resolveWorkingStatusMessage(
	defaultMessage: string,
	customMessage?: string,
	thinkingMessage?: string,
): string {
	return customMessage ?? thinkingMessage ?? defaultMessage;
}

export class StatusIndicator extends Loader {
	readonly kind: StatusIndicatorKind;

	constructor(
		kind: StatusIndicatorKind,
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string,
		indicator?: WorkingIndicatorOptions,
	) {
		super(ui, spinnerColorFn, messageColorFn, message, indicator);
		this.kind = kind;
	}

	dispose(): void {
		this.stop();
	}
}

export class WorkingStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, message: string, indicator?: WorkingIndicatorOptions) {
		super(
			"working",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			message,
			indicator,
		);
	}
}

export class RetryStatusIndicator extends StatusIndicator {
	private countdown: CountdownTimer | undefined;

	constructor(ui: TUI, attempt: number, maxAttempts: number, delayMs: number) {
		const retryMessage = (seconds: number) =>
			`Retrying ${attempt}/${maxAttempts} in ${seconds}s… (${keyText("app.interrupt")} to cancel)`;
		super(
			"retry",
			ui,
			(spinner) => theme.fg("warning", spinner),
			(text) => theme.fg("muted", text),
			retryMessage(Math.ceil(delayMs / 1000)),
		);
		this.countdown = new CountdownTimer(
			delayMs,
			ui,
			(seconds) => {
				this.setMessage(retryMessage(seconds));
			},
			() => {
				this.countdown = undefined;
			},
		);
	}

	override dispose(): void {
		this.countdown?.dispose();
		this.countdown = undefined;
		super.dispose();
	}
}

export type CompactionStatusReason = "manual" | "threshold" | "overflow";

export class CompactionStatusIndicator extends StatusIndicator {
	private generatedCharacters = 0;
	private readonly tui: TUI;

	constructor(ui: TUI, reason: CompactionStatusReason) {
		const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
		const label =
			reason === "manual"
				? `Compacting context… ${cancelHint}`
				: `${reason === "overflow" ? "Context overflow detected · " : ""}Auto-compacting… ${cancelHint}`;
		super(
			"compaction",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			label,
		);
		this.tui = ui;
	}

	addProgress(deltaCharacters: number): void {
		this.generatedCharacters += Math.max(0, deltaCharacters);
		this.tui.requestRender();
	}

	override render(width: number): string[] {
		const availableWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (availableWidth === 0) return [];
		const lines = super.render(availableWidth);
		const estimatedTokens = Math.ceil(this.generatedCharacters / 4);
		const ratio = 1 - Math.exp(-estimatedTokens / 1200);
		const percent = Math.min(99, Math.round(ratio * 100));
		const percentText = `${percent}%`;
		const barWidth = Math.max(0, Math.min(30, availableWidth - percentText.length - 1));
		const filledWidth = Math.min(barWidth, Math.round(ratio * barWidth));
		const bar = theme.fg("accent", "━".repeat(filledWidth)) + theme.fg("dim", "─".repeat(barWidth - filledWidth));
		lines.push(`${bar}${bar ? " " : ""}${theme.fg("dim", percentText)}`);
		return lines;
	}
}

export class BranchSummaryStatusIndicator extends StatusIndicator {
	constructor(ui: TUI) {
		super(
			"branchSummary",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			`Summarizing branch… (${keyText("app.interrupt")} to cancel)`,
		);
	}
}

export class IdleStatus implements Component {
	invalidate(): void {
		// No cached state to invalidate.
	}

	render(width: number): string[] {
		const availableWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		const emptyLine = " ".repeat(availableWidth);
		return [emptyLine, emptyLine];
	}
}
