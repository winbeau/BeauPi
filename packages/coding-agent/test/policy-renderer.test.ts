import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { attachPolicyToolDetails, type PolicyAction, type PolicyToolDetails } from "../src/core/policy/index.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function fakeTui(): TUI {
	return {
		terminal: { rows: 32 },
		requestRender: vi.fn(),
	} as unknown as TUI;
}

function legacyDetails(action: Exclude<PolicyAction, "allow">): PolicyToolDetails {
	const status =
		action === "block" ? "blocked" : action === "replace" ? "replaced" : action === "pause" ? "paused" : "confirmed";
	return {
		version: 1,
		requestId: `policy-${action}`,
		toolCallId: `tool-${action}`,
		decision: {
			action,
			reason: `${action} reason`,
			...(action === "replace" ? { replacementTool: "web_fetch" } : {}),
		},
		status,
		operation: {
			version: 1,
			toolName: "custom_policy",
			kind: "opaque",
			classes: ["opaque"],
			access: "unknown",
			target: "local",
			signature: `signature-${action}`,
			equivalenceSignature: `equivalence-${action}`,
			fallbackFamily: "local",
			sensitive: false,
			privileged: false,
			readOnly: false,
			workspaceMutation: false,
			summary: "Local shell command",
		},
		createdAt: "2026-07-30T00:00:00.000Z",
		completedAt: "2026-07-30T00:00:01.000Z",
		executed: false,
		targetRevisionBefore: 0,
		targetRevisionAfter: 0,
	};
}

describe("M10 Policy TUI", () => {
	beforeAll(() => initTheme("beaupi-dark", false));

	it("keeps Policy metadata out of Tool presentation so advisories remain Footer-only", () => {
		for (const action of ["block", "confirm", "replace", "pause"] as const) {
			const component = new ToolExecutionComponent(
				"custom_policy",
				`tool-${action}`,
				{ command: "opaque command" },
				{},
				undefined,
				fakeTui(),
				process.cwd(),
			);
			component.markExecutionStarted();
			component.setPolicyAction(action);
			component.updateResult(
				{
					content: [{ type: "text", text: "ordinary tool result" }],
					details: attachPolicyToolDetails(undefined, legacyDetails(action)),
					isError: false,
				},
				false,
			);

			expect(component.getDisplayState(), action).toBe("success");
			for (const width of [40, 80, 120, 160]) {
				const lines = component.render(width);
				expect(
					lines.every((line) => visibleWidth(line) <= width),
					`${action}:${width}`,
				).toBe(true);
				const rendered = stripAnsi(lines.join("\n"));
				expect(rendered).toContain("ordinary tool result");
				expect(rendered).not.toContain("Blocked:");
				expect(rendered).not.toContain("Paused:");
				expect(rendered).not.toContain("Approval required:");
				expect(rendered).not.toContain("Replacement:");
			}
		}
	});
});
