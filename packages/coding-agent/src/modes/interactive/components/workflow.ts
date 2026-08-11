import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowNodeSnapshot, WorkflowNodeStatus, WorkflowSnapshot } from "../../../core/workflow/index.ts";
import type { Theme } from "../theme/theme.ts";
import { fitSingleLine } from "./beaupi-style.ts";

function safeWidth(width: number): number {
	return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function duration(milliseconds: number): string {
	const seconds = Math.max(0, milliseconds) / 1000;
	return seconds < 60
		? `${seconds.toFixed(1)}s`
		: `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60)
				.toString()
				.padStart(2, "0")}s`;
}

function statusSymbol(status: WorkflowNodeStatus): string {
	if (status === "pending") return "○";
	if (status === "running") return "●";
	if (status === "completed") return "✓";
	if (status === "failed" || status === "timed_out" || status === "lost") return "✗";
	return "–";
}

function statusColor(status: WorkflowNodeStatus): "dim" | "accent" | "success" | "error" | "muted" {
	if (status === "running") return "accent";
	if (status === "completed") return "success";
	if (status === "failed" || status === "timed_out" || status === "lost") return "error";
	if (status === "cancelled" || status === "skipped") return "muted";
	return "dim";
}

function nodeDepth(
	node: WorkflowNodeSnapshot,
	byId: ReadonlyMap<string, WorkflowNodeSnapshot>,
	seen = new Set<string>(),
): number {
	if (node.dependsOn.length === 0 || seen.has(node.id)) return 0;
	const nextSeen = new Set(seen).add(node.id);
	return 1 + Math.max(0, ...node.dependsOn.map((id) => nodeDepth(byId.get(id) ?? node, byId, nextSeen)));
}

function shortAgentId(agentId: string): string {
	const nodeSeparator = agentId.lastIndexOf(":");
	if (nodeSeparator === -1) return agentId.slice(0, 12);
	return `${agentId.slice(0, 11)}…${agentId.slice(nodeSeparator)}`;
}

function nodeFailure(node: WorkflowNodeSnapshot): string {
	if (node.status === "skipped") return node.error?.message ?? "condition false";
	if (node.status === "cancelled") return node.error?.message ?? "cancelled";
	if (node.status === "timed_out") return node.error?.message ?? "timed out";
	if (node.status === "failed" || node.status === "lost") return node.error?.message ?? node.status;
	return "";
}

export class WorkflowSnapshotComponent implements Component {
	private readonly snapshot: WorkflowSnapshot;
	private readonly currentTheme: Theme;
	private readonly expanded: boolean;

	constructor(snapshot: WorkflowSnapshot, currentTheme: Theme, expanded = false) {
		this.snapshot = structuredClone(snapshot);
		this.currentTheme = currentTheme;
		this.expanded = expanded;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const availableWidth = safeWidth(width);
		if (availableWidth === 0) return [];
		const header = fitSingleLine(
			[
				{ text: this.currentTheme.bold(`Workflow: ${this.snapshot.definitionId}`), required: true, truncate: true },
				{
					text: this.currentTheme.fg(
						this.snapshot.status === "completed"
							? "success"
							: this.snapshot.status === "running"
								? "accent"
								: this.snapshot.status === "failed" || this.snapshot.status === "lost"
									? "error"
									: "muted",
						this.snapshot.status,
					),
					separator: " · ",
					required: true,
				},
				{ text: this.currentTheme.fg("dim", duration(this.snapshot.durationMs)), separator: " · ", priority: 1 },
			],
			availableWidth,
		);
		const byId = new Map(this.snapshot.nodes.map((node) => [node.id, node]));
		const visibleNodes = this.expanded ? this.snapshot.nodes : this.snapshot.nodes.slice(0, 12);
		const lines = [header];
		for (const node of visibleNodes) {
			const depth = nodeDepth(node, byId);
			const prefix = `${"  ".repeat(depth + 1)}${this.currentTheme.fg(statusColor(node.status), statusSymbol(node.status))} `;
			let label = node.id;
			if (node.status === "running") label = this.currentTheme.bold(label);
			else if (node.status === "completed") label = this.currentTheme.fg("dim", label);
			const failure = nodeFailure(node);
			const agentId =
				this.expanded && node.agentId ? this.currentTheme.fg("dim", `agent ${shortAgentId(node.agentId)}`) : "";
			const durationText = node.status === "pending" ? "" : this.currentTheme.fg("dim", duration(node.durationMs));
			const body = failure
				? fitSingleLine(
						[
							{
								text: `${label}${durationText ? ` ${durationText}` : ""} · ${this.currentTheme.fg(statusColor(node.status), failure)}`,
								required: true,
								truncate: true,
							},
						],
						Math.max(0, availableWidth - visibleWidth(prefix)),
					)
				: fitSingleLine(
						[
							{ text: label, required: true, truncate: true },
							{ text: agentId, separator: " · ", priority: 1 },
							{ text: durationText, separator: " ", priority: 2 },
						],
						Math.max(0, availableWidth - visibleWidth(prefix)),
					);
			lines.push(truncateToWidth(`${prefix}${body}`, availableWidth, "…"));
		}
		if (visibleNodes.length < this.snapshot.nodes.length) {
			lines.push(
				truncateToWidth(
					this.currentTheme.fg("dim", `  … ${this.snapshot.nodes.length - visibleNodes.length} nodes hidden`),
					availableWidth,
					"…",
				),
			);
		}
		return lines;
	}
}
