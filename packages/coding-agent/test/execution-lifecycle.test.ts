import { afterEach, describe, expect, it, vi } from "vitest";
import { bashExecutionStatus } from "../src/core/execution/execution-types.ts";
import { type BashOperations, type BashToolExecutionError, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const created: Harness[] = [];

afterEach(() => {
	for (const harness of created.splice(0)) harness.cleanup();
});

async function createSessionHarness(): Promise<Harness> {
	const harness = await createHarness();
	created.push(harness);
	return harness;
}

describe("neutral bash execution results", () => {
	it("derives status from executor truth values", () => {
		expect(bashExecutionStatus({ exitCode: 0, cancelled: false, timedOut: false })).toBe("completed");
		expect(bashExecutionStatus({ exitCode: 3, cancelled: false, timedOut: false })).toBe("failed");
		expect(bashExecutionStatus({ exitCode: null, cancelled: false, timedOut: false })).toBe("killed");
		expect(bashExecutionStatus({ exitCode: undefined, cancelled: false, timedOut: false })).toBe("unknown");
		expect(bashExecutionStatus({ exitCode: 0, cancelled: true, timedOut: false })).toBe("cancelled");
		expect(bashExecutionStatus({ exitCode: 0, cancelled: false, timedOut: true })).toBe("timed_out");
	});

	it("returns completed status for zero exits and killed for signal kills in the tool result", async () => {
		const tool = createBashToolDefinition("/tmp", {
			exposeSessionEnvironment: false,
			operations: {
				exec: vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 0 })),
			},
		});
		const completed = await tool.execute("t1", { command: "true" }, undefined, undefined, {} as never);
		expect(completed.details).toMatchObject({ exitCode: 0, status: "completed" });
		expect(completed.details?.failureCategory).toBeUndefined();

		const killedTool = createBashToolDefinition("/tmp", {
			exposeSessionEnvironment: false,
			operations: {
				exec: vi.fn<BashOperations["exec"]>(async () => ({ exitCode: null })),
			},
		});
		const killed = await killedTool.execute("t2", { command: "sleep 10" }, undefined, undefined, {} as never);
		expect(killed.details).toMatchObject({ exitCode: null, status: "killed" });
	});

	it("classifies non-zero exits with the shared category in the thrown error", async () => {
		const tool = createBashToolDefinition("/tmp", {
			exposeSessionEnvironment: false,
			operations: {
				exec: vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 127 })),
			},
		});
		await expect(
			tool.execute("t1", { command: "missing-command" }, undefined, undefined, {} as never),
		).rejects.toMatchObject({
			name: "BashToolExecutionError",
			failureCategory: "missing_dependency",
			exitCode: 127,
		});

		const failed = createBashToolDefinition("/tmp", {
			exposeSessionEnvironment: false,
			operations: {
				exec: vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 3 })),
			},
		});
		await expect(
			failed.execute("t2", { command: "exit 3" }, undefined, undefined, {} as never),
		).rejects.toMatchObject({
			failureCategory: "command_exit",
			exitCode: 3,
		} satisfies Partial<BashToolExecutionError>);
	});

	it("records failed status and category on the session bash path", async () => {
		const harness = await createSessionHarness();
		const result = await harness.session.executeBash("exit 3", undefined, {
			operations: { exec: vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 3 })) },
		});
		expect(result).toMatchObject({ exitCode: 3, status: "failed", failureCategory: "command_exit" });
		// Task Ledger failure record carries the same neutral category.
		const failures = harness.session.taskLedger.getSnapshot().failures;
		expect(
			failures.some((failure) => failure.toolName === "bash" && failure.failureCategory === "command_exit"),
		).toBe(true);
	});

	it("reports timed_out (not failed) when the caller provided a timeout that expired", async () => {
		const harness = await createSessionHarness();
		await expect(
			harness.session.executeBash("sleep 30", undefined, {
				operations: {
					exec: vi.fn<BashOperations["exec"]>(async () => {
						throw new Error("timeout:30");
					}),
				},
			}),
		).rejects.toThrow("timeout:30");
		// The recorded bash message status must be timed_out, not failed.
		const entries = harness.sessionManager.getEntries();
		const bashEntry = [...entries]
			.reverse()
			.find((entry) => entry.type === "message" && entry.message.role === "bashExecution");
		expect(bashEntry).toBeDefined();
		if (bashEntry?.type === "message") {
			expect(bashEntry.message).toMatchObject({ status: "timed_out", exitCode: 1, cancelled: false });
		}
	});

	it("never reports succeeded for a cancelled bash run", async () => {
		const harness = await createSessionHarness();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const exec = vi.fn<BashOperations["exec"]>(async (_command, _cwd, { signal }) => {
			await gate;
			if (signal?.aborted) throw new Error("aborted");
			return { exitCode: 0 };
		});
		const pending = harness.session.executeBash("sleep 60", undefined, { operations: { exec } });
		await new Promise((resolve) => setTimeout(resolve, 20));
		harness.session.abortBash();
		release();
		const result = await pending;
		expect(result.cancelled).toBe(true);
		expect(result.status).toBe("cancelled");
		expect(result.exitCode).toBeUndefined();
	});
});
