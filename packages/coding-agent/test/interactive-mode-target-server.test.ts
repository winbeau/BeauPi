import { describe, expect, it, vi } from "vitest";
import type { ExecutionTargetConfig } from "../src/core/remote/types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type TargetServerContext = {
	session: {
		isStreaming: boolean;
		isCompacting: boolean;
		remoteRuntime: {
			listTargets: () => ExecutionTargetConfig[];
			persistTarget: (target: ExecutionTargetConfig) => void;
			selectTarget: (targetId: string) => ExecutionTargetConfig;
		};
	};
	settingsManager: {
		isProjectTrusted: () => boolean;
		flush: () => Promise<void>;
	};
	showExtensionSelector: (title: string, options: string[]) => Promise<string | undefined>;
	showExtensionInput: (title: string) => Promise<string | undefined>;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
	showStatus: (message: string) => void;
	footer: { invalidate: () => void };
};

type TargetServerPrototype = {
	handleTargetServerCommand(this: TargetServerContext, targetIdArg?: string): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as TargetServerPrototype;

describe("InteractiveMode /target-server", () => {
	it("persists and selects a new target from the interactive fields", async () => {
		const inputs = ["", "/workspace", "", ""];
		const persistTarget = vi.fn();
		const selectTarget = vi.fn((targetId: string) => ({
			id: targetId,
			scope: "user" as const,
			sshAlias: targetId,
		}));
		const showExtensionInput = vi.fn(async () => inputs.shift());
		const showExtensionSelector = vi.fn(async () => "User settings (available in all projects)");
		const showStatus = vi.fn();
		const showError = vi.fn();
		const flush = vi.fn(async () => {});
		const context: TargetServerContext = {
			session: {
				isStreaming: false,
				isCompacting: false,
				remoteRuntime: {
					listTargets: () => [],
					persistTarget,
					selectTarget,
				},
			},
			settingsManager: { isProjectTrusted: () => true, flush },
			showExtensionSelector,
			showExtensionInput,
			showWarning: vi.fn(),
			showError,
			showStatus,
			footer: { invalidate: vi.fn() },
		};

		await interactiveModePrototype.handleTargetServerCommand.call(context, "h100-server");

		expect(persistTarget).toHaveBeenCalledWith({
			version: 1,
			id: "h100-server",
			scope: "user",
			sshAlias: "h100-server",
			remoteCwd: "/workspace",
		});
		expect(flush).toHaveBeenCalledOnce();
		expect(selectTarget).toHaveBeenCalledWith("h100-server");
		expect(showStatus).toHaveBeenCalledWith(
			"Saved and selected SSH target h100-server (h100-server) in user settings.",
		);
		expect(showError).not.toHaveBeenCalled();
		expect(showExtensionSelector).toHaveBeenCalledWith("Save execution target in", [
			"User settings (available in all projects)",
			"Project settings (current trusted project)",
		]);
	});

	it("rejects an invalid port before changing settings", async () => {
		const inputs = ["", "", "", "not-a-port"];
		const persistTarget = vi.fn();
		const showError = vi.fn();
		const context: TargetServerContext = {
			session: {
				isStreaming: false,
				isCompacting: false,
				remoteRuntime: {
					listTargets: () => [],
					persistTarget,
					selectTarget: vi.fn(),
				},
			},
			settingsManager: { isProjectTrusted: () => true, flush: vi.fn(async () => {}) },
			showExtensionSelector: vi.fn(async () => "User settings (available in all projects)"),
			showExtensionInput: vi.fn(async () => inputs.shift()),
			showWarning: vi.fn(),
			showError,
			showStatus: vi.fn(),
			footer: { invalidate: vi.fn() },
		};

		await interactiveModePrototype.handleTargetServerCommand.call(context, "h100-server");

		expect(persistTarget).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith("SSH port must be an integer between 1 and 65535.");
	});
});
