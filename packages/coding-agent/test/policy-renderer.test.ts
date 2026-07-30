import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	attachPolicyToolDetails,
	type PolicyAction,
	type PolicyConfirmRequest,
	type PolicyToolDetails,
} from "../src/core/policy/index.ts";
import { PolicyConfirmSelectorComponent } from "../src/modes/interactive/components/policy-confirm-selector.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function fakeTui(): TUI {
	return {
		terminal: { rows: 32 },
		requestRender: vi.fn(),
	} as unknown as TUI;
}

function details(action: Exclude<PolicyAction, "allow" | "confirm">): PolicyToolDetails {
	const status = action === "block" ? "blocked" : action === "replace" ? "replaced" : "paused";
	return {
		version: 1,
		requestId: `policy-${action}`,
		toolCallId: `tool-${action}`,
		decision: {
			action,
			reason: `${action} reason with 终端 detail`,
			...(action === "replace" ? { replacementTool: "web_fetch" } : {}),
			suggestion: `${action} suggestion`,
		},
		status,
		operation: {
			version: 1,
			toolName: "bash",
			kind: action === "replace" ? "dedicated_tool_fallback" : "opaque",
			classes: [action === "replace" ? "dedicated_tool_fallback" : "opaque"],
			access: "unknown",
			target: "local",
			signature: `signature-${action}`,
			equivalenceSignature: `equivalence-${action}`,
			fallbackFamily: "local",
			dedicatedTool: action === "replace" ? "web_fetch" : undefined,
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

function request(): PolicyConfirmRequest {
	return {
		version: 1,
		requestId: "policy-confirm",
		toolCallId: "tool-confirm",
		toolName: "write",
		operation: {
			version: 1,
			toolName: "write",
			kind: "sensitive_path",
			classes: ["workspace_write", "sensitive_path"],
			access: "write",
			target: "local",
			signature: "signature-confirm",
			equivalenceSignature: "equivalence-confirm",
			fallbackFamily: "local",
			sensitive: true,
			privileged: false,
			readOnly: false,
			workspaceMutation: true,
			summary: "Sensitive workspace modification",
		},
		reason: "This path may contain credentials and requires explicit authorization.",
		suggestion: "Allow only this stable request.",
		createdAt: "2026-07-30T00:00:00.000Z",
	};
}

describe("M10 Policy TUI", () => {
	beforeAll(() => initTheme("beaupi-dark", false));

	it("renders block, replace, pause, and pending confirm in the existing minimal Tool shell", () => {
		for (const themeName of ["beaupi-dark", "beaupi-light"] as const) {
			initTheme(themeName, false);
			for (const action of ["block", "replace", "pause"] as const) {
				const component = new ToolExecutionComponent(
					"bash",
					`tool-${action}`,
					{ command: "opaque command" },
					{},
					undefined,
					fakeTui(),
					process.cwd(),
				);
				component.markExecutionStarted();
				component.updateResult(
					{
						content: [{ type: "text", text: "Policy result" }],
						details: attachPolicyToolDetails(undefined, details(action)),
						isError: true,
					},
					false,
				);
				for (const width of [40, 80, 120, 160]) {
					const lines = component.render(width);
					expect(
						lines.every((line) => visibleWidth(line) <= width),
						`${themeName}:${action}:${width}`,
					).toBe(true);
					const rendered = stripAnsi(lines.join("\n"));
					expect(rendered).toContain(`${action} reason`);
					expect(rendered).toContain(`${action} suggestion`);
					if (action === "replace") expect(rendered).toContain("Replacement: web_fetch");
				}
				expect(component.getDisplayState()).toBe(
					action === "block" ? "blocked" : action === "pause" ? "paused" : "replace",
				);
			}
		}

		const pending = new ToolExecutionComponent(
			"write",
			"tool-confirm",
			{ path: ".env", content: "hidden" },
			{},
			undefined,
			fakeTui(),
			process.cwd(),
		);
		pending.markExecutionStarted();
		pending.setPolicyAction("confirm");
		expect(pending.getDisplayState()).toBe("confirm");
		expect(stripAnsi(pending.render(80).join("\n"))).toMatch(/^\n?! Write/m);
	});

	it("answers allow once, reject, and cancel through the focused Policy selector without overflow", () => {
		for (const themeName of ["beaupi-dark", "beaupi-light"] as const) {
			initTheme(themeName, false);
			const allow = vi.fn();
			const reject = vi.fn();
			const cancel = vi.fn();
			const selector = new PolicyConfirmSelectorComponent({
				tui: fakeTui(),
				keybindings: new KeybindingsManager(),
				request: request(),
				onAllowOnce: allow,
				onReject: reject,
				onCancel: cancel,
			});
			for (const width of [40, 80, 120, 160]) {
				const lines = selector.render(width);
				expect(
					lines.every((line) => visibleWidth(line) <= width),
					`${themeName}:${width}`,
				).toBe(true);
				expect(stripAnsi(lines.join("\n"))).toContain("Allow once");
			}
			selector.handleInput("\r");
			expect(allow).toHaveBeenCalledOnce();

			const rejected = new PolicyConfirmSelectorComponent({
				tui: fakeTui(),
				keybindings: new KeybindingsManager(),
				request: request(),
				onAllowOnce: allow,
				onReject: reject,
				onCancel: cancel,
			});
			rejected.handleInput("\x1b[B");
			rejected.handleInput("\r");
			expect(reject).toHaveBeenCalledOnce();

			const cancelled = new PolicyConfirmSelectorComponent({
				tui: fakeTui(),
				keybindings: new KeybindingsManager(),
				request: request(),
				onAllowOnce: allow,
				onReject: reject,
				onCancel: cancel,
			});
			cancelled.handleInput("\x1b");
			expect(cancel).toHaveBeenCalledOnce();
		}
	});
});
