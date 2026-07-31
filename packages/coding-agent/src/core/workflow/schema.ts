import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { parse } from "yaml";
import { BUILTIN_WORKFLOWS } from "./builtins.ts";
import { validateWorkflowCondition } from "./condition.ts";
import { type NormalizedWorkflowDefinition, WORKFLOW_DEFINITION_VERSION, type WorkflowDefinition } from "./types.ts";

export const WORKFLOW_LIMITS = Object.freeze({
	maxNodes: 64,
	maxConcurrency: 16,
	maxTaskLength: 20_000,
	maxDescriptionLength: 1_000,
	maxTimeoutMs: 86_400_000,
	maxTokens: 2_000_000,
	maxTurns: 1_024,
});

const workflowBudgetSchema = Type.Object(
	{
		maxTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: WORKFLOW_LIMITS.maxTokens })),
		maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: WORKFLOW_LIMITS.maxTurns })),
	},
	{ additionalProperties: false },
);

export const WORKFLOW_NODE_SCHEMA = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_-]*$" }),
		agent: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
		profile: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
		task: Type.String({ minLength: 1, maxLength: WORKFLOW_LIMITS.maxTaskLength }),
		dependsOn: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
				maxItems: WORKFLOW_LIMITS.maxNodes,
				uniqueItems: true,
			}),
		),
		condition: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
		writePolicy: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("shared"), Type.Literal("isolated")])),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: WORKFLOW_LIMITS.maxTimeoutMs })),
		failurePolicy: Type.Optional(
			Type.Union([Type.Literal("fail-workflow"), Type.Literal("continue"), Type.Literal("skip-dependents")]),
		),
		budget: Type.Optional(workflowBudgetSchema),
		cancelStrategy: Type.Optional(Type.Union([Type.Literal("abort"), Type.Literal("graceful")])),
	},
	{ additionalProperties: false },
);

export const WORKFLOW_DEFINITION_SCHEMA = Type.Object(
	{
		version: Type.Literal(WORKFLOW_DEFINITION_VERSION),
		id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_-]*$" }),
		description: Type.Optional(Type.String({ maxLength: WORKFLOW_LIMITS.maxDescriptionLength })),
		maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: WORKFLOW_LIMITS.maxConcurrency })),
		nodes: Type.Array(WORKFLOW_NODE_SCHEMA, { minItems: 1, maxItems: WORKFLOW_LIMITS.maxNodes }),
	},
	{ additionalProperties: false },
);

export type WorkflowDefinitionSchema = Static<typeof WORKFLOW_DEFINITION_SCHEMA>;

const definitionValidator = Compile(WORKFLOW_DEFINITION_SCHEMA);

export class WorkflowValidationError extends Error {
	readonly code: string;
	readonly nodeId?: string;

	constructor(code: string, message: string, nodeId?: string) {
		super(message);
		this.name = "WorkflowValidationError";
		this.code = code;
		this.nodeId = nodeId;
	}
}

function workflowSchemaError(value: unknown): WorkflowValidationError {
	const errors = Array.from(definitionValidator.Errors(value));
	const summary = errors
		.slice(0, 5)
		.map((error) => `${error.instancePath || "/"}: ${error.message}`)
		.join("; ");
	return new WorkflowValidationError("invalid_schema", `Invalid Workflow definition: ${summary || "schema mismatch"}`);
}

function cloneDefinition(definition: WorkflowDefinition): WorkflowDefinition {
	return structuredClone(definition);
}

