import { type Component, type Container, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { type BeauPiToolState, fitSingleLine, toolStateSymbol } from "./beaupi-style.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";

const CURRENT_OPERATION_MIN_MS = 700;

function safeWidth(width: number): number {
	return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function withoutLeadingBlank(lines: string[]): string[] {
	let start = 0;
	while (start < lines.length && visibleWidth(lines[start] ?? "") === 0) start++;
	return lines.slice(start);
}

function aggregateState(tools: readonly ToolExecutionComponent[]): BeauPiToolState {
	const states = tools.map((tool) => tool.getDisplayState());
	if (states.includes("error")) return "error";
	if (states.includes("cancelled")) return "cancelled";
	if (states.includes("running")) return "running";
	if (states.includes("queued")) return "queued";
	return "success";
}

export class ToolGroupComponent implements Component {
	private readonly tools: ToolExecutionComponent[] = [];
	private readonly addedAt = new Map<ToolExecutionComponent, number>();
	private readonly ui: TUI;
	private expanded = false;
	private collapseTimer: NodeJS.Timeout | undefined;

	constructor(ui: TUI, tools: readonly ToolExecutionComponent[] = []) {
		this.ui = ui;
		for (const tool of tools) this.addTool(tool);
	}

	getToolComponents(): readonly ToolExecutionComponent[] {
		return this.tools;
	}

	canAppend(tool: ToolExecutionComponent): boolean {
		return (
			tool.isGroupable() &&
			!["error", "cancelled"].includes(tool.getDisplayState()) &&
			this.tools.every(
				(current) => current.isGroupable() && !["error", "cancelled"].includes(current.getDisplayState()),
			)
		);
	}

	addTool(tool: ToolExecutionComponent): void {
		tool.setExpanded(this.expanded);
		this.tools.push(tool);
		this.addedAt.set(tool, Date.now());
		if (this.collapseTimer) clearTimeout(this.collapseTimer);
		this.collapseTimer = setTimeout(() => {
			this.collapseTimer = undefined;
			this.ui.requestRender();
		}, CURRENT_OPERATION_MIN_MS);
		this.ui.requestRender();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const tool of this.tools) tool.setExpanded(expanded);
		this.ui.requestRender();
	}

	setShowImages(show: boolean): void {
		for (const tool of this.tools) tool.setShowImages(show);
	}

	setImageWidthCells(width: number): void {
		for (const tool of this.tools) tool.setImageWidthCells(width);
	}

	invalidate(): void {
		for (const tool of this.tools) tool.invalidate();
	}

	dispose(): void {
		if (this.collapseTimer) clearTimeout(this.collapseTimer);
		this.collapseTimer = undefined;
	}

	render(width: number): string[] {
		const availableWidth = safeWidth(width);
		if (availableWidth === 0 || this.tools.length === 0) return [];
		if (
			this.expanded ||
			this.tools.length === 1 ||
			!this.tools.every((tool) => tool.isGroupable() && !["error", "cancelled"].includes(tool.getDisplayState()))
		) {
			return this.tools.flatMap((tool) => tool.render(availableWidth));
		}

		const state = aggregateState(this.tools);
		const counts = new Map<string, number>();
		for (const tool of this.tools) {
			const name = tool.getDisplayName();
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
		const summary = Array.from(counts.entries())
			.map(([name, count]) => (count === 1 ? name : `${name} ×${count}`))
			.join(" · ");
		const summaryLine = fitSingleLine(
			[
				{ text: toolStateSymbol(state, theme), required: true },
				{ text: `${this.tools.length} tools`, separator: " ", required: true },
				{ text: summary, separator: " · ", truncate: true },
			],
			availableWidth,
		);
		const lines = ["", summaryLine];

		const current = this.tools[this.tools.length - 1];
		if (!current) return lines;
		const currentAge = Date.now() - (this.addedAt.get(current) ?? 0);
		const currentState = current.getDisplayState();
		if (currentState === "queued" || currentState === "running" || currentAge < CURRENT_OPERATION_MIN_MS) {
			const currentLines = withoutLeadingBlank(current.render(availableWidth));
			for (const line of currentLines) lines.push(truncateToWidth(line, availableWidth, "…"));
		}
		return lines;
	}
}

export function appendToolComponent(
	chatContainer: Container,
	ui: TUI,
	expanded: boolean,
	component: ToolExecutionComponent,
): void {
	const children = chatContainer.children;
	const last = children[children.length - 1];
	if (last instanceof ToolGroupComponent && last.canAppend(component)) {
		last.addTool(component);
		return;
	}
	if (last instanceof ToolExecutionComponent && last.isGroupable() && component.isGroupable()) {
		const group = new ToolGroupComponent(ui, [last, component]);
		group.setExpanded(expanded);
		children[children.length - 1] = group;
		return;
	}
	chatContainer.addChild(component);
}
