import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { MonitorRuntime } from "../src/core/monitor/index.ts";
import {
	createRemoteToolDefinitions,
	ExecutionTargetRegistry,
	OpenSshTmuxAdapter,
	RemoteExecutionRuntime,
	type RemoteToolDetails,
} from "../src/core/remote/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const realE2e = process.env.BEAUPI_M7_REAL_E2E === "1";

async function executeTool(definition: ToolDefinition, params: unknown, signal?: AbortSignal) {
	const result = await definition.execute("m7-real", params as never, signal, undefined, {} as ExtensionContext);
	return { ...result, details: result.details as RemoteToolDetails };
}

function textFrom(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((item) => (item.type === "text" ? (item.text ?? "") : "")).join("");
}

describe.skipIf(!realE2e)("M7 real h100-server E2E", () => {
	it("executes remote commands and a controlled tmux lifecycle through OpenSSH", async () => {
		const cwd = join(tmpdir(), `beaupi-m7-real-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(cwd);
		const settingsManager = SettingsManager.inMemory();
		const targets = new ExecutionTargetRegistry({
			settingsManager,
			sessionTargets: [{ id: "h100-server", scope: "session", sshAlias: "h100-server", remoteCwd: "/tmp" }],
		});
		const adapter = new OpenSshTmuxAdapter({ targets });
		const monitor = new MonitorRuntime({
			sessionId: sessionManager.getSessionId(),
			cwd,
			sessionManager,
			adapters: { "ssh-tmux": adapter },
			stallTimeoutMs: 30_000,
		});
		const runtime = new RemoteExecutionRuntime({
			cwd,
			sessionId: sessionManager.getSessionId(),
			sessionManager,
			settingsManager,
			monitorRuntime: monitor,
			targets,
			adapter,
		});
		const definitions = Object.fromEntries(
			createRemoteToolDefinitions(runtime).map((definition) => [definition.name, definition]),
		);
		const selected = await executeTool(definitions.target_select, { targetId: "h100-server" });
		expect(selected.details).toMatchObject({
			operation: "target_select",
			ok: true,
			target: { id: "h100-server", sshAlias: "h100-server" },
		});
		let terminalId: string | undefined;
		try {
			const hostname = await executeTool(definitions.remote_exec, { command: "hostname" });
			expect(hostname.details).toMatchObject({
				operation: "remote_exec",
				ok: true,
				exitCode: 0,
				monitorId: expect.stringMatching(/^mon-/),
			});
			expect(hostname.details.stdout?.trim()).toBe("zhengchen-ubuntu-8xh100-05");

			const failed = await executeTool(definitions.remote_exec, { command: "sh -c 'exit 7'" });
			expect(failed.details).toMatchObject({
				operation: "remote_exec",
				ok: false,
				exitCode: 7,
				diagnostic: { code: "remote_command" },
			});

			const timedOut = await executeTool(definitions.remote_exec, { command: "sleep 3", timeout: 0.25 });
			expect(timedOut.details.diagnostic?.code).toBe("remote_timeout");
			const controller = new AbortController();
			const cancelledPromise = executeTool(definitions.remote_exec, { command: "sleep 10" }, controller.signal);
			setTimeout(() => controller.abort(), 100);
			const cancelled = await cancelledPromise;
			expect(cancelled.details.diagnostic?.code).toBe("remote_cancelled");

			const terminalResult = await executeTool(definitions.terminal_create, {
				terminalId: `beaupi-m7-${process.pid}`,
				command: "bash",
			});
			expect(terminalResult.details.ok).toBe(true);
			terminalId = terminalResult.details.terminalId;
			expect(terminalId).toBeDefined();
			const first = await executeTool(definitions.terminal_capture, { terminalId });
			expect(first.details.cursor).toBeGreaterThanOrEqual(0);
			await executeTool(definitions.terminal_send, { terminalId, input: "printf m7-terminal-output\\n" });
			const captured = await executeTool(definitions.terminal_capture, { terminalId });
			expect(textFrom(captured)).toContain("m7-terminal-output");
			const unchanged = await executeTool(definitions.terminal_capture, { terminalId });
			expect(textFrom(unchanged)).toBe("No new terminal output.");
			expect(unchanged.details.changed).toBe(false);
			expect(captured.details.logPath).toBeDefined();
			expect(existsSync(captured.details.logPath ?? "")).toBe(true);
			expect(readFileSync(captured.details.logPath ?? "", "utf8")).toContain("m7-terminal-output");
			const beforeReconnect = await executeTool(definitions.terminal_status, { terminalId });
			expect(beforeReconnect.details.status).toBe("healthy");
			await runtime.close();
			const afterReconnect = await executeTool(definitions.terminal_status, { terminalId });
			expect(afterReconnect.details).toMatchObject({ exists: true, status: "healthy" });
			const closed = await executeTool(definitions.terminal_close, { terminalId });
			expect(closed.details.status).toBe("completed");
			expect(monitor.status(closed.details.monitorId ?? "").status).toBe("completed");
		} finally {
			if (terminalId) {
				try {
					await runtime.terminalClose(terminalId);
				} catch {
					// Cleanup diagnostics are not used as the E2E conclusion.
				}
			}
			await runtime.dispose();
			monitor.dispose();
			if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
		}
	}, 120_000);
});
