import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../extensions/types.ts";
import type { DynamicTaskRuntime } from "./dynamic-task-runtime.ts";
import { TASKS_UPDATE_SCHEMA } from "./schema.ts";
import {
	DYNAMIC_TASK_DETAILS_KEY,
	DYNAMIC_TASK_VERSION,
	type DynamicTaskToolDetailsV1,
	type TasksUpdateInputV1,
} from "./types.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function attachDynamicTaskToolDetails(details: unknown, dynamicTask: DynamicTaskToolDetailsV1): unknown {
	const record = asRecord(details);
	return { ...(record ?? {}), [DYNAMIC_TASK_DETAILS_KEY]: structuredClone(dynamicTask) };
}

export function getDynamicTaskToolDetails(details: unknown): DynamicTaskToolDetailsV1 | undefined {
	const value = asRecord(asRecord(details)?.[DYNAMIC_TASK_DETAILS_KEY]);
	const result = asRecord(value?.result);
	if (
		value?.version !== DYNAMIC_TASK_VERSION ||
		value.operation !== "tasks_update" ||
		typeof value.ok !== "boolean" ||
		(value.reason !== "initial_plan" &&
			value.reason !== "work_started" &&
			value.reason !== "plan_changed" &&
			value.reason !== "blocked") ||
		!result ||
		result.version !== DYNAMIC_TASK_VERSION
	) {
		return undefined;
	}
	return structuredClone(value as unknown as DynamicTaskToolDetailsV1);
}

function resultSummary(details: DynamicTaskToolDetailsV1): string {
	const result = details.result;
	if (result.status === "revision_conflict") {
		return `Revision conflict · expected r${result.expectedRevision} · current r${result.actualRevision}`;
	}
	if (result.status === "invalid") {
		return result.diagnostics[0]?.message ?? "Dynamic Task update was rejected";
	}
	const snapshot = result.snapshot;
	if (!snapshot) return `Dynamic Task plan unchanged at revision ${result.actualRevision}`;
	const completed = snapshot.tasks.filter((task) => task.status === "completed").length;
	const rebased =
		result.status === "accepted" && snapshot.revision > result.expectedRevision + 1
			? ` · rebased from r${result.expectedRevision}`
			: "";
	return `${snapshot.tasks.length} tasks · ${completed} completed · revision ${snapshot.revision}${rebased}`;
}

export function createTasksUpdateToolDefinition(
	runtime: DynamicTaskRuntime,
): ToolDefinition<typeof TASKS_UPDATE_SCHEMA, Record<string, unknown>> {
	return {
		name: "tasks_update",
		label: "Tasks",
		description:
			"Create or revise the Coordinator's versioned structured task plan using expectedRevision compare-and-swap with safe fact-only rebasing.",
		promptSnippet: "tasks_update: create or revise the Coordinator's structured task plan",
		promptGuidelines: [
			"For an executable user task without a plan, call tasks_update once in the existing first model turn with reason initial_plan; do not start a separate planning request.",
			"The Coordinator is the only author of Task structure: only it may add, remove, rename, reorder, reopen, or change dependencies.",
			"Keep plans at 3-7 meaningful mid-level phases when practical; do not create one Task per file or command.",
			"Keep each Task title concise but identifiable—normally around 15 Chinese characters or an equivalently short phrase—and retain one or two distinguishing domain nouns such as a component, protocol, or subsystem name. Prefer forms like 'Review WorkflowRuntime', 'Design tmux safety gate', or 'Implement Bash executor interaction'. Avoid commands, file paths, key sequences, step-by-step mechanics, and sentence-like detail; this is a soft style target, not a validation limit.",
			"Use work_started, plan_changed, or blocked when scope, approach, blockers, verification, or user requirements materially change.",
			"Use the current projected revision as expectedRevision. If deterministic Tool, evidence, Background, Workflow, or Monitor facts advance only task state, the Runtime safely rebases the update; retry only when the returned snapshot reports a real structural revision conflict.",
		],
		parameters: TASKS_UPDATE_SCHEMA,
		executionMode: "sequential",
		execute: async (_toolCallId, params) => {
			const result = await runtime.updatePlan(params);
			const reason =
				typeof params === "object" && params !== null && "reason" in params
					? (params as TasksUpdateInputV1).reason
					: "plan_changed";
			const details: DynamicTaskToolDetailsV1 = {
				version: DYNAMIC_TASK_VERSION,
				operation: "tasks_update",
				ok: result.status === "accepted" || result.status === "no_change",
				reason,
				result,
			};
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: attachDynamicTaskToolDetails(undefined, details) as Record<string, unknown>,
			};
		},
		renderCall: (args, currentTheme) =>
			new Text(`${currentTheme.bold("Tasks")}(${args.reason} · expected r${args.expectedRevision})`, 0, 0),
		renderResult: (result: AgentToolResult<Record<string, unknown>>, _options, currentTheme) => {
			const details = getDynamicTaskToolDetails(result.details);
			if (!details) return new Text(currentTheme.fg("warning", "Dynamic Task result unavailable"), 0, 0);
			const color = details.ok ? "success" : details.result.status === "revision_conflict" ? "warning" : "error";
			return new Text(currentTheme.fg(color, resultSummary(details)), 0, 0);
		},
	};
}
