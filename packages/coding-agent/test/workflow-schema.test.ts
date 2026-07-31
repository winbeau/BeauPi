import { describe, expect, it } from "vitest";
import {
	BUILTIN_WORKFLOWS,
	evaluateWorkflowCondition,
	parseWorkflowDefinition,
	validateWorkflowDefinition,
	type WorkflowNodeSnapshot,
	WorkflowValidationError,
} from "../src/core/workflow/index.ts";

const profiles = new Set(["reviewer", "researcher", "implementer"]);
const profileExists = (profile: string): boolean => profiles.has(profile);

function node(id: string, status: WorkflowNodeSnapshot["status"], summary = "summary"): WorkflowNodeSnapshot {
	return {
		id,
		profile: "reviewer",
		taskSummary: id,
		dependsOn: [],
		writePolicy: "none",
		failurePolicy: "continue",
		status,
		createdAt: "2026-01-01T00:00:00.000Z",
		durationMs: 0,
		monitorId: `mon-${id}`,
		output:
			status === "completed"
				? {
						taskId: `task-${id}`,
						profile: "reviewer",
						status: "completed",
						summary,
						citations: [],
						references: [],
						filesModified: [],
						checks: [],
						diagnostics: [],
						usage: {
							inputTokens: 0,
							outputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							totalTokens: 0,
							cost: 0,
						},
						budget: { tokensUsed: 0, turnsUsed: 1, elapsedMs: 1 },
					}
				: undefined,
		diagnostics: [],
	};
}

describe("Workflow schema and conditions", () => {
	it("parses YAML/JSON and validates all built-in Workflows", () => {
		const yaml = parseWorkflowDefinition(`
version: 1
id: sample
maxConcurrency: 2
nodes:
  - id: inspect
    profile: reviewer
    task: Inspect files
    writePolicy: none
  - id: review
    agent: reviewer
    task: Review output
    dependsOn: [inspect]
    condition: deps.inspect.status == "completed"
`);
		const normalized = validateWorkflowDefinition(yaml, profileExists);
		expect(normalized.nodes.map((item) => item.profile)).toEqual(["reviewer", "reviewer"]);
		expect(normalized.nodes[0]?.writePolicy).toBe("none");

		const json = parseWorkflowDefinition(JSON.stringify(yaml));
		expect(validateWorkflowDefinition(json, profileExists).id).toBe("sample");
		for (const definition of Object.values(BUILTIN_WORKFLOWS)) {
			expect(() => validateWorkflowDefinition(definition, profileExists)).not.toThrow();
		}
	});

	it("rejects duplicate ids, unknown dependencies, cycles, profiles, conditions, budgets, and extra fields", () => {
		const base = {
			version: 1 as const,
			id: "invalid",
			nodes: [{ id: "a", profile: "reviewer", task: "A" }],
		};
		const cases: Array<[string, unknown, string]> = [
			["duplicate", { ...base, nodes: [...base.nodes, ...base.nodes] }, "duplicate_node_id"],
			[
				"unknown dependency",
				{ ...base, nodes: [{ ...base.nodes[0], dependsOn: ["missing"] }] },
				"unknown_dependency",
			],
			[
				"cycle",
				{
					...base,
					nodes: [
						{ id: "a", profile: "reviewer", task: "A", dependsOn: ["b"] },
						{ id: "b", profile: "reviewer", task: "B", dependsOn: ["a"] },
					],
				},
				"dependency_cycle",
			],
			["profile", { ...base, nodes: [{ ...base.nodes[0], profile: "missing" }] }, "profile_not_found"],
			[
				"condition",
				{ ...base, nodes: [{ ...base.nodes[0], condition: 'deps.missing.status == "completed"' }] },
				"invalid_condition",
			],
			[
				"condition status",
				{
					...base,
					nodes: [
						{ id: "a", profile: "reviewer", task: "A" },
						{
							id: "b",
							profile: "reviewer",
							task: "B",
							dependsOn: ["a"],
							condition: 'deps.a.status == "unknown"',
						},
					],
				},
				"invalid_condition",
			],
			["budget", { ...base, nodes: [{ ...base.nodes[0], budget: { maxTurns: 0 } }] }, "invalid_schema"],
			["extra", { ...base, unexpected: true }, "invalid_schema"],
		];
		for (const [label, value, code] of cases) {
			try {
				validateWorkflowDefinition(value as never, profileExists);
				throw new Error(`${label} unexpectedly passed`);
			} catch (error) {
				expect(error).toBeInstanceOf(WorkflowValidationError);
				expect((error as WorkflowValidationError).code).toBe(code);
			}
		}
	});

	it("evaluates bounded deterministic dependency conditions against structured outputs", () => {
		const completed = node("inspect", "completed", "ready");
		const failed = node("test", "failed");
		expect(evaluateWorkflowCondition("all_succeeded", [completed])).toBe(true);
		expect(evaluateWorkflowCondition("any_failed", [completed, failed])).toBe(true);
		expect(evaluateWorkflowCondition('deps.inspect.output.summary == "ready"', [completed])).toBe(true);
		expect(
			evaluateWorkflowCondition('deps.inspect.status == "completed" && deps.inspect.output.summary != "blocked"', [
				completed,
			]),
		).toBe(true);
	});
});
