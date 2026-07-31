import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	BackgroundTaskManager,
	createBackgroundToolDefinitions,
	FakeProcessAdapter,
	getBackgroundToolDetails,
	MonitorRuntime,
} from "../src/core/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

function setup() {
	const cwd = mkdtempSync(join(tmpdir(), "beaupi-background-tools-"));
	roots.push(cwd);
	const sessionManager = SessionManager.inMemory(cwd);
	const process = new FakeProcessAdapter();
	const monitor = new MonitorRuntime({
		sessionId: sessionManager.getSessionId(),
		cwd,
		sessionManager,
		processAdapter: process,
	});
	const manager = new BackgroundTaskManager({
		sessionId: sessionManager.getSessionId(),
		cwd,
		sessionManager,
		monitorRuntime: monitor,
		polling: false,
	});
	const tools = Object.fromEntries(createBackgroundToolDefinitions(manager).map((tool) => [tool.name, tool]));
	return { cwd, sessionManager, process, monitor, manager, tools };
}

async function execute(
	tool: ReturnType<typeof createBackgroundToolDefinitions>[number],
	params: unknown,
	signal?: AbortSignal,
): Promise<AgentToolResult<Record<string, unknown>>> {
	const result = await tool.execute("call", params as never, signal, undefined, {} as ExtensionContext);
	return { ...result, details: result.details as Record<string, unknown> };
}

describe("background_* tools", () => {
	it("uses strict schemas and background_start returns before the process exits", async () => {
		const value = setup();
		await expect(
			execute(value.tools.background_start, { executable: process.execPath, unexpected: true }),
		).rejects.toThrow("invalid parameters");
		const result = await execute(value.tools.background_start, {
			executable: process.execPath,
			args: ["-e", "setTimeout(() => {}, 1000)"],
			goal: "stay alive",
		});
		const details = getBackgroundToolDetails(result.details);
		expect(details).toMatchObject({ operation: "background_start", ok: true, task: { status: "healthy" } });
		expect(details?.task?.monitor?.target.kind).toBe("process");
		await execute(value.tools.background_cancel, { taskId: details!.task!.id, graceMs: 0 });
		value.manager.dispose();
		value.monitor.dispose();
	});

	it("attaches, waits without blocking, reads cursor/hash logs, and cancels idempotently", async () => {
		const value = setup();
		const logPath = join(value.cwd, "attached.log");
		writeFileSync(logPath, "first\n");
		const monitor = value.monitor.attach({ target: { kind: "process", pid: 210, logPath }, name: "attached" });
		value.process.setSnapshot("pid:210", { availability: "confirmed", running: true, healthy: true });
		await value.monitor.poll();
		const attached = getBackgroundToolDetails(
			(await execute(value.tools.background_attach, { monitorId: monitor.id })).details,
		)!;
		const taskId = attached.task!.id;
		const waited = getBackgroundToolDetails(
			(await execute(value.tools.background_wait, { taskId, triggers: [{ type: "completed" }] })).details,
		)!;
		expect(waited.task?.waitRequestedAt).toBeTypeOf("number");
		const first = await execute(value.tools.background_logs, { taskId });
		const firstDetails = getBackgroundToolDetails(first.details)!;
		expect(firstDetails.logs?.cursor).toBeGreaterThan(0);
		expect(firstDetails.logs?.hash).toMatch(/^[a-f0-9]{64}$/);
		expect(firstDetails.logs).not.toHaveProperty("content");
		const unchanged = await execute(value.tools.background_logs, {
			taskId,
			cursor: firstDetails.logs?.cursor,
			hash: firstDetails.logs?.hash,
		});
		expect(getBackgroundToolDetails(unchanged.details)?.logs?.changed).toBe(false);
		const cancelled = getBackgroundToolDetails(
			(await execute(value.tools.background_cancel, { taskId, graceMs: 0 })).details,
		)!;
		expect(cancelled.cancel).toMatchObject({ accepted: true, reason: "cancel_requested" });
		const repeated = getBackgroundToolDetails(
			(await execute(value.tools.background_cancel, { taskId, graceMs: 0 })).details,
		)!;
		expect(repeated.cancel).toMatchObject({ accepted: false, reason: "already_terminal" });
		value.manager.dispose();
		value.monitor.dispose();
	});
});
