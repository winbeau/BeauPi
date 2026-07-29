import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AgentLifecycleEvent, AgentPool } from "../src/core/agents/agent-pool.ts";
import { FakeProcessAdapter, FakeSubAgentAdapter, FakeToolAdapter, MonitorRuntime } from "../src/core/monitor/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness } from "./test-harness.ts";

class Clock {
	value = 1_000;

	now = (): number => this.value;

	advance(milliseconds: number): void {
		this.value += milliseconds;
	}
}

function createWorkspace(): string {
	const path = join(tmpdir(), `beaupi-monitor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(path, { recursive: true });
	return path;
}

function createRuntime(options: { clock?: Clock; adapter?: FakeProcessAdapter; sessionManager?: SessionManager } = {}) {
	const clock = options.clock ?? new Clock();
	const cwd = options.sessionManager?.getCwd() ?? createWorkspace();
	const sessionManager = options.sessionManager ?? SessionManager.inMemory(cwd);
	const adapter = options.adapter ?? new FakeProcessAdapter();
	const runtime = new MonitorRuntime({
		sessionId: sessionManager.getSessionId(),
		cwd,
		sessionManager,
		now: clock.now,
		processAdapter: adapter,
		stallTimeoutMs: 100,
	});
	return { clock, cwd, sessionManager, adapter, runtime };
}

const cleanupPaths: string[] = [];
afterEach(() => {
	for (const path of cleanupPaths.splice(0)) {
		if (existsSync(path)) rmSync(path, { recursive: true, force: true });
	}
});

describe("MonitorRuntime", () => {
	it("uses a stable id and transitions starting → running → healthy → completed", async () => {
		const first = createRuntime();
		cleanupPaths.push(first.cwd);
		first.adapter.setSnapshot("pid:42", {
			availability: "confirmed",
			running: true,
			healthy: false,
			lastActivityAt: first.clock.now(),
			resources: { memoryBytes: 12_345, availableMemoryBytes: 99_000 },
		});
		const events: string[] = [];
		first.runtime.subscribe((event) => {
			events.push(`${event.status}:${event.reason}`);
		});

		const attached = first.runtime.attach({
			target: { kind: "process", pid: 42 },
			name: "build",
			taskSummary: "Build the project",
		});
		const attachedAgain = first.runtime.attach({
			target: { kind: "process", pid: 42 },
			name: "ignored duplicate",
		});
		expect(attached.id).toBe(attachedAgain.id);
		expect(attached.status).toBe("starting");

		await first.runtime.poll();
		expect(first.runtime.status(attached.id).status).toBe("running");
		first.clock.advance(10);
		first.adapter.setSnapshot("pid:42", {
			availability: "confirmed",
			running: true,
			healthy: true,
			lastActivityAt: first.clock.now(),
		});
		await first.runtime.poll();
		expect(first.runtime.status(attached.id).status).toBe("healthy");
		first.clock.advance(10);
		first.adapter.setSnapshot("pid:42", {
			availability: "confirmed",
			running: false,
			exitCode: 0,
			exitReason: "exit_0",
		});
		await first.runtime.poll();
		const completed = first.runtime.status(attached.id);
		expect(completed.status).toBe("completed");
		expect(completed.exitCode).toBe(0);
		expect(completed.durationMs).toBe(20);
		expect(completed.resources).toEqual({ memoryBytes: 12_345, availableMemoryBytes: 99_000 });
		await first.runtime.flushEvents();
		expect(events).toEqual(["starting:attached", "running:started", "healthy:healthy", "completed:completed"]);
		await first.runtime.poll();
		expect(events).toHaveLength(4);
	});

	it("covers failed, cancelled, stalled, lost, and timeout outcomes", async () => {
		const failed = createRuntime();
		cleanupPaths.push(failed.cwd);
		const failedRecord = failed.runtime.attach({ target: { kind: "process", pid: 1 } });
		failed.adapter.setSnapshot("pid:1", { availability: "confirmed", running: false, exitCode: 2 });
		await failed.runtime.poll();
		expect(failed.runtime.status(failedRecord.id)).toMatchObject({ status: "failed", exitCode: 2 });

		const cancelled = createRuntime();
		cleanupPaths.push(cancelled.cwd);
		const cancelledRecord = cancelled.runtime.attach({ target: { kind: "process", pid: 2 } });
		const stop = await cancelled.runtime.stop(cancelledRecord.id);
		expect(stop.result.accepted).toBe(true);
		expect(stop.record.status).toBe("cancelled");

		const stalled = createRuntime();
		cleanupPaths.push(stalled.cwd);
		const stalledRecord = stalled.runtime.attach({ target: { kind: "process", pid: 3 }, stallTimeoutMs: 100 });
		stalled.adapter.setSnapshot("pid:3", {
			availability: "confirmed",
			running: true,
			healthy: true,
			lastActivityAt: 1_000,
		});
		await stalled.runtime.poll();
		stalled.clock.advance(101);
		await stalled.runtime.poll();
		expect(stalled.runtime.status(stalledRecord.id).status).toBe("stalled");
		stalled.adapter.setSnapshot("pid:3", {
			availability: "confirmed",
			running: true,
			healthy: true,
			lastActivityAt: stalled.clock.now(),
		});
		await stalled.runtime.poll();
		expect(stalled.runtime.status(stalledRecord.id).status).toBe("healthy");

		const lost = createRuntime();
		cleanupPaths.push(lost.cwd);
		const lostRecord = lost.runtime.attach({ target: { kind: "process", pid: 4 } });
		lost.adapter.setSnapshot("pid:4", { availability: "missing", exitReason: "no_such_process" });
		await lost.runtime.poll();
		expect(lost.runtime.status(lostRecord.id)).toMatchObject({ status: "lost", exitReason: "no_such_process" });

		const timeout = createRuntime();
		cleanupPaths.push(timeout.cwd);
		const timeoutRecord = timeout.runtime.attach({ target: { kind: "process", pid: 5 }, timeoutMs: 100 });
		timeout.adapter.setSnapshot("pid:5", { availability: "confirmed", running: true, healthy: true });
		await timeout.runtime.poll();
		timeout.clock.advance(100);
		await timeout.runtime.poll();
		expect(timeout.runtime.status(timeoutRecord.id)).toMatchObject({
			status: "failed",
			exitReason: "monitor_timeout",
		});
	});

	it("uses fake Tool and Sub-Agent adapters through the same registry", async () => {
		const clock = new Clock();
		const cwd = createWorkspace();
		cleanupPaths.push(cwd);
		const sessionManager = SessionManager.inMemory(cwd);
		const toolAdapter = new FakeToolAdapter();
		const agentAdapter = new FakeSubAgentAdapter();
		const runtime = new MonitorRuntime({
			sessionId: sessionManager.getSessionId(),
			cwd,
			sessionManager,
			now: clock.now,
			adapters: { tool: toolAdapter, "sub-agent": agentAdapter },
		});
		const tool = runtime.attach({ target: { kind: "tool", toolCallId: "tool-fake" } });
		toolAdapter.setSnapshot("tool-fake", { availability: "confirmed", running: true, healthy: true });
		await runtime.poll();
		expect(runtime.status(tool.id).status).toBe("healthy");
		const agent = runtime.attach({ target: { kind: "sub-agent", taskId: "agent-fake" } });
		agentAdapter.setSnapshot("agent-fake", { availability: "confirmed", running: false, exitCode: 0 });
		await runtime.poll();
		expect(runtime.status(agent.id).status).toBe("completed");
	});

	it("reads only new log bytes, detects rotation/truncation, and reports missing logs", async () => {
		const setup = createRuntime();
		cleanupPaths.push(setup.cwd);
		const logPath = join(setup.cwd, "build.log");
		writeFileSync(logPath, "one\n");
		const record = setup.runtime.attach({ target: { kind: "process", pid: 7, logPath }, name: "build" });

		const first = await setup.runtime.logs(record.id);
		expect(first.content).toBe("one\n");
		expect(first.changed).toBe(true);
		const unchanged = await setup.runtime.logs(record.id);
		expect(unchanged.content).toBe("");
		expect(unchanged.changed).toBe(false);
		writeFileSync(logPath, "one\ntwo\n");
		const appended = await setup.runtime.logs(record.id);
		expect(appended.content).toBe("two\n");
		expect(appended.cursor).toBe(8);

		writeFileSync(logPath, "new\n");
		const rotated = await setup.runtime.logs(record.id);
		expect(rotated.content).toBe("new\n");
		expect(rotated.rotated || rotated.truncated).toBe(true);
		rmSync(logPath);
		const missing = await setup.runtime.logs(record.id);
		expect(missing.missing).toBe(true);
		expect(missing.monitor.diagnostics.length).toBeGreaterThan(0);
	});

	it("restores confirmed targets without duplicate events and marks uncertain targets lost", async () => {
		const original = createRuntime();
		cleanupPaths.push(original.cwd);
		const record = original.runtime.attach({ target: { kind: "process", pid: 8 } });
		original.adapter.setSnapshot("pid:8", { availability: "confirmed", running: true, healthy: true });
		await original.runtime.poll();

		const restoredAdapter = new FakeProcessAdapter();
		restoredAdapter.setSnapshot("pid:8", { availability: "confirmed", running: true, healthy: true });
		const restored = createRuntime({ sessionManager: original.sessionManager, adapter: restoredAdapter });
		await restored.runtime.initialize();
		expect(restored.runtime.status(record.id).status).toBe("healthy");
		expect(restored.runtime.getSummary().healthy).toBe(1);
		const restoredEvents: string[] = [];
		restored.runtime.subscribe((event) => {
			restoredEvents.push(event.status);
		});
		await restored.runtime.poll();
		expect(restoredEvents).toEqual([]);

		const uncertainAdapter = new FakeProcessAdapter();
		const uncertain = createRuntime({ sessionManager: original.sessionManager, adapter: uncertainAdapter });
		await uncertain.runtime.initialize();
		expect(uncertain.runtime.status(record.id).status).toBe("lost");
	});

	it("attaches an actual faux-provider Tool execution without a real provider", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Return a deterministic test result",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: { ok: true } }),
		};
		const harness = await createHarness({
			baseToolsOverride: { echo: echoTool },
			responses: [{ toolCalls: [{ name: "echo", args: {} }], stopReason: "toolUse" }, { text: "done" }],
		});
		try {
			await harness.session.prompt("run echo");
			const monitors = harness.session.monitorRuntime.list({ kind: "tool" });
			expect(monitors).toHaveLength(1);
			expect(monitors[0]?.status).toBe("completed");
		} finally {
			harness.cleanup();
		}
	});

	it("consumes Tool and M5 sub-agent lifecycle events through the existing session and pool", async () => {
		const setup = createRuntime();
		cleanupPaths.push(setup.cwd);
		let sessionListener: ((event: AgentSessionEvent) => void) | undefined;
		let poolListener: ((event: AgentLifecycleEvent) => void) | undefined;
		setup.runtime.bindAgentSession({
			subscribe(listener: (event: AgentSessionEvent) => void) {
				sessionListener = listener;
				return () => {
					sessionListener = undefined;
				};
			},
			agentPool: {
				subscribe(listener: (event: AgentLifecycleEvent) => void) {
					poolListener = listener;
					return () => {
						poolListener = undefined;
					};
				},
			} as unknown as AgentPool,
		});
		const toolCallId = "tool-1";
		sessionListener?.({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: "sleep 1" } });
		await setup.runtime.flushEvents();
		const tool = setup.runtime.list({ kind: "tool" })[0];
		expect(tool?.status).toBe("running");
		sessionListener?.({ type: "tool_execution_update", toolCallId, toolName: "bash", args: {}, partialResult: {} });
		sessionListener?.({
			type: "tool_execution_end",
			toolCallId,
			toolName: "bash",
			result: { details: {} },
			isError: false,
		});
		await setup.runtime.flushEvents();
		expect(setup.runtime.list({ kind: "tool" })[0]?.status).toBe("completed");

		const taskId = "agent-1";
		poolListener?.({
			taskId,
			profile: "reviewer",
			taskSummary: "Review changes",
			timestamp: 1_000,
			type: "started",
			status: "starting",
		});
		poolListener?.({
			taskId,
			profile: "reviewer",
			taskSummary: "Review changes",
			timestamp: 1_001,
			type: "running",
			status: "running",
		});
		poolListener?.({
			taskId,
			profile: "reviewer",
			taskSummary: "Review changes",
			timestamp: 1_002,
			type: "progress",
			status: "running",
			turn: 1,
			message: "Reading files",
		});
		poolListener?.({
			taskId,
			profile: "reviewer",
			taskSummary: "Review changes",
			timestamp: 1_003,
			type: "completed",
			status: "completed",
		});
		await setup.runtime.flushEvents();
		const agent = setup.runtime.list({ kind: "sub-agent" })[0];
		expect(agent?.status).toBe("completed");
		expect(setup.runtime.getSummary().completed).toBe(2);
	});

	it("serializes lifecycle listeners and deduplicates identical status events", async () => {
		const setup = createRuntime();
		cleanupPaths.push(setup.cwd);
		setup.runtime.attach({ target: { kind: "process", pid: 9 } });
		const seen: string[] = [];
		setup.runtime.subscribe(async (event) => {
			seen.push(`${event.status}:start`);
			await Promise.resolve();
			seen.push(`${event.status}:end`);
		});
		setup.adapter.setSnapshot("pid:9", { availability: "confirmed", running: true, healthy: false });
		await setup.runtime.poll();
		await setup.runtime.poll();
		await setup.runtime.flushEvents();
		expect(seen).toEqual(["starting:start", "starting:end", "running:start", "running:end"]);
	});
});
