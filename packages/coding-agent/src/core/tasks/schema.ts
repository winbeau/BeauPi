import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import {
	DYNAMIC_TASK_VERSION,
	type DynamicTaskItemV1,
	type DynamicTaskPlanV1,
	type TaskPatchV1,
	type TasksUpdateInputV1,
} from "./types.ts";

export const DYNAMIC_TASK_LIMITS = Object.freeze({
	maxTasks: 16,
	maxIdLength: 64,
	maxGoalLength: 1_000,
	maxTitleLength: 240,
	maxActivityLength: 500,
	maxDependsOn: 16,
	maxMatchHints: 12,
	maxMatchHintLength: 240,
	maxEvidence: 32,
	maxBlockers: 8,
	maxBlockerLength: 240,
	maxFacts: 128,
	maxFactIdLength: 240,
	maxFactRefLength: 500,
	maxFactSummaryLength: 500,
	maxPathLength: 1_000,
	maxPlanCharacters: 64_000,
	maxPatchUpdates: 16,
});

const strict = { additionalProperties: false } as const;
const taskStatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("active"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("blocked"),
]);
const updateReasonSchema = Type.Union([
	Type.Literal("initial_plan"),
	Type.Literal("work_started"),
	Type.Literal("plan_changed"),
	Type.Literal("blocked"),
]);
const factKindSchema = Type.Union([
	Type.Literal("tool"),
	Type.Literal("file"),
	Type.Literal("verification"),
	Type.Literal("workflow"),
	Type.Literal("background"),
	Type.Literal("monitor"),
	Type.Literal("failure"),
]);
const factStatusSchema = Type.Union([
	Type.Literal("started"),
	Type.Literal("running"),
	Type.Literal("healthy"),
	Type.Literal("succeeded"),
	Type.Literal("passed"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("cancelled"),
	Type.Literal("blocked"),
	Type.Literal("stalled"),
	Type.Literal("lost"),
]);
const taskIdSchema = Type.String({
	minLength: 1,
	maxLength: DYNAMIC_TASK_LIMITS.maxIdLength,
	pattern: "^[A-Za-z][A-Za-z0-9_-]*$",
});
const blockersSchema = Type.Array(Type.String({ minLength: 1, maxLength: DYNAMIC_TASK_LIMITS.maxBlockerLength }), {
	maxItems: DYNAMIC_TASK_LIMITS.maxBlockers,
	uniqueItems: true,
});
const dependenciesSchema = Type.Array(taskIdSchema, {
	maxItems: DYNAMIC_TASK_LIMITS.maxDependsOn,
	uniqueItems: true,
});
const matchHintsSchema = Type.Array(Type.String({ minLength: 1, maxLength: DYNAMIC_TASK_LIMITS.maxMatchHintLength }), {
	maxItems: DYNAMIC_TASK_LIMITS.maxMatchHints,
	uniqueItems: true,
});
const evidenceSchema = Type.Array(Type.String({ minLength: 1, maxLength: DYNAMIC_TASK_LIMITS.maxFactIdLength }), {
	maxItems: DYNAMIC_TASK_LIMITS.maxEvidence,
	uniqueItems: true,
});

export const TASKS_UPDATE_TASK_SCHEMA = Type.Object(
	{
		id: taskIdSchema,
		title: Type.String({
			minLength: 1,
			maxLength: DYNAMIC_TASK_LIMITS.maxTitleLength,
			description:
				"Concise mid-level phase label retaining one or two distinguishing domain nouns (component, protocol, or subsystem names), normally around 15 Chinese characters or an equivalently short phrase; avoid commands, paths, key sequences, and step-by-step details.",
		}),
		status: taskStatusSchema,
		dependsOn: Type.Optional(dependenciesSchema),
		matchHints: Type.Optional(matchHintsSchema),
		activity: Type.Optional(Type.String({ minLength: 1, maxLength: DYNAMIC_TASK_LIMITS.maxActivityLength })),
		blockedBy: Type.Optional(blockersSchema),
	},
	strict,
);

export const TASKS_UPDATE_SCHEMA = Type.Object(
	{
		version: Type.Literal(DYNAMIC_TASK_VERSION),
		expectedRevision: Type.Integer({ minimum: 0 }),
		reason: updateReasonSchema,
		goal: Type.String({ minLength: 1, maxLength: DYNAMIC_TASK_LIMITS.maxGoalLength }),
		tasks: Type.Array(TASKS_UPDATE_TASK_SCHEMA, { minItems: 1, maxItems: DYNAMIC_TASK_LIMITS.maxTasks }),
	},
	strict,
);

export const DYNAMIC_TASK_FACT_SCHEMA = Type.Object(
	{
		version: Type.Literal(DYNAMIC_TASK_VERSION),
		sequence: Type.Integer({ minimum: 1 }),
		id: Type.String({ minLength: 1, maxLength: DYNAMIC_TASK_LIMITS.maxFactIdLength }),
		kind: factKindSchema,
		ref: Type.String({ minLength: 1, maxLength: DYNAMIC_TASK_LIMITS.maxFactRefLength }),
		status: factStatusSchema,
		summary: Type.String({ minLength: 1, maxLength: DYNAMIC_TASK_LIMITS.maxFactSummaryLength }),
		path: Type.Optional(Type.String({ minLength: 1, maxLength: DYNAMIC_TASK_LIMITS.maxPathLength })),
		createdAt: Type.Number({ minimum: 0 }),
	},
	strict,
);

export const DYNAMIC_TASK_ITEM_SCHEMA = Type.Object(
	{
		id: taskIdSchema,
		title: Type.String({
			minLength: 1,
			maxLength: DYNAMIC_TASK_LIMITS.maxTitleLength,
			description:
				"Concise mid-level phase label retaining one or two distinguishing domain nouns (component, protocol, or subsystem names), normally around 15 Chinese characters or an equivalently short phrase; avoid commands, paths, key sequences, and step-by-step details.",
		}),
		status: taskStatusSchema,
		dependsOn: dependenciesSchema,
		matchHints: matchHintsSchema,
		activity: Type.Optional(Type.String({ minLength: 1, maxLength: DYNAMIC_TASK_LIMITS.maxActivityLength })),
		evidence: evidenceSchema,
		blockedBy: blockersSchema,
		createdAt: Type.Number({ minimum: 0 }),
		updatedAt: Type.Number({ minimum: 0 }),
		completedAt: Type.Optional(Type.Number({ minimum: 0 })),
	},
	strict,
);

export const DYNAMIC_TASK_PLAN_SCHEMA = Type.Object(
	{
		version: Type.Literal(DYNAMIC_TASK_VERSION),
		planId: Type.String({ minLength: 1, maxLength: 100 }),
		revision: Type.Integer({ minimum: 1 }),
		goal: Type.String({ minLength: 1, maxLength: DYNAMIC_TASK_LIMITS.maxGoalLength }),
		createdAt: Type.Number({ minimum: 0 }),
		updatedAt: Type.Number({ minimum: 0 }),
		factSequence: Type.Integer({ minimum: 0 }),
		tasks: Type.Array(DYNAMIC_TASK_ITEM_SCHEMA, { minItems: 1, maxItems: DYNAMIC_TASK_LIMITS.maxTasks }),
		facts: Type.Array(DYNAMIC_TASK_FACT_SCHEMA, { maxItems: DYNAMIC_TASK_LIMITS.maxFacts }),
	},
	strict,
);

export const TASK_PATCH_UPDATE_SCHEMA = Type.Object(
	{
		id: taskIdSchema,
		status: Type.Optional(taskStatusSchema),
		activity: Type.Optional(Type.String({ minLength: 1, maxLength: DYNAMIC_TASK_LIMITS.maxActivityLength })),
		evidence: Type.Optional(evidenceSchema),
		blockedBy: Type.Optional(blockersSchema),
	},
	strict,
);

export const TASK_PATCH_SCHEMA = Type.Object(
	{
		version: Type.Literal(DYNAMIC_TASK_VERSION),
		expectedRevision: Type.Integer({ minimum: 1 }),
		factsHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		updates: Type.Array(TASK_PATCH_UPDATE_SCHEMA, {
			minItems: 1,
			maxItems: DYNAMIC_TASK_LIMITS.maxPatchUpdates,
		}),
	},
	strict,
);

const updateValidator = Compile(TASKS_UPDATE_SCHEMA);
const planValidator = Compile(DYNAMIC_TASK_PLAN_SCHEMA);
const patchValidator = Compile(TASK_PATCH_SCHEMA);

type UpdateSchema = Static<typeof TASKS_UPDATE_SCHEMA>;
type PlanSchema = Static<typeof DYNAMIC_TASK_PLAN_SCHEMA>;
type PatchSchema = Static<typeof TASK_PATCH_SCHEMA>;

export class DynamicTaskValidationError extends Error {
	readonly code: string;
	readonly taskId?: string;

	constructor(code: string, message: string, taskId?: string) {
		super(message);
		this.name = "DynamicTaskValidationError";
		this.code = code;
		this.taskId = taskId;
	}
}

function schemaError(
	label: string,
	validator: { Errors(value: unknown): Iterable<{ instancePath: string; message?: string }> },
	value: unknown,
): DynamicTaskValidationError {
	const details = Array.from(validator.Errors(value))
		.slice(0, 5)
		.map((error) => `${error.instancePath || "/"}: ${error.message ?? "schema mismatch"}`)
		.join("; ");
	return new DynamicTaskValidationError("invalid_schema", `${label} is invalid: ${details || "schema mismatch"}`);
}

function assertUnique(values: readonly string[], label: string, taskId?: string): void {
	if (new Set(values).size !== values.length) {
		throw new DynamicTaskValidationError("duplicate_value", `${label} contains duplicate values`, taskId);
	}
}

function validateDependencies(tasks: readonly { id: string; dependsOn?: readonly string[] }[]): void {
	const ids = new Set<string>();
	for (const task of tasks) {
		if (ids.has(task.id)) {
			throw new DynamicTaskValidationError(
				"duplicate_task_id",
				`Duplicate Task id ${JSON.stringify(task.id)}`,
				task.id,
			);
		}
		ids.add(task.id);
	}
	const dependencies = new Map<string, readonly string[]>();
	for (const task of tasks) {
		const taskDependencies = task.dependsOn ?? [];
		assertUnique(taskDependencies, `Task ${JSON.stringify(task.id)} dependsOn`, task.id);
		for (const dependency of taskDependencies) {
			if (dependency === task.id) {
				throw new DynamicTaskValidationError(
					"dependency_cycle",
					`Task ${JSON.stringify(task.id)} cannot depend on itself`,
					task.id,
				);
			}
			if (!ids.has(dependency)) {
				throw new DynamicTaskValidationError(
					"unknown_dependency",
					`Task ${JSON.stringify(task.id)} depends on unknown Task ${JSON.stringify(dependency)}`,
					task.id,
				);
			}
		}
		dependencies.set(task.id, taskDependencies);
	}
	const states = new Map<string, "visiting" | "visited">();
	const visit = (taskId: string, path: string[]): void => {
		const state = states.get(taskId);
		if (state === "visited") return;
		if (state === "visiting") {
			const start = path.indexOf(taskId);
			throw new DynamicTaskValidationError(
				"dependency_cycle",
				`Dynamic Task dependency cycle: ${[...path.slice(start), taskId].join(" -> ")}`,
				taskId,
			);
		}
		states.set(taskId, "visiting");
		for (const dependency of dependencies.get(taskId) ?? []) visit(dependency, [...path, taskId]);
		states.set(taskId, "visited");
	};
	for (const task of tasks) visit(task.id, []);
}

function validateBlockedState(tasks: readonly { id: string; status: string; blockedBy?: readonly string[] }[]): void {
	for (const task of tasks) {
		if (task.status === "blocked" && (task.blockedBy?.length ?? 0) === 0) {
			throw new DynamicTaskValidationError(
				"blocked_reason_required",
				`Task ${JSON.stringify(task.id)} with blocked status requires blockedBy`,
				task.id,
			);
		}
		assertUnique(task.blockedBy ?? [], `Task ${JSON.stringify(task.id)} blockedBy`, task.id);
	}
}

function assertPlanBudget(value: unknown): void {
	if (JSON.stringify(value).length > DYNAMIC_TASK_LIMITS.maxPlanCharacters) {
		throw new DynamicTaskValidationError(
			"plan_too_large",
			`Dynamic Task plan exceeds ${DYNAMIC_TASK_LIMITS.maxPlanCharacters} characters`,
		);
	}
}

export function validateTasksUpdateInput(value: unknown): TasksUpdateInputV1 {
	if (!updateValidator.Check(value)) throw schemaError("tasks_update input", updateValidator, value);
	const input = structuredClone(value as UpdateSchema) as TasksUpdateInputV1;
	validateDependencies(input.tasks);
	validateBlockedState(input.tasks);
	for (const task of input.tasks) {
		assertUnique(task.matchHints ?? [], `Task ${JSON.stringify(task.id)} matchHints`, task.id);
	}
	assertPlanBudget(input);
	return input;
}

export function validateDynamicTaskPlan(value: unknown): DynamicTaskPlanV1 {
	if (!planValidator.Check(value)) throw schemaError("Dynamic Task plan", planValidator, value);
	const plan = structuredClone(value as PlanSchema) as DynamicTaskPlanV1;
	validateDependencies(plan.tasks);
	validateBlockedState(plan.tasks);
	const factIds = new Set<string>();
	let lastSequence = 0;
	for (const fact of plan.facts) {
		if (factIds.has(fact.id)) {
			throw new DynamicTaskValidationError("duplicate_fact_id", `Duplicate fact id ${JSON.stringify(fact.id)}`);
		}
		if (fact.sequence <= lastSequence || fact.sequence > plan.factSequence) {
			throw new DynamicTaskValidationError("invalid_fact_sequence", `Invalid fact sequence for ${fact.id}`);
		}
		factIds.add(fact.id);
		lastSequence = fact.sequence;
	}
	for (const task of plan.tasks) {
		assertUnique(task.matchHints, `Task ${JSON.stringify(task.id)} matchHints`, task.id);
		assertUnique(task.evidence, `Task ${JSON.stringify(task.id)} evidence`, task.id);
		for (const evidence of task.evidence) {
			if (!factIds.has(evidence)) {
				throw new DynamicTaskValidationError(
					"unknown_evidence",
					`Task ${JSON.stringify(task.id)} references unknown evidence ${JSON.stringify(evidence)}`,
					task.id,
				);
			}
		}
		if (task.status === "completed" && task.completedAt === undefined) {
			throw new DynamicTaskValidationError(
				"completed_at_required",
				`Completed Task ${JSON.stringify(task.id)} requires completedAt`,
				task.id,
			);
		}
		if (task.status !== "completed" && task.completedAt !== undefined) {
			throw new DynamicTaskValidationError(
				"completed_at_forbidden",
				`Non-completed Task ${JSON.stringify(task.id)} cannot have completedAt`,
				task.id,
			);
		}
	}
	assertPlanBudget(plan);
	return plan;
}

export function validateTaskPatch(value: unknown): TaskPatchV1 {
	if (!patchValidator.Check(value)) throw schemaError("Task patch", patchValidator, value);
	const patch = structuredClone(value as PatchSchema) as TaskPatchV1;
	const ids = patch.updates.map((update) => update.id);
	assertUnique(ids, "Task patch updates");
	for (const update of patch.updates) {
		if (
			update.status === undefined &&
			update.activity === undefined &&
			update.evidence === undefined &&
			update.blockedBy === undefined
		) {
			throw new DynamicTaskValidationError(
				"empty_patch",
				`Task patch for ${JSON.stringify(update.id)} contains no updates`,
				update.id,
			);
		}
		assertUnique(update.evidence ?? [], `Task patch ${JSON.stringify(update.id)} evidence`, update.id);
		assertUnique(update.blockedBy ?? [], `Task patch ${JSON.stringify(update.id)} blockedBy`, update.id);
	}
	return patch;
}

export function cloneDynamicTaskItem(item: DynamicTaskItemV1): DynamicTaskItemV1 {
	return structuredClone(item);
}
