import type { AgentCancellationStrategy, AgentTaskResult } from "../agents/index.ts";

export const WORKFLOW_DEFINITION_VERSION = 1;
export const WORKFLOW_DETAILS_VERSION = 1;

export type WorkflowWritePolicy = "none" | "shared" | "isolated";
export type WorkflowFailurePolicy = "fail-workflow" | "continue" | "skip-dependents";
export type WorkflowStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "lost";
export type WorkflowNodeStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "skipped"
	| "cancelled"
	| "timed_out"
	| "lost";

export interface WorkflowBudget {
	maxTokens?: number;
	maxTurns?: number;
}

export interface WorkflowNodeDefinition {
	id: string;
	agent?: string;
	profile?: string;
	task: string;
	dependsOn?: string[];
	condition?: string;
	writePolicy?: WorkflowWritePolicy;
	timeoutMs?: number;
	failurePolicy?: WorkflowFailurePolicy;
	budget?: WorkflowBudget;
	cancelStrategy?: AgentCancellationStrategy;
}

export interface WorkflowDefinition {
	version: typeof WORKFLOW_DEFINITION_VERSION;
	id: string;
	description?: string;
	maxConcurrency?: number;
	nodes: WorkflowNodeDefinition[];
}

/** Ergonomic Workflow input; omitted versions normalize to the current schema version. */
export type WorkflowDefinitionInput = Omit<WorkflowDefinition, "version"> & {
	version?: typeof WORKFLOW_DEFINITION_VERSION;
};

export interface NormalizedWorkflowNodeDefinition {
	id: string;
	profile: string;
	task: string;
	dependsOn: string[];
	condition?: string;
	writePolicy: WorkflowWritePolicy;
	timeoutMs?: number;
	failurePolicy: WorkflowFailurePolicy;
	budget?: WorkflowBudget;
	cancelStrategy?: AgentCancellationStrategy;
}

export interface NormalizedWorkflowDefinition {
	version: typeof WORKFLOW_DEFINITION_VERSION;
	id: string;
	description?: string;
	maxConcurrency: number;
	nodes: NormalizedWorkflowNodeDefinition[];
}

export interface WorkflowDiagnostic {
	code: string;
	message: string;
	nodeId?: string;
}

export interface WorkflowWorktreeSnapshot {
	path: string;
	branch: string;
	status: "active" | "cleaned" | "cleanup_failed";
	cleanup: "node_terminal" | "workflow_terminal" | "session_end";
}

export interface WorkflowNodeSnapshot {
	id: string;
	/** Stable AgentPool task id used by agent_control while this node runs. */
	agentId?: string;
	profile: string;
	taskSummary: string;
	dependsOn: string[];
	condition?: string;
	writePolicy: WorkflowWritePolicy;
	failurePolicy: WorkflowFailurePolicy;
	status: WorkflowNodeStatus;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	durationMs: number;
	monitorId: string;
	output?: AgentTaskResult;
	worktree?: WorkflowWorktreeSnapshot;
	diagnostics: WorkflowDiagnostic[];
	error?: { code: string; message: string };
}

export interface WorkflowSnapshot {
	version: typeof WORKFLOW_DETAILS_VERSION;
	workflowId: string;
	definitionId: string;
	description?: string;
	status: WorkflowStatus;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	durationMs: number;
	maxConcurrency: number;
	monitorId: string;
	nodes: WorkflowNodeSnapshot[];
	diagnostics: WorkflowDiagnostic[];
	error?: { code: string; message: string; nodeId?: string };
}

export interface WorkflowRunInput {
	workflow: string | WorkflowDefinitionInput;
	task?: string;
	/** Return after deterministic startup instead of waiting for the DAG to finish. */
	background?: boolean;
}

export interface WorkflowCancelResult {
	accepted: boolean;
	reason: "cancel_requested" | "already_terminal" | "workflow_not_found";
	workflow?: WorkflowSnapshot;
}

export interface WorkflowToolDetails {
	version: typeof WORKFLOW_DETAILS_VERSION;
	operation: "workflow_run" | "workflow_status" | "workflow_cancel";
	ok: boolean;
	workflow?: WorkflowSnapshot;
	workflows?: WorkflowSnapshot[];
	cancel?: WorkflowCancelResult;
	error?: { code: string; message: string };
}

export function isWorkflowNodeTerminal(status: WorkflowNodeStatus): boolean {
	return (
		status === "completed" ||
		status === "failed" ||
		status === "skipped" ||
		status === "cancelled" ||
		status === "timed_out" ||
		status === "lost"
	);
}

export function isWorkflowTerminal(status: WorkflowStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled" || status === "lost";
}
