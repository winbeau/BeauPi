import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	createMonitorToolDefinitions,
	FakeProcessAdapter,
	MonitorRuntime,
	type MonitorToolDetails,
} from "../src/core/monitor/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const cleanupPaths: string[] = [];
afterEach(() => {
	for (const path of cleanupPaths.splice(0)) {
		if (existsSync(path)) rmSync(path, { recursive: true, force: true });
	}
});

function createSetup() {
	const cwd = join(tmpdir(), `beaupi-monitor-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(cwd, { recursive: true });
	cleanupPaths.push(cwd);
	const sessionManager = SessionManager.inMemory(cwd);
	const adapter = new FakeProcessAdapter();
	const runtime = new MonitorRuntime({
		sessionId: sessionManager.getSessionId(),
		cwd,
		sessionManager,
		processAdapter: adapter,
		now: () => 1_000,
	});
	const definitions = Object.fromEntries(
		createMonitorToolDefinitions(runtime).map((definition) => [definition.name, definition]),
	);
	return { cwd, sessionManager, adapter, runtime, definitions };
}

async function executeTool(
	definition: ReturnType<typeof createMonitorToolDefinitions>[number],
	params: unknown,
): Promise<AgentToolResult<MonitorToolDetails>> {
	const result = await definition.execute("tool-call", params as never, undefined, undefined, {} as ExtensionContext);
	return { ...result, details: result.details as MonitorToolDetails };
}

function textFrom(result: AgentToolResult<MonitorToolDetails>): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

describe("monitor_* tools", () => {
	it("validates parameters and returns structured attach/list/status/stop results", async () => {
		const setup = createSetup();
		const attach = await executeTool(setup.definitions.monitor_attach, {
			kind: "process",
			pid: 42,
			name: "build",
		});
		expect(attach.details.ok).toBe(true);
		expect(attach.details.monitor?.id).toMatch(/^mon-/);
		expect(attach.details.monitor?.status).toBe("starting");
		const monitorId = attach.details.monitor?.id;
		expect(monitorId).toBeDefined();

		const list = await executeTool(setup.definitions.monitor_list, { includeTerminal: true });
		expect(list.details.monitors).toHaveLength(1);
		expect(list.details.summary?.starting).toBe(1);
		const status = await executeTool(setup.definitions.monitor_status, { monitorId });
		expect(status.details.monitor?.name).toBe("build");

		const stopped = await executeTool(setup.definitions.monitor_stop, { monitorId });
		expect(stopped.details.ok).toBe(true);
		expect(stopped.details.monitor?.status).toBe("cancelled");

		await expect(executeTool(setup.definitions.monitor_attach, { kind: "process" })).rejects.toThrow(
			/process targets require pid/,
		);
	});

	it("marks Tool targets as explicit attachments", async () => {
		const setup = createSetup();
		const result = await executeTool(setup.definitions.monitor_attach, {
			kind: "tool",
			toolCallId: "edit-call",
		});
		expect(result.details.monitor?.target).toMatchObject({
			kind: "tool",
			toolCallId: "edit-call",
			attachment: "explicit",
		});
	});

	it("returns cursor/hash incremental logs and does not repeat unchanged output", async () => {
		const setup = createSetup();
		const logPath = join(setup.cwd, "task.log");
		writeFileSync(logPath, "first\n");
		const attach = await executeTool(setup.definitions.monitor_attach, {
			kind: "process",
			pid: 43,
			logPath,
		});
		const monitorId = attach.details.monitor?.id;
		const first = await executeTool(setup.definitions.monitor_logs, { monitorId });
		expect(textFrom(first)).toBe("first\n");
		expect(first.details.logs?.changed).toBe(true);
		const unchanged = await executeTool(setup.definitions.monitor_logs, { monitorId });
		expect(textFrom(unchanged)).toBe("No new log output.");
		expect(unchanged.details.logs?.changed).toBe(false);
		const full = await executeTool(setup.definitions.monitor_logs, { monitorId, mode: "full" });
		expect(textFrom(full)).toBe("first\n");
		expect(full.details.logs?.logPath).toBe(logPath);
	});

	it("reports wait timeout as structured data without invoking a model", async () => {
		const setup = createSetup();
		const attach = await executeTool(setup.definitions.monitor_attach, { kind: "process", pid: 44 });
		const monitorId = attach.details.monitor?.id;
		const result = await executeTool(setup.definitions.monitor_wait, { monitorId, timeoutMs: 1 });
		expect(result.details.ok).toBe(false);
		expect(result.details.error?.code).toBe("wait_timeout");
		expect(result.details.monitor?.status).toBe("starting");
	});
});
