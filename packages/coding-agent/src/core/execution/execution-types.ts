// Neutral execution result and run lifecycle facts.
//
// These types describe *what happened* to an execution (status, exit code,
// duration, failure category) and the phase of a run. They are facts and
// diagnostics only: they never allow, deny, pause, or require confirmation.

import type { ExecutionFailureCategory } from "./failure-types.ts";

export type ExecutionStatus = "completed" | "failed" | "cancelled" | "timed_out" | "killed" | "unknown";

export interface ExecutionOutcome {
	status: ExecutionStatus;
	exitCode: number | null;
	signal?: string;
	durationMs?: number;
	failureCategory?: ExecutionFailureCategory;
	truncated?: boolean;
	fullOutputPath?: string;
}

/**
 * Run lifecycle contract.
 *
 * created → running → cancelling → settling → completed | failed | cancelled | unknown
 *
 * A settlement promise resolves to the final status; continuations awaiting it
 * must not write into a replaced session/run (check the run/session identity
 * before writing). This is state consistency, not authorization.
 */
export type RunPhase =
	| "created"
	| "running"
	| "cancelling"
	| "settling"
	| "completed"
	| "failed"
	| "cancelled"
	| "unknown";

export interface RunState {
	runId: string;
	sessionId: string;
	owner: string;
	attempt: number;
	phase: RunPhase;
	startedAt?: number;
	endedAt?: number;
	signal: AbortSignal;
	settlement: Promise<ExecutionStatus>;
}

/** Neutral status for a local Bash execution result. */
export function bashExecutionStatus(input: {
	exitCode: number | null | undefined;
	cancelled: boolean;
	timedOut: boolean;
}): ExecutionStatus {
	if (input.cancelled) return "cancelled";
	if (input.timedOut) return "timed_out";
	if (input.exitCode === null) return "killed";
	if (input.exitCode === undefined) return "unknown";
	return input.exitCode === 0 ? "completed" : "failed";
}

/**
 * Neutral failure category for a Bash exit code/output pair.
 * Shared by the tool path and the session execution path so both surfaces
 * report the same category.
 */
export function bashFailureCategory(
	exitCode: number | null | undefined,
	output: string,
): ExecutionFailureCategory | undefined {
	if (exitCode === 127) return "missing_dependency";
	if (exitCode === 126 || /permission denied|operation not permitted|\bEACCES\b|\bEPERM\b/i.test(output)) {
		return "permission";
	}
	if (exitCode !== undefined && exitCode !== null && exitCode !== 0) return "command_exit";
	return undefined;
}
