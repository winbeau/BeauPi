import type { Usage } from "@earendil-works/pi-ai";

export type RecentRunStatus = "running" | "completed" | "failed" | "aborted";

export interface RecentRunStatsSnapshot {
	status: RecentRunStatus;
	startedAt: number;
	firstOutputAt?: number;
	endedAt?: number;
	inputTokens: number;
	outputTokens: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

function createSnapshot(startedAt: number): RecentRunStatsSnapshot {
	return {
		status: "running",
		startedAt,
		inputTokens: 0,
		outputTokens: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
	};
}

export class RecentRunStatsTracker {
	private current: RecentRunStatsSnapshot | undefined;
	private lastFinished: RecentRunStatsSnapshot | undefined;

	start(now = Date.now()): void {
		this.current = createSnapshot(now);
	}

	noteFirstOutput(now = Date.now()): void {
		if (this.current && this.current.firstOutputAt === undefined) this.current.firstOutputAt = now;
	}

	addUsage(usage: Usage): void {
		if (!this.current) return;
		this.current.inputTokens += usage.input;
		this.current.outputTokens += usage.output;
		this.current.cacheRead += usage.cacheRead;
		this.current.cacheWrite += usage.cacheWrite;
		this.current.totalTokens += usage.totalTokens;
	}

	finish(status: Exclude<RecentRunStatus, "running">, now = Date.now()): void {
		if (!this.current) return;
		this.current.status = status;
		this.current.endedAt = now;
		this.lastFinished = { ...this.current };
		this.current = undefined;
	}

	reset(): void {
		this.current = undefined;
		this.lastFinished = undefined;
	}

	getLastFinished(): Readonly<RecentRunStatsSnapshot> | undefined {
		return this.lastFinished;
	}
}
