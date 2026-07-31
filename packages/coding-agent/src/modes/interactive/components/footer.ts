import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { RecentRunStatsTracker, type RecentRunStatus } from "../../../core/recent-run-stats.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../../../core/usage-totals.ts";
import { theme } from "../theme/theme.ts";
import { fitSingleLine, type ResponsivePart } from "./beaupi-style.ts";

function safeWidth(width: number): number {
	return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, milliseconds) / 1000;
	return seconds >= 100 ? `${seconds.toFixed(0)}s` : `${seconds.toFixed(1)}s`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

type UsageSnapshot = {
	totals: UsageTotals;
	latestCacheHitRate: number | undefined;
};

function fitLeftRight(leftParts: readonly ResponsivePart[], right: string, width: number): string {
	const availableWidth = safeWidth(width);
	if (availableWidth === 0) return "";
	const rightTargetWidth = Math.min(visibleWidth(right), Math.max(10, Math.floor(availableWidth * 0.4)));
	const leftBudget = Math.max(0, availableWidth - rightTargetWidth - 1);
	const left = fitSingleLine(leftParts, leftBudget);
	const remaining = Math.max(0, availableWidth - visibleWidth(left) - (left ? 1 : 0));
	const fittedRight = truncateToWidth(right, remaining, "…");
	if (!left) return fittedRight;
	if (!fittedRight) return truncateToWidth(left, availableWidth, "…");
	const padding = " ".repeat(Math.max(1, availableWidth - visibleWidth(left) - visibleWidth(fittedRight)));
	return truncateToWidth(`${left}${padding}${fittedRight}`, availableWidth, "…");
}

