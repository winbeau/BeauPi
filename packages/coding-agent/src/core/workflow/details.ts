import type { SessionEntry } from "../session-manager.ts";
import {
	WORKFLOW_DETAILS_VERSION,
	type WorkflowNodeSnapshot,
	type WorkflowNodeStatus,
	type WorkflowSnapshot,
	type WorkflowStatus,
	type WorkflowToolDetails,
} from "./types.ts";

export const WORKFLOW_DETAILS_KEY = "workflow";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asWorkflowStatus(value: unknown): WorkflowStatus | undefined {
	return value === "pending" ||
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "cancelled" ||
		value === "lost"
		? value
		: undefined;
}

function asWorkflowNodeStatus(value: unknown): WorkflowNodeStatus | undefined {
	return value === "pending" ||
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "skipped" ||
		value === "cancelled" ||
		value === "timed_out" ||
		value === "lost"
		? value
		: undefined;
}

function parseNode(value: unknown): WorkflowNodeSnapshot | undefined {
	const node = asRecord(value);
	const status = asWorkflowNodeStatus(node?.status);
	if (
		!node ||
		!status ||
		typeof node.id !== "string" ||
		typeof node.profile !== "string" ||
		typeof node.taskSummary !== "string" ||
		!Array.isArray(node.dependsOn) ||
		!node.dependsOn.every((dependency) => typeof dependency === "string") ||
		typeof node.writePolicy !== "string" ||
		typeof node.failurePolicy !== "string" ||
		typeof node.createdAt !== "string" ||
		typeof node.durationMs !== "number" ||
		typeof node.monitorId !== "string" ||
		!Array.isArray(node.diagnostics)
	) {
		return undefined;
	}
	return structuredClone(node as unknown as WorkflowNodeSnapshot);
}

function parseSnapshot(value: unknown): WorkflowSnapshot | undefined {
	const snapshot = asRecord(value);
	const status = asWorkflowStatus(snapshot?.status);
	if (
		!snapshot ||
		snapshot.version !== WORKFLOW_DETAILS_VERSION ||
		!status ||
		typeof snapshot.workflowId !== "string" ||
		typeof snapshot.definitionId !== "string" ||
		typeof snapshot.createdAt !== "string" ||
		typeof snapshot.durationMs !== "number" ||
		typeof snapshot.maxConcurrency !== "number" ||
		typeof snapshot.monitorId !== "string" ||
		!Array.isArray(snapshot.nodes) ||
		!Array.isArray(snapshot.diagnostics)
	) {
		return undefined;
	}
	const nodes = snapshot.nodes.map(parseNode);
	if (nodes.some((node) => node === undefined)) return undefined;
	return structuredClone({ ...snapshot, nodes } as unknown as WorkflowSnapshot);
}

export function getWorkflowToolDetails(details: unknown): WorkflowToolDetails | undefined {
	const record = asRecord(details);
	const workflow = asRecord(record?.[WORKFLOW_DETAILS_KEY]);
	if (
		!workflow ||
		workflow.version !== WORKFLOW_DETAILS_VERSION ||
		(workflow.operation !== "workflow_run" &&
			workflow.operation !== "workflow_status" &&
			workflow.operation !== "workflow_cancel") ||
		typeof workflow.ok !== "boolean"
	) {
		return undefined;
	}
	const snapshot = workflow.workflow === undefined ? undefined : parseSnapshot(workflow.workflow);
	const snapshots = Array.isArray(workflow.workflows)
		? workflow.workflows.map(parseSnapshot).filter((item): item is WorkflowSnapshot => item !== undefined)
		: undefined;
	if (workflow.workflow !== undefined && !snapshot) return undefined;
	return structuredClone({ ...workflow, workflow: snapshot, workflows: snapshots } as unknown as WorkflowToolDetails);
}

export function attachWorkflowToolDetails(details: unknown, metadata: WorkflowToolDetails): Record<string, unknown> {
	const record = asRecord(details);
	return record ? { ...record, [WORKFLOW_DETAILS_KEY]: metadata } : { [WORKFLOW_DETAILS_KEY]: metadata };
}

export function workflowSnapshotsFromEntries(entries: readonly SessionEntry[]): WorkflowSnapshot[] {
	const snapshots = new Map<string, WorkflowSnapshot>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const details = getWorkflowToolDetails(entry.message.details);
		if (details?.workflow) snapshots.set(details.workflow.workflowId, details.workflow);
		for (const snapshot of details?.workflows ?? []) snapshots.set(snapshot.workflowId, snapshot);
	}
	return [...snapshots.values()];
}
