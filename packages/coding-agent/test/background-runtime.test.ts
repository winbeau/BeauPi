import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BackgroundProgressReviewer,
	BackgroundTaskManager,
	type BackgroundTaskSnapshotV1,
	FakeProcessAdapter,
	FakeSshTmuxAdapter,
	MonitorRuntime,
	type ProgressReviewV1,
} from "../src/core/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		if (existsSync(root)) rmSync(root, { recursive: true, force: true });
	}
});

function workspace(): string {
	const path = mkdtempSync(join(tmpdir(), "beaupi-background-"));
	roots.push(path);
	return path;
}

function setup(
	options: {
		adapter?: FakeProcessAdapter;
		monitorAdapter?: FakeSshTmuxAdapter;
		reviewer?: BackgroundProgressReviewer;
	} = {},
) {
	const cwd = workspace();
	const sessionManager = SessionManager.inMemory(cwd);
	const adapter = options.adapter ?? new FakeProcessAdapter();
	const monitor = new MonitorRuntime({
		sessionId: sessionManager.getSessionId(),
		cwd,
		sessionManager,
		processAdapter: adapter,
		adapters: options.monitorAdapter ? { "ssh-tmux": options.monitorAdapter } : undefined,
		now: () => Date.now(),
		stallTimeoutMs: 20,
	});
	const manager = new BackgroundTaskManager({
		sessionId: sessionManager.getSessionId(),
		cwd,
		sessionManager,
		monitorRuntime: monitor,
		progressReviewer: options.reviewer,
		polling: false,
	});
	return { cwd, sessionManager, adapter, monitor, manager };
}

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("BackgroundTaskManager", () => {
	it("starts immediately, survives the initiating turn, and records a real exit code", async () => {
		const setupValue = setup();
		const { manager, monitor } = setupValue;
		const task = await manager.start({
			executable: process.execPath,
			args: ["-e", "setTimeout(() => process.stdout.write('done\\n'), 35)"],
			goal: "short process",
		});
		expect(task.id).toMatch(/^bg-/);
		expect(task.monitor?.target.kind).toBe("process");
		expect(task.monitor?.logPath).toContain("background-logs");
		let completed = await manager.status(task.id);
		for (let attempt = 0; attempt < 100 && !Array.isArray(completed) && completed.status !== "completed"; attempt++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
			await manager.poll();
			completed = await manager.status(task.id);
		}
		expect(Array.isArray(completed)).toBe(false);
		expect((completed as BackgroundTaskSnapshotV1).status).toBe("completed");
		expect((completed as BackgroundTaskSnapshotV1).monitor?.exitCode).toBe(0);
		expect((await manager.logs(task.id, { mode: "full" })).logs.content).toContain("done");
		manager.dispose();
		monitor.dispose();
	});

	it("attaches fake remote Monitor targets and keeps Monitor tools interoperable", async () => {
		const remote = new FakeSshTmuxAdapter();
		const setupValue = setup({ monitorAdapter: remote });
		const { manager, monitor } = setupValue;
		const attachedMonitor = monitor.attach({
			target: {
				kind: "ssh-tmux",
				targetId: "trusted",
				resource: "terminal",
				operationId: "term-1",
			},
			name: "remote terminal",
		});
		remote.setSnapshot(attachedMonitor.id, { availability: "confirmed", running: true, healthy: true });
		await monitor.poll();
		const task = await manager.attach({ monitorId: attachedMonitor.id, goal: "remote work" });
		expect(task.monitorId).toBe(attachedMonitor.id);
		expect(task.status).toBe("healthy");
		expect((await monitor.status(attachedMonitor.id)).status).toBe("healthy");
		manager.dispose();
		monitor.dispose();
	});

	it("deduplicates wake events, merges simultaneous completions, and uses follow-up while busy", async () => {
		const adapter = new FakeProcessAdapter();
		const setupValue = setup({ adapter });
		const { manager, monitor, sessionManager, cwd } = setupValue;
		const delivered: Array<{ mode: string; taskCount: number; eventCount: number }> = [];
		manager.bindWakeHost({
			isBusy: () => delivered.length === 0,
			hasPendingUserMessages: () => false,
			deliver: async (delivery, mode) => {
				delivered.push({ mode, taskCount: delivery.tasks.length, eventCount: delivery.events.length });
			},
		});
		const firstMonitor = monitor.attach({ target: { kind: "process", pid: 101 }, name: "one" });
		const secondMonitor = monitor.attach({ target: { kind: "process", pid: 102 }, name: "two" });
		adapter.setSnapshot("pid:101", { availability: "confirmed", running: true, healthy: true });
		adapter.setSnapshot("pid:102", { availability: "confirmed", running: true, healthy: true });
		await monitor.poll();
		const first = await manager.attach({ monitorId: firstMonitor.id });
		const second = await manager.attach({ monitorId: secondMonitor.id });
		await manager.wait(first.id, [{ type: "completed" }]);
		await manager.wait(second.id, [{ type: "completed" }]);
		adapter.setSnapshot("pid:101", { availability: "confirmed", running: false, exitCode: 0 });
		adapter.setSnapshot("pid:102", { availability: "confirmed", running: false, exitCode: 0 });
		await manager.poll();
		await settle();
		expect(delivered).toEqual([{ mode: "followUp", taskCount: 2, eventCount: 2 }]);
		await manager.poll();
		await settle();
		expect(delivered).toHaveLength(1);
		manager.dispose();
		monitor.dispose();

		const restoredMonitor = new MonitorRuntime({ sessionId: sessionManager.getSessionId(), cwd, sessionManager });
		await restoredMonitor.initialize();
		const restored = new BackgroundTaskManager({
			sessionId: sessionManager.getSessionId(),
			cwd,
			sessionManager,
			monitorRuntime: restoredMonitor,
			polling: false,
		});
		restored.bindWakeHost({
			isBusy: () => false,
			hasPendingUserMessages: () => false,
			deliver: async () => {
				delivered.push({ mode: "duplicate", taskCount: 0, eventCount: 0 });
			},
		});
		await restored.initialize();
		await restored.poll();
		await settle();
		expect(delivered).toHaveLength(1);
		restored.dispose();
		restoredMonitor.dispose();
	});

	it("creates error-pattern and stalled facts without re-reading unchanged logs", async () => {
		const adapter = new FakeProcessAdapter();
		const setupValue = setup({ adapter });
		const { manager, monitor, cwd } = setupValue;
		const logPath = join(cwd, "pattern.log");
		writeFileSync(logPath, "ok\n");
		const record = monitor.attach({ target: { kind: "process", pid: 103, logPath }, name: "pattern" });
		adapter.setSnapshot("pid:103", { availability: "confirmed", running: true, healthy: true });
		await monitor.poll();
		const task = await manager.attach({
			monitorId: record.id,
			triggers: [{ type: "error-pattern", pattern: "fatal" }],
		});
		await manager.wait(task.id);
		appendFileSync(logPath, "fatal: broken\n");
		await manager.poll();
		await settle();
		expect((await manager.getWakeEvents(task.id)).map((event) => event.reason)).toEqual(["error-pattern"]);
		await manager.poll();
		expect(await manager.getWakeEvents(task.id)).toHaveLength(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		await manager.poll();
		expect(((await manager.status(task.id)) as BackgroundTaskSnapshotV1).status).toBe("stalled");
		manager.dispose();
		monitor.dispose();
	});

	it("enforces reviewer budget and makes no call when the log hash is unchanged", async () => {
		let calls = 0;
		const review: ProgressReviewV1 = {
			version: 1,
			state: "progressing",
			summary: "still moving",
			shouldWakeCoordinator: false,
			reviewedAt: 1,
			logHash: "",
		};
		const reviewer: BackgroundProgressReviewer = {
			review: async (input) => {
				calls++;
				return { ...review, reviewedAt: Date.now(), logHash: input.logHash };
			},
		};
		const adapter = new FakeProcessAdapter();
		const setupValue = setup({ adapter, reviewer });
		const { manager, monitor, cwd } = setupValue;
		const logPath = join(cwd, "review.log");
		writeFileSync(logPath, "progress one\n");
		const record = monitor.attach({ target: { kind: "process", pid: 104, logPath }, name: "review" });
		adapter.setSnapshot("pid:104", { availability: "confirmed", running: true, healthy: true });
		await monitor.poll();
		const task = await manager.attach({
			monitorId: record.id,
			triggers: [{ type: "progress-review" }],
			progressReview: {
				enabled: true,
				minimumIntervalMs: 1,
				maxReviews: 1,
				maxInputCharacters: 1000,
				timeoutMs: 1000,
			},
		});
		await manager.wait(task.id);
		appendFileSync(logPath, "progress two\n");
		await manager.poll();
		expect(calls).toBe(1);
		await manager.poll();
		expect(calls).toBe(1);
		manager.dispose();
		monitor.dispose();
	});

	it("escalates graceful cancellation to the whole local process group", async () => {
		const setupValue = setup();
		const { manager, monitor, cwd } = setupValue;
		const childPidPath = join(cwd, "child.pid");
		const script = [
			"const { spawn } = require('node:child_process');",
			"const fs = require('node:fs');",
			`const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });`,
			`fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
			"process.on('SIGTERM', () => {});",
			"setInterval(() => {}, 1000);",
		].join("\n");
		const task = await manager.start({ executable: process.execPath, args: ["-e", script], goal: "cancel tree" });
		for (let index = 0; index < 20 && !existsSync(childPidPath); index++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		}
		expect(existsSync(childPidPath)).toBe(true);
		const childPid = Number.parseInt(readFileSync(childPidPath, "utf8"), 10);
		expect(() => process.kill(childPid, 0)).not.toThrow();
		const cancelled = await manager.cancel(task.id, 20);
		expect(cancelled.cancel).toMatchObject({ accepted: true, forced: true });
		expect(cancelled.task?.status).toBe("cancelled");
		manager.dispose();
		monitor.dispose();
	});

	it("restores uncertain nonterminal tasks as lost and never guesses success", async () => {
		const adapter = new FakeProcessAdapter();
		const original = setup({ adapter });
		const { manager, monitor, sessionManager, cwd } = original;
		const record = monitor.attach({ target: { kind: "process", pid: 105 }, name: "uncertain" });
		adapter.setSnapshot("pid:105", { availability: "confirmed", running: true, healthy: true });
		await monitor.poll();
		const task = await manager.attach({ monitorId: record.id });
		await manager.wait(task.id);
		manager.dispose();
		monitor.dispose();

		const restoredMonitor = new MonitorRuntime({
			sessionId: sessionManager.getSessionId(),
			cwd,
			sessionManager,
			processAdapter: new FakeProcessAdapter(),
		});
		await restoredMonitor.initialize();
		const restored = new BackgroundTaskManager({
			sessionId: sessionManager.getSessionId(),
			cwd,
			sessionManager,
			monitorRuntime: restoredMonitor,
			polling: false,
		});
		await restored.initialize();
		expect(((await restored.status(task.id)) as BackgroundTaskSnapshotV1).status).toBe("lost");
		restored.dispose();
		restoredMonitor.dispose();
	});
});
