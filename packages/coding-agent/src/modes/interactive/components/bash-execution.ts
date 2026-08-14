/** Component for displaying user-invoked bash execution with streaming output. */

import {
	type Component,
	Loader,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { inspectShellPrivilege } from "../../../core/privilege/shell-inspection.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "../../../core/tools/truncate.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import { type BeauPiToolState, continuationGutter, resultGutter, toolTitle } from "./beaupi-style.ts";
import { keyText } from "./keybinding-hints.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

const PREVIEW_LINES = 10;

function safeWidth(width: number): number {
	return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

export class BashExecutionComponent implements Component {
	private readonly command: string;
	private readonly excludeFromContext: boolean;
	private outputLines: string[] = [];
	private status: "running" | "complete" | "cancelled" | "error" = "running";
	private exitCode: number | undefined;
	private readonly loader: Loader;
	private truncationResult?: TruncationResult;
	private fullOutputPath?: string;
	private expanded = false;
	private readonly startedAt = Date.now();

	constructor(command: string, ui: TUI, excludeFromContext = false) {
		this.command = command;
		this.excludeFromContext = excludeFromContext;
		this.loader = new Loader(
			ui,
			(spinner) => theme.fg(excludeFromContext ? "dim" : "bashMode", spinner),
			(text) => theme.fg("muted", text),
			`Running… (${keyText("tui.select.cancel")} to cancel)`,
		);
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	invalidate(): void {
		this.loader.invalidate();
	}

	appendOutput(chunk: string): void {
		const clean = stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const newLines = clean.split("\n");
		if (this.outputLines.length > 0 && newLines.length > 0) {
			this.outputLines[this.outputLines.length - 1] += newLines[0];
			this.outputLines.push(...newLines.slice(1));
		} else {
			this.outputLines.push(...newLines);
		}
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: TruncationResult,
		fullOutputPath?: string,
	): void {
		this.exitCode = exitCode;
		this.status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? "error"
				: "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;
		this.loader.stop();
	}

	private getToolState(): BeauPiToolState {
		if (this.status === "running") return "running";
		if (this.status === "cancelled") return "cancelled";
		if (this.status === "error") return "error";
		return "success";
	}

	render(width: number): string[] {
		const availableWidth = safeWidth(width);
		if (availableWidth === 0) return [];
		const bodyWidth = Math.max(1, availableWidth - 5);
		const titleArgument = this.excludeFromContext ? `${this.command} · no context` : this.command;
		const toolName = inspectShellPrivilege(this.command).sudo ? "Sudo Bash" : "Bash";
		const lines = ["", toolTitle(toolName, titleArgument, this.getToolState(), theme, availableWidth)];

		const fullOutput = this.outputLines.join("\n");
		const contextTruncation = truncateTail(fullOutput, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});
		const availableLines = contextTruncation.content ? contextTruncation.content.split("\n") : [];
		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;
		let outputLines: string[] = [];

		if (this.expanded) {
			outputLines = availableLines.flatMap((line) => wrapTextWithAnsi(theme.fg("muted", line), bodyWidth));
		} else if (previewLogicalLines.length > 0) {
			const styledOutput = previewLogicalLines.map((line) => theme.fg("muted", line)).join("\n");
			outputLines = truncateToVisualLines(styledOutput, PREVIEW_LINES, bodyWidth).visualLines;
		}
		for (let index = 0; index < outputLines.length; index++) {
			lines.push(
				index === 0
					? resultGutter(outputLines[index] ?? "", theme, availableWidth)
					: continuationGutter(outputLines[index] ?? "", theme, availableWidth),
			);
		}

		const statusLines: string[] = [];
		if (this.status === "running") {
			const elapsed = Date.now() - this.startedAt;
			if (elapsed >= 2000) {
				this.loader.setMessage(
					`Running… ${formatDuration(elapsed)} · ${this.outputLines.length} lines (${keyText("tui.select.cancel")} to cancel)`,
				);
			}
			const loaderLines = this.loader.render(bodyWidth);
			for (let index = 0; index < loaderLines.length; index++) {
				lines.push(
					outputLines.length === 0 && index === 0
						? resultGutter(loaderLines[index] ?? "", theme, availableWidth)
						: continuationGutter(loaderLines[index] ?? "", theme, availableWidth),
				);
			}
			return lines;
		}

		if (hiddenLineCount > 0) {
			statusLines.push(
				this.expanded
					? `(${keyText("app.tools.expand")} to collapse)`
					: `… ${hiddenLineCount} more lines (${keyText("app.tools.expand")} to expand)`,
			);
		}
		if (this.status === "cancelled") statusLines.push("Cancelled");
		if (this.status === "error") statusLines.push(`Exited with code ${this.exitCode}`);
		const wasTruncated = this.truncationResult?.truncated || contextTruncation.truncated;
		if (wasTruncated && this.fullOutputPath) statusLines.push(`Full output: ${this.fullOutputPath}`);
		statusLines.push(`Completed in ${formatDuration(Date.now() - this.startedAt)}`);

		for (let index = 0; index < statusLines.length; index++) {
			const status = statusLines[index] ?? "";
			const styled =
				this.status === "error" && index === 0
					? theme.fg("error", status)
					: this.status === "cancelled" && index === 0
						? theme.fg("warning", status)
						: theme.fg("dim", status);
			lines.push(
				outputLines.length === 0 && index === 0
					? resultGutter(styled, theme, availableWidth)
					: continuationGutter(styled, theme, availableWidth),
			);
		}
		return lines.map((line) =>
			visibleWidth(line) <= availableWidth ? line : truncateToWidth(line, availableWidth, "…"),
		);
	}

	getOutput(): string {
		return this.outputLines.join("\n");
	}

	getCommand(): string {
		return this.command;
	}
}
