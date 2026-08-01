import { describe, expect, it } from "vitest";
import {
	DynamicTaskValidationError,
	validateDynamicTaskPlan,
	validateTaskPatch,
	validateTasksUpdateInput,
} from "../src/core/tasks/schema.ts";
import type { DynamicTaskPlanV1, TasksUpdateInputV1 } from "../src/core/tasks/types.ts";

function input(overrides: Partial<TasksUpdateInputV1> = {}): TasksUpdateInputV1 {
	return {
		version: 1,
		expectedRevision: 0,
		reason: "initial_plan",
		goal: "Implement dynamic tasks",
		tasks: [
			{ id: "contract", title: "Define contract", status: "pending", matchHints: ["schema"] },
			{
				id: "runtime",
				title: "Implement runtime",
				status: "pending",
				dependsOn: ["contract"],
				matchHints: ["runtime.ts"],
			},
		],
		...overrides,
	};
}

function plan(): DynamicTaskPlanV1 {
	return {
		version: 1,
		planId: "plan-1",
		revision: 1,
		goal: "Implement dynamic tasks",
		createdAt: 1,
		updatedAt: 1,
		factSequence: 1,
		tasks: [
			{
				id: "contract",
				title: "Define contract",
				status: "active",
				dependsOn: [],
				matchHints: ["schema"],
				activity: "Writing schema",
				evidence: ["fact-1"],
				blockedBy: [],
				createdAt: 1,
				updatedAt: 1,
			},
		],
		facts: [
			{
				version: 1,
				sequence: 1,
				id: "fact-1",
				kind: "file",
				ref: "src/core/tasks/schema.ts",
				status: "succeeded",
				summary: "Modified schema.ts",
				path: "src/core/tasks/schema.ts",
				createdAt: 1,
			},
		],
	};
}

describe("Dynamic Task schema", () => {
	it("accepts strict valid update, plan, and reviewer patch values", () => {
		expect(validateTasksUpdateInput(input())).toMatchObject({ reason: "initial_plan" });
		expect(validateDynamicTaskPlan(plan())).toMatchObject({ revision: 1, factSequence: 1 });
		expect(
			validateTaskPatch({
				version: 1,
				expectedRevision: 1,
				factsHash: "a".repeat(64),
				updates: [{ id: "contract", status: "completed", evidence: ["fact-1"] }],
			}),
		).toMatchObject({ expectedRevision: 1 });
	});

	it("keeps concise titles as a soft style target rather than a hard 15-character limit", () => {
		const longTitle = "Review the privilege runtime and terminal safety boundaries";
		expect(
			validateTasksUpdateInput({
				...input(),
				tasks: [{ id: "review", title: longTitle, status: "pending" }],
			}),
		).toMatchObject({ tasks: [{ title: longTitle }] });
	});

	it("rejects extra fields and invalid statuses", () => {
		expect(() => validateTasksUpdateInput({ ...input(), extra: true })).toThrow(DynamicTaskValidationError);
		expect(() =>
			validateTasksUpdateInput({
				...input(),
				tasks: [{ id: "one", title: "One", status: "unknown" }],
			}),
		).toThrow(DynamicTaskValidationError);
		expect(() =>
			validateTaskPatch({
				version: 1,
				expectedRevision: 1,
				factsHash: "b".repeat(64),
				updates: [{ id: "contract", status: "completed", title: "rename" }],
			}),
		).toThrow(DynamicTaskValidationError);
	});

	it("rejects duplicate ids, unknown dependencies, self dependencies, and cycles", () => {
		expect(() =>
			validateTasksUpdateInput({
				...input(),
				tasks: [
					{ id: "same", title: "One", status: "pending" },
					{ id: "same", title: "Two", status: "pending" },
				],
			}),
		).toThrow(/duplicate/i);
		expect(() =>
			validateTasksUpdateInput({
				...input(),
				tasks: [{ id: "one", title: "One", status: "pending", dependsOn: ["missing"] }],
			}),
		).toThrow(/unknown/i);
		expect(() =>
			validateTasksUpdateInput({
				...input(),
				tasks: [{ id: "one", title: "One", status: "pending", dependsOn: ["one"] }],
			}),
		).toThrow(/itself/i);
		expect(() =>
			validateTasksUpdateInput({
				...input(),
				tasks: [
					{ id: "one", title: "One", status: "pending", dependsOn: ["two"] },
					{ id: "two", title: "Two", status: "pending", dependsOn: ["one"] },
				],
			}),
		).toThrow(/cycle/i);
	});

	it("rejects oversized plans and invalid evidence references", () => {
		expect(() =>
			validateTasksUpdateInput({
				...input(),
				tasks: Array.from({ length: 17 }, (_, index) => ({
					id: `task-${index}`,
					title: `Task ${index}`,
					status: "pending" as const,
				})),
			}),
		).toThrow(DynamicTaskValidationError);
		const invalidPlan = plan();
		invalidPlan.tasks[0]!.evidence = ["missing-fact"];
		expect(() => validateDynamicTaskPlan(invalidPlan)).toThrow(/evidence/i);
	});

	it("rejects completedAt on non-completed restored Tasks", () => {
		const invalidPlan = plan();
		invalidPlan.tasks[0]!.completedAt = 2;
		expect(() => validateDynamicTaskPlan(invalidPlan)).toThrow(/cannot have completedAt/i);
	});

	it("requires blockers only for blocked tasks and unique patch ids", () => {
		expect(() =>
			validateTasksUpdateInput({
				...input(),
				tasks: [{ id: "one", title: "One", status: "blocked" }],
			}),
		).toThrow(/blockedBy/i);
		expect(() =>
			validateTaskPatch({
				version: 1,
				expectedRevision: 1,
				factsHash: "c".repeat(64),
				updates: [
					{ id: "one", activity: "a" },
					{ id: "one", activity: "b" },
				],
			}),
		).toThrow(/duplicate/i);
	});
});