export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private readonly footerData: ReadonlyFooterDataProvider;
	private readonly recentRun = new RecentRunStatsTracker();
	private usageCache:
		| {
				session: AgentSession;
				entryCount: number;
				lastEntryId: string | undefined;
				snapshot: UsageSnapshot;
		  }
		| undefined;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		if (this.session !== session) {
			this.recentRun.reset();
			this.usageCache = undefined;
		}
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	startRecentRun(now = Date.now()): void {
		this.recentRun.start(now);
	}

	noteRecentRunOutput(now = Date.now()): void {
		this.recentRun.noteFirstOutput(now);
	}

	addRecentRunUsage(usage: Usage): void {
		this.recentRun.addUsage(usage);
	}

	finishRecentRun(status: Exclude<RecentRunStatus, "running">, now = Date.now()): void {
		this.recentRun.finish(status, now);
	}

	invalidate(): void {}

	dispose(): void {}

	private getUsageSnapshot(): UsageSnapshot {
		const entries = this.session.sessionManager.getEntries();
		const lastEntry = entries[entries.length - 1];
		if (
			this.usageCache?.session === this.session &&
			this.usageCache.entryCount === entries.length &&
			this.usageCache.lastEntryId === lastEntry?.id
		) {
			return this.usageCache.snapshot;
		}

		const totals = createUsageTotals();
		let latestCacheHitRate: number | undefined;
		for (const entry of entries) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(totals, entry.message.usage);
				const promptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate = promptTokens > 0 ? (entry.message.usage.cacheRead / promptTokens) * 100 : undefined;
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(totals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(totals, entry.usage);
			}
		}
		const snapshot = { totals, latestCacheHitRate };
		this.usageCache = {
			session: this.session,
			entryCount: entries.length,
			lastEntryId: lastEntry?.id,
			snapshot,
		};
		return snapshot;
	}

	private renderRecentRunLine(width: number): string | undefined {
		const run = this.recentRun.getLastFinished();
		if (!run || run.outputTokens <= 0 || run.endedAt === undefined) return undefined;
		const outputStart = run.firstOutputAt ?? run.startedAt;
		const outputSeconds = Math.max(0.001, (run.endedAt - outputStart) / 1000);
		const tps = run.outputTokens / outputSeconds;
		const cache =
			run.cacheRead || run.cacheWrite
				? `cache ${run.cacheRead.toLocaleString()}${run.cacheWrite ? `/${run.cacheWrite.toLocaleString()}` : ""}`
				: "";
		const status = run.status === "completed" ? "" : run.status;
		const parts: ResponsivePart[] = [
			{ text: theme.fg("text", `${tps.toFixed(1)} tok/s`), required: true },
			{ text: theme.fg("dim", `${run.outputTokens.toLocaleString()} out`), separator: " · ", required: true },
			{ text: theme.fg("dim", `${run.totalTokens.toLocaleString()} total`), separator: " · ", priority: 0 },
			{ text: theme.fg("dim", `${run.inputTokens.toLocaleString()} in`), separator: " · ", priority: 1 },
			{ text: cache ? theme.fg("dim", cache) : "", separator: " · ", priority: 2 },
			{
				text: status ? theme.fg(run.status === "failed" ? "error" : "warning", status) : "",
				separator: " · ",
				priority: 3,
			},
			{ text: theme.fg("dim", formatDuration(run.endedAt - run.startedAt)), separator: " · ", required: true },
		];
		return fitSingleLine(parts, width);
	}

	render(width: number): string[] {
		const availableWidth = safeWidth(width);
		if (availableWidth === 0) return [];
		const state = this.session.state;
		const { totals, latestCacheHitRate } = this.getUsageSnapshot();
		const lines: string[] = [];

		const recentRunLine = this.renderRecentRunLine(availableWidth);
		if (recentRunLine) lines.push(recentRunLine);

		const cwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
		const branch = this.footerData.getGitBranch();
		const sessionName = this.session.sessionManager.getSessionName();
		const selectedTarget = this.session.remoteRuntime?.selectedTarget;
		const policyAdvisories = this.session.policyRuntime?.getAdvisories() ?? [];
		const latestPolicyAdvisory = policyAdvisories.at(-1);
		const policyAdvisory = latestPolicyAdvisory
			? `policy: ${sanitizeStatusText(latestPolicyAdvisory.message)}${policyAdvisories.length > 1 ? ` (+${policyAdvisories.length - 1})` : ""}`
			: "";
		const taskLedger = this.session.taskLedger.getSnapshot();
		const monitorSummary = this.session.monitorRuntime?.getSummary();
		const backgroundSummary = taskLedger.background?.summary;
		const workflows = taskLedger.workflows ?? [];
		const runningWorkflows = workflows.filter((workflow) => workflow.status === "running").length;
		const attentionWorkflows = workflows.filter(
			(workflow) => workflow.status === "failed" || workflow.status === "lost",
		).length;
		const hasTaskActivity = taskLedger.startedAt !== undefined || taskLedger.commands.length > 0;
		const modifiedFiles =
			taskLedger.filesModified.length > 0
				? `${taskLedger.filesModified.length} file${taskLedger.filesModified.length === 1 ? "" : "s"}`
				: "";
		const verification = taskLedger.verification.status === "none" ? "" : `verify ${taskLedger.verification.status}`;
		const documentContract = taskLedger.documentContract
			? taskLedger.documentContract.stale
				? "docs stale"
				: "contract active"
			: "";
		const extensionStatuses = Array.from(this.footerData.getExtensionStatuses().entries())
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([, text]) => sanitizeStatusText(text));
		const workspaceLine = fitSingleLine(
			[
				{ text: theme.fg("dim", cwd), required: true, truncate: true },
				{ text: branch ? theme.fg("dim", `(${branch})`) : "", separator: " ", priority: 5 },
				{
					text: policyAdvisory ? theme.fg("warning", policyAdvisory) : "",
					separator: " · ",
					priority: 5,
				},
				{
					text: hasTaskActivity ? theme.fg("accent", taskLedger.phase) : "",
					separator: " · ",
					priority: 4,
				},
				{
					text:
						runningWorkflows > 0 || attentionWorkflows > 0
							? theme.fg(
									attentionWorkflows > 0 ? "warning" : "accent",
									`wf ${runningWorkflows} run${attentionWorkflows > 0 ? ` · ${attentionWorkflows} attention` : ""}`,
								)
							: "",
					separator: " · ",
					priority: 4,
				},
				{
					text:
						backgroundSummary && backgroundSummary.total > 0
							? theme.fg(
									backgroundSummary.failed + backgroundSummary.stalled + backgroundSummary.lost > 0
										? "warning"
										: "accent",
									`bg ${backgroundSummary.running} run${backgroundSummary.wakeQueued > 0 ? ` · wake ${backgroundSummary.wakeQueued}` : ""}`,
								)
							: "",
					separator: " · ",
					priority: 4,
				},
				{
					text:
						monitorSummary && monitorSummary.total > 0
							? theme.fg(
									monitorSummary.failed + monitorSummary.stalled + monitorSummary.lost > 0
										? "warning"
										: "accent",
									`mon ${monitorSummary.running + monitorSummary.healthy} run${
										monitorSummary.failed + monitorSummary.stalled + monitorSummary.lost > 0
											? ` · ${monitorSummary.failed + monitorSummary.stalled + monitorSummary.lost} attention`
											: ""
									}`,
								)
							: "",
					separator: " · ",
					priority: 3,
				},
				{ text: modifiedFiles ? theme.fg("dim", modifiedFiles) : "", separator: " · ", priority: 2 },
				{ text: sessionName ? theme.fg("dim", sessionName) : "", separator: " · ", priority: 2 },
				{ text: selectedTarget ? theme.fg("dim", `ssh:${selectedTarget.id}`) : "", separator: " · ", priority: 2 },
				{ text: verification ? theme.fg("dim", verification) : "", separator: " · ", priority: 0 },
				{
					text: documentContract
						? theme.fg(taskLedger.documentContract?.stale ? "warning" : "dim", documentContract)
						: "",
					separator: " · ",
					priority: 1,
				},
				...extensionStatuses.map((text, index) => ({
					text,
					separator: " · ",
					priority: 1 - index,
				})),
			],
			availableWidth,
		);
		lines.push(workspaceLine);

		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextTokens = contextUsage?.tokens ?? null;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextTokenDisplay = `${contextTokens === null ? "?" : formatTokens(contextTokens)}/${formatTokens(contextWindow)}`;
		const contextPercent = contextUsage?.percent === null ? "" : ` ${contextPercentValue.toFixed(1)}%`;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextDisplay = `${contextTokenDisplay}${contextPercent}${autoIndicator}`;
		const contextColor = contextPercentValue > 90 ? "error" : contextPercentValue > 70 ? "warning" : "dim";

		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingOAuth(state.model.provider)
			: false;
		const modelName = state.model?.id || "no-model";
		const thinkingLevel = state.model?.reasoning ? state.thinkingLevel || "off" : undefined;
		const provider =
			this.footerData.getAvailableProviderCount() > 1 && state.model ? `(${state.model.provider}) ` : "";
		const rightSide = theme.fg(
			"dim",
			`${provider}${modelName}${thinkingLevel ? ` · ${thinkingLevel === "off" ? "thinking off" : thinkingLevel}` : ""}`,
		);
		const cacheHit =
			(totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined
				? `CH${latestCacheHitRate.toFixed(1)}%`
				: "";
		const cost =
			totals.cost || usingSubscription ? `$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}` : "";
		const leftParts: ResponsivePart[] = [
			{ text: totals.input ? theme.fg("dim", `↑${formatTokens(totals.input)}`) : "", required: true },
			{
				text: totals.output ? theme.fg("dim", `↓${formatTokens(totals.output)}`) : "",
				separator: " ",
				required: true,
			},
			{
				text: totals.cacheRead ? theme.fg("dim", `R${formatTokens(totals.cacheRead)}`) : "",
				separator: " ",
				priority: 3,
			},
			{
				text: totals.cacheWrite ? theme.fg("dim", `W${formatTokens(totals.cacheWrite)}`) : "",
				separator: " ",
				priority: 2,
			},
			{ text: cacheHit ? theme.fg("dim", cacheHit) : "", separator: " ", priority: 0 },
			{ text: cost ? theme.fg("dim", cost) : "", separator: " ", priority: 1 },
			{ text: theme.fg(contextColor, contextDisplay), separator: " · ", required: true, truncate: true },
			{
				text: areExperimentalFeaturesEnabled() ? theme.bold(theme.fg("warning", "xp")) : "",
				separator: " · ",
				priority: -1,
			},
		];
		lines.push(fitLeftRight(leftParts, rightSide, availableWidth));
		return lines.slice(0, 3);
	}
}