export function parseWorkflowDefinition(input: string | WorkflowDefinition): WorkflowDefinition {
	if (typeof input !== "string") return cloneDefinition(input);
	const source = input.trim();
	if (!source) throw new WorkflowValidationError("invalid_source", "Workflow source must not be empty");
	const builtin = BUILTIN_WORKFLOWS[source];
	if (builtin) return cloneDefinition(builtin);
	let parsed: unknown;
	try {
		parsed = parse(source, { maxAliasCount: 0 }) as unknown;
	} catch (error) {
		throw new WorkflowValidationError(
			"parse_failed",
			`Failed to parse Workflow YAML/JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parsed as WorkflowDefinition;
}

function assertAcyclic(nodes: readonly { id: string; dependsOn: readonly string[] }[]): void {
	const dependencies = new Map(nodes.map((node) => [node.id, node.dependsOn]));
	const states = new Map<string, "visiting" | "visited">();
	const visit = (nodeId: string, path: string[]): void => {
		const state = states.get(nodeId);
		if (state === "visited") return;
		if (state === "visiting") {
			const cycleStart = path.indexOf(nodeId);
			const cycle = [...path.slice(cycleStart), nodeId];
			throw new WorkflowValidationError(
				"dependency_cycle",
				`Workflow dependency cycle: ${cycle.join(" -> ")}`,
				nodeId,
			);
		}
		states.set(nodeId, "visiting");
		for (const dependency of dependencies.get(nodeId) ?? []) visit(dependency, [...path, nodeId]);
		states.set(nodeId, "visited");
	};
	for (const node of nodes) visit(node.id, []);
}

export function validateWorkflowDefinition(
	definition: WorkflowDefinition,
	profileExists: (profile: string) => boolean,
): NormalizedWorkflowDefinition {
	if (!definitionValidator.Check(definition)) throw workflowSchemaError(definition);
	const ids = new Set<string>();
	for (const node of definition.nodes) {
		if (ids.has(node.id)) {
			throw new WorkflowValidationError(
				"duplicate_node_id",
				`Duplicate Workflow node id ${JSON.stringify(node.id)}`,
				node.id,
			);
		}
		ids.add(node.id);
	}
	const normalizedNodes = definition.nodes.map((node) => {
		const profile = node.profile ?? node.agent;
		if (!profile) {
			throw new WorkflowValidationError(
				"profile_required",
				`Workflow node ${JSON.stringify(node.id)} needs agent or profile`,
				node.id,
			);
		}
		if (node.profile && node.agent && node.profile !== node.agent) {
			throw new WorkflowValidationError(
				"profile_conflict",
				`Workflow node ${JSON.stringify(node.id)} has conflicting agent and profile values`,
				node.id,
			);
		}
		if (!profileExists(profile)) {
			throw new WorkflowValidationError(
				"profile_not_found",
				`Unknown Agent Profile ${JSON.stringify(profile)}`,
				node.id,
			);
		}
		const dependsOn = [...(node.dependsOn ?? [])];
		for (const dependency of dependsOn) {
			if (!ids.has(dependency)) {
				throw new WorkflowValidationError(
					"unknown_dependency",
					`Workflow node ${JSON.stringify(node.id)} depends on unknown node ${JSON.stringify(dependency)}`,
					node.id,
				);
			}
			if (dependency === node.id) {
				throw new WorkflowValidationError(
					"dependency_cycle",
					`Workflow node ${JSON.stringify(node.id)} depends on itself`,
					node.id,
				);
			}
		}
		if (node.condition) {
			try {
				validateWorkflowCondition(node.condition, new Set(dependsOn));
			} catch (error) {
				throw new WorkflowValidationError(
					"invalid_condition",
					`Workflow node ${JSON.stringify(node.id)} has an invalid condition: ${error instanceof Error ? error.message : String(error)}`,
					node.id,
				);
			}
		}
		return {
			id: node.id,
			profile,
			task: node.task,
			dependsOn,
			condition: node.condition,
			writePolicy: node.writePolicy ?? "none",
			timeoutMs: node.timeoutMs,
			failurePolicy: node.failurePolicy ?? "fail-workflow",
			budget: node.budget ? { ...node.budget } : undefined,
			cancelStrategy: node.cancelStrategy,
		};
	});
	assertAcyclic(normalizedNodes);
	return {
		version: WORKFLOW_DEFINITION_VERSION,
		id: definition.id,
		description: definition.description,
		maxConcurrency: definition.maxConcurrency ?? 4,
		nodes: normalizedNodes,
	};
}

export function materializeWorkflowTask(definition: NormalizedWorkflowDefinition, task: string | undefined): void {
	for (const node of definition.nodes) {
		if (!node.task.includes("{{task}}")) continue;
		if (!task?.trim()) {
			throw new WorkflowValidationError(
				"task_required",
				`Workflow ${JSON.stringify(definition.id)} requires the workflow_run task parameter`,
				node.id,
			);
		}
		node.task = node.task.replaceAll("{{task}}", task.trim());
	}
}
