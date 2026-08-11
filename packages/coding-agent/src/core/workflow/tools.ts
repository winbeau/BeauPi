import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { WorkflowSnapshotComponent } from "../../modes/interactive/components/workflow.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { attachWorkflowToolDetails, getWorkflowToolDetails } from "./details.ts";
import { WORKFLOW_RUN_DEFINITION_SCHEMA, WorkflowValidationError } from "./schema.ts";
import {
	WORKFLOW_DETAILS_VERSION,
	type WorkflowCancelResult,
	type WorkflowSnapshot,
	type WorkflowToolDetails,
} from "./types.ts";
import type { WorkflowRuntime } from "./workflow-runtime.ts";

export const WORKFLOW_RUN_SCHEMA = Type.Object(
	{
		workflow: Type.Union([
			Type.String({ minLength: 1, description: "Built-in Workflow id or serialized Workflow YAML/JSON" }),
			WORKFLOW_RUN_DEFINITION_SCHEMA,
		]),
		task: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
		background: Type.Optional(
			Type.Boolean({ description: "Return after startup and keep the Workflow running session-scoped" }),
		),
	},
	{ additionalProperties: false },
);

export const WORKFLOW_STATUS_SCHEMA = Type.Object(
	{ workflowId: Type.Optional(Type.String({ minLength: 1 })) },
	{ additionalProperties: false },
);

export const WORKFLOW_CANCEL_SCHEMA = Type.Object(
	{ workflowId: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);

type WorkflowRunParameters = Static<typeof WORKFLOW_RUN_SCHEMA>;
type WorkflowStatusParameters = Static<typeof WORKFLOW_STATUS_SCHEMA>;
type WorkflowCancelParameters = Static<typeof WORKFLOW_CANCEL_SCHEMA>;

const runValidator = Compile(WORKFLOW_RUN_SCHEMA);
const statusValidator = Compile(WORKFLOW_STATUS_SCHEMA);
const cancelValidator = Compile(WORKFLOW_CANCEL_SCHEMA);

function validate<T>(name: string, validator: { Check(value: unknown): boolean }, value: unknown): asserts value is T {
	if (!validator.Check(value)) throw new Error(`${name} received invalid parameters`);
}

function details(
	operation: WorkflowToolDetails["operation"],
	value: Omit<WorkflowToolDetails, "version" | "operation">,
) {
	return attachWorkflowToolDetails(undefined, {
		version: WORKFLOW_DETAILS_VERSION,
		operation,
		...value,
	});
}

function snapshotText(snapshot: WorkflowSnapshot): string {
	return JSON.stringify(snapshot);
}

function conciseSnapshot(snapshot: WorkflowSnapshot): string {
	const completed = snapshot.nodes.filter((node) => node.status === "completed").length;
	const failed = snapshot.nodes.filter(
		(node) => node.status === "failed" || node.status === "timed_out" || node.status === "lost",
	).length;
	return `${snapshot.workflowId} · ${snapshot.status} · ${completed}/${snapshot.nodes.length} completed${failed ? ` · ${failed} failed` : ""}`;
}

function partialResult(snapshot: WorkflowSnapshot): AgentToolResult<Record<string, unknown>> {
	return {
		content: [{ type: "text", text: conciseSnapshot(snapshot) }],
		details: details("workflow_run", { ok: true, workflow: snapshot }),
	};
}

function renderResult(
	result: AgentToolResult<unknown>,
	options: { expanded: boolean },
	currentTheme: Parameters<NonNullable<ToolDefinition["renderResult"]>>[2],
) {
	const workflow = getWorkflowToolDetails(result.details);
	if (workflow?.workflow) return new WorkflowSnapshotComponent(workflow.workflow, currentTheme, options.expanded);
	if (workflow?.workflows) {
		return new Text(
			workflow.workflows.length > 0
				? workflow.workflows.map((snapshot) => conciseSnapshot(snapshot)).join("\n")
				: currentTheme.fg("dim", "No Workflows recorded."),
			0,
			0,
		);
	}
	return new Text(workflow?.error?.message ?? "Workflow result unavailable", 0, 0);
}

function createRunTool(runtime: WorkflowRuntime): ToolDefinition<typeof WORKFLOW_RUN_SCHEMA, Record<string, unknown>> {
	const profiles = runtime.getProfileIds();
	const profileGuidance = `Omit node agent/profile to use ${runtime.defaultProfileId}. Available profiles: ${profiles.join(", ")}.`;
	return {
		name: "workflow_run",
		label: "Workflow",
		description:
			"Start a validated multi-Agent Workflow DAG using the existing Agent Pool and Monitor Runtime; version and node profile may be omitted.",
		promptSnippet: "workflow_run: run a versioned built-in or YAML/JSON multi-Agent DAG",
		promptGuidelines: [
			profileGuidance,
			"Set background=true when the DAG should continue after workflow_run returns; inspect it with workflow_status and cancel it with workflow_cancel.",
			"Workflow nodes receive only structured dependency outputs, never dependency transcripts.",
			"Use shared writes for a single workspace writer and isolated writes only when a Git Worktree is required.",
		],
		parameters: WORKFLOW_RUN_SCHEMA,
		executionMode: "parallel",
		execute: async (_toolCallId, params, signal, onUpdate) => {
			validate<WorkflowRunParameters>("workflow_run", runValidator, params);
			try {
				const snapshot = params.background
					? runtime.start(params)
					: await runtime.run(params, signal, (update) =>
							(onUpdate as AgentToolUpdateCallback<Record<string, unknown>> | undefined)?.(
								partialResult(update),
							),
						);
				const ok = params.background === true || snapshot.status === "completed";
				return {
					content: [{ type: "text", text: snapshotText(snapshot) }],
					details: details("workflow_run", {
						ok,
						workflow: snapshot,
						error: ok
							? undefined
							: {
									code: snapshot.error?.code ?? snapshot.status,
									message: snapshot.error?.message ?? `Workflow ended with status ${snapshot.status}`,
								},
					}),
				};
			} catch (error) {
				const code = error instanceof WorkflowValidationError ? error.code : "workflow_error";
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{ type: "text", text: JSON.stringify({ version: 1, status: "failed", error: { code, message } }) },
					],
					details: details("workflow_run", { ok: false, error: { code, message } }),
				};
			}
		},
		renderCall: (args, currentTheme) =>
			new Text(
				`${currentTheme.bold("Workflow")}(${typeof args.workflow === "string" ? args.workflow.split(/\r\n|\r|\n/, 1)[0] : args.workflow.id})`,
				0,
				0,
			),
		renderResult,
	};
}

