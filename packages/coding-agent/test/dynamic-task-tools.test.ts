import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { DynamicTaskRuntime } from "../src/core/tasks/dynamic-task-runtime.ts";
import { createTasksUpdateToolDefinition, getDynamicTaskToolDetails } from "../src/core/tasks/tools.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function plan(expectedRevision: number, reason: "initial_plan" | "work_started" | "plan_changed" | "blocked") {
	return {
		version: 1 as const,
		expectedRevision,
		reason,
		goal: "Implement M14",
		tasks: [
			{
				id: "runtime",
				title: `Implement runtime (${reason})`,
				status:
					reason === "initial_plan"
						? ("pending" as const)
						: reason === "blocked"
							? ("blocked" as const)
							: ("active" as const),
				activity: `Reason: ${reason}`,
				...(reason === "blocked" ? { blockedBy: ["schema decision"] } : {}),
			},
		],
	};
}

describe("tasks_update Tool", () => {
	it("publishes strict registry metadata and returns versioned snapshots for all reasons", async () => {
		const runtime = new DynamicTaskRuntime({ sessionManager: SessionManager.inMemory("/repo"), now: () => 10 });
		const tool = createTasksUpdateToolDefinition(runtime);
		expect(tool.name).toBe("tasks_update");
		expect(tool.executionMode).toBe("sequential");
		expect(tool.promptSnippet).toContain("structured task plan");
		expect(tool.promptGuidelines?.join("\n")).toContain("3-7");
		expect(tool.promptGuidelines?.join("\n")).toContain("15 Chinese characters");
		expect(tool.promptGuidelines?.join("\n")).toContain("domain nouns");
		expect(tool.promptGuidelines?.join("\n")).toContain("PrivilegeRuntime");
		expect(tool.promptGuidelines?.join("\n")).toContain("soft style target");
		expect(tool.promptGuidelines?.join("\n")).toContain("structure");
		expect(tool.promptGuidelines?.join("\n")).toContain("safely rebases");

		for (const reason of ["initial_plan", "work_started", "plan_changed", "blocked"] as const) {
			const expectedRevision = runtime.getSnapshot()?.revision ?? 0;
			const result = await tool.execute(
				`call-${reason}`,
				plan(expectedRevision, reason),
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			const details = getDynamicTaskToolDetails(result.details);
			expect(details).toMatchObject({ version: 1, operation: "tasks_update", reason, ok: true });
			expect(details?.result.snapshot?.revision).toBe(expectedRevision + 1);
		}
	});

	it("returns structured invalid and revision-conflict results without overwriting state", async () => {
		const runtime = new DynamicTaskRuntime({ sessionManager: SessionManager.inMemory("/repo") });
		const tool = createTasksUpdateToolDefinition(runtime);
		await tool.execute("create", plan(0, "initial_plan"), undefined, undefined, {} as ExtensionContext);
		const conflict = await tool.execute(
			"conflict",
			plan(0, "plan_changed"),
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(getDynamicTaskToolDetails(conflict.details)).toMatchObject({
			ok: false,
			result: { status: "revision_conflict", actualRevision: 1 },
		});
		const invalid = await tool.execute(
			"invalid",
			{ ...plan(1, "plan_changed"), extra: true } as never,
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(getDynamicTaskToolDetails(invalid.details)).toMatchObject({ ok: false, result: { status: "invalid" } });
		expect(runtime.getSnapshot()?.revision).toBe(1);
	});

	it("renders only structured details and remains width-safe", async () => {
		initTheme("beaupi-dark", false);
		const runtime = new DynamicTaskRuntime({ sessionManager: SessionManager.inMemory("/repo") });
		const tool = createTasksUpdateToolDefinition(runtime);
		const result = await tool.execute(
			"create",
			plan(0, "initial_plan"),
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const call = tool.renderCall?.(plan(0, "initial_plan"), theme, {
			executionStarted: true,
			isPartial: false,
			args: plan(0, "initial_plan"),
		} as never);
		const renderedResult = tool.renderResult?.(result, { expanded: false, isPartial: false }, theme, {
			toolCallId: "create",
			toolName: "tasks_update",
			args: plan(0, "initial_plan"),
		} as never);
		await runtime.recordFact({
			id: "monitor:task:running",
			kind: "monitor",
			ref: "task",
			status: "running",
			summary: "Monitor running",
			taskId: "runtime",
		});
		const rebasedResult = await tool.execute(
			"rebased",
			plan(1, "work_started"),
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const renderedRebase = tool.renderResult?.(rebasedResult, { expanded: false, isPartial: false }, theme, {
			toolCallId: "rebased",
			toolName: "tasks_update",
			args: plan(1, "work_started"),
		} as never);
		expect(renderedRebase?.render(80).join("\n")).toContain("revision 3 · rebased from r1");
		for (const component of [call, renderedResult, renderedRebase]) {
			expect(component).toBeDefined();
			for (const line of component!.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}
	});
});
