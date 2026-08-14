// Neutral execution failure facts.
//
// These types classify *why* a tool execution failed (exit code, permission,
// network, timeout, ...). They are diagnostic facts only: they never gate,
// block, replace, or require confirmation for tool execution.

export type ExecutionFailureCategory =
	| "missing_dependency"
	| "permission"
	| "authentication"
	| "network"
	| "rate_limit"
	| "timeout"
	| "user_cancelled"
	| "command_exit"
	| "configuration"
	| "session_lost"
	| "budget_exhausted"
	| "unknown";

export interface ExecutionFailure {
	category: ExecutionFailureCategory;
	exitCode?: number | null;
	retryable: boolean;
}

export const EXECUTION_FAILURE_CATEGORIES: ReadonlySet<ExecutionFailureCategory> = new Set<ExecutionFailureCategory>([
	"missing_dependency",
	"permission",
	"authentication",
	"network",
	"rate_limit",
	"timeout",
	"user_cancelled",
	"command_exit",
	"configuration",
	"session_lost",
	"budget_exhausted",
	"unknown",
]);