function createStatusTool(
	runtime: WorkflowRuntime,
): ToolDefinition<typeof WORKFLOW_STATUS_SCHEMA, Record<string, unknown>> {
	return {
		name: "workflow_status",
		label: "Workflow Status",
		description: "Read one Workflow snapshot or list the current branch Workflow facts.",
		promptSnippet: "workflow_status: inspect structured Workflow and node state",
		parameters: WORKFLOW_STATUS_SCHEMA,
		executionMode: "parallel",
		execute: async (_toolCallId, params) => {
			validate<WorkflowStatusParameters>("workflow_status", statusValidator, params);
			if (params.workflowId) {
				const workflow = runtime.status(params.workflowId);
				if (!workflow) {
					const message = `Unknown Workflow id ${JSON.stringify(params.workflowId)}`;
					return {
						content: [{ type: "text", text: message }],
						details: details("workflow_status", {
							ok: false,
							error: { code: "workflow_not_found", message },
						}),
					};
				}
				return {
					content: [{ type: "text", text: snapshotText(workflow) }],
					details: details("workflow_status", { ok: true, workflow }),
				};
			}
			const workflows = runtime.list();
			return {
				content: [{ type: "text", text: JSON.stringify(workflows) }],
				details: details("workflow_status", { ok: true, workflows }),
			};
		},
		renderCall: (args, currentTheme) =>
			new Text(`${currentTheme.bold("Workflow Status")}(${args.workflowId ?? ""})`, 0, 0),
		renderResult,
	};
}

function createCancelTool(
	runtime: WorkflowRuntime,
): ToolDefinition<typeof WORKFLOW_CANCEL_SCHEMA, Record<string, unknown>> {
	return {
		name: "workflow_cancel",
		label: "Workflow Cancel",
		description: "Request deterministic cancellation of an active Workflow; repeated cancellation is idempotent.",
		promptSnippet: "workflow_cancel: cancel an active Workflow DAG",
		parameters: WORKFLOW_CANCEL_SCHEMA,
		executionMode: "parallel",
		execute: async (_toolCallId, params) => {
			validate<WorkflowCancelParameters>("workflow_cancel", cancelValidator, params);
			const cancel: WorkflowCancelResult = await runtime.cancelWorkflow(params.workflowId);
			const ok = cancel.reason !== "workflow_not_found";
			return {
				content: [
					{
						type: "text",
						text: cancel.workflow ? snapshotText(cancel.workflow) : `Workflow cancellation: ${cancel.reason}`,
					},
				],
				details: details("workflow_cancel", {
					ok,
					workflow: cancel.workflow,
					cancel,
					error: ok
						? undefined
						: { code: "workflow_not_found", message: `Unknown Workflow id ${JSON.stringify(params.workflowId)}` },
				}),
			};
		},
		renderCall: (args, currentTheme) => new Text(`${currentTheme.bold("Workflow Cancel")}(${args.workflowId})`, 0, 0),
		renderResult,
	};
}

export function createWorkflowToolDefinitions(runtime: WorkflowRuntime): ToolDefinition[] {
	return [createRunTool(runtime), createStatusTool(runtime), createCancelTool(runtime)] as ToolDefinition[];
}
