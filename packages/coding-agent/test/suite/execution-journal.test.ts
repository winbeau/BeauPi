import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionJournal, ExecutionJournalError } from "../../src/core/execution/execution-journal.ts";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import { createHarness, type Harness } from "./harness.ts";

const created: Harness[] = [];

afterEach(() => {
	for (const harness of created.splice(0)) harness.cleanup();
});

async function createSessionHarness(): Promise<Harness> {
	const harness = await createHarness();
	created.push(harness);
	return harness;
}

describe("execution journal", () => {
	it("records run and tool lifecycle events in persistence order", async () => {
		const harness = await createSessionHarness();
		harness.setResponses([
			() => fauxAssistantMessage(fauxToolCall("read", { path: "/tmp/nonexistent" }), { stopReason: "toolUse" }),
			() => fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("read a file");
		const events = await harness.sessionManager.getExecutionJournal().readEvents();
		const types = events.map((event) => event.type);
		expect(types).toContain("run/created");
		expect(types).toContain("run/started");
		expect(types).toContain("tool/started");
		expect(types).toContain("tool/failed");
		expect(types).toContain("run/settled");
		// seq is strictly increasing persistence order.
		for (let index = 1; index < events.length; index++) {
			expect(events[index]!.seq).toBe(events[index - 1]!.seq + 1);
		}
		// Every event carries schemaVersion, eventId and timestamp.
		for (const event of events) {
			expect(event.schemaVersion).toBe(1);
			expect(event.eventId).toBeTruthy();
			expect(event.timestamp).toBeTruthy();
			expect(event.sessionId).toBe(harness.sessionManager.getSessionId());
		}
		// The run settled as completed.
		const runId = events.find((event) => event.type === "run/created")?.runId;
		expect(runId).toBeTruthy();
		await expect(harness.sessionManager.getExecutionJournal().settledStatus(runId!)).resolves.toBe("completed");
	});

	it("records cancel intent before the AbortSignal is delivered", async () => {
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
		await pending;
		const events = await harness.sessionManager.getExecutionJournal().readEvents();
		const cancelIndex = events.findIndex((event) => event.type === "cancel/requested");
		const bashStartIndex = events.findIndex(
			(event) => event.toolCallId === undefined && event.type === "tool/started",
		);
		expect(cancelIndex).toBeGreaterThanOrEqual(0);
		// cancel intent precedes any terminal tool fact for the cancelled run.
		const terminal = events.findIndex(
			(event) => event.type === "tool/unknown" || event.type === "tool/failed" || event.type === "tool/completed",
		);
		expect(cancelIndex).toBeGreaterThan(bashStartIndex);
		if (terminal >= 0) expect(cancelIndex).toBeLessThan(terminal);
	});

	it("appends batches with continuous seq and detects revision conflicts", async () => {
		const journal = new ExecutionJournal({ sessionId: "s1" });
		const first = await journal.appendBatch([{ type: "run/created", runId: "r1", attempt: 1, owner: "agent" }]);
		expect(first).toEqual({ seqFrom: 1, seqTo: 1, revision: 1 });
		const second = await journal.appendBatch(
			[
				{ type: "tool/started", runId: "r1", toolCallId: "t1", attempt: 1, owner: "agent" },
				{ type: "tool/completed", runId: "r1", toolCallId: "t1", attempt: 1, owner: "agent", status: "completed" },
			],
			{ expectedRevision: 1 },
		);
		expect(second).toEqual({ seqFrom: 2, seqTo: 3, revision: 3 });
		await expect(
			journal.appendBatch([{ type: "run/settled", runId: "r1", attempt: 1, owner: "agent", status: "completed" }], {
				expectedRevision: 2,
			}),
		).rejects.toThrow(ExecutionJournalError);
		// wasCompleted sees the completed tool call.
		await expect(journal.wasCompleted("t1")).resolves.toBe(true);
		await expect(journal.wasCompleted("t2")).resolves.toBe(false);
	});

	it("repairs only an incomplete tail and fails loudly on mid-file corruption", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-journal-"));
		try {
			const path = join(dir, "j.jsonl");
			writeFileSync(
				path,
				'{"seq":1,"eventId":"e1","schemaVersion":1,"timestamp":"2026-01-01T00:00:00.000Z","type":"run/created","runId":"r1","attempt":1,"owner":"agent"}\n{"type":"tool/st',
			);
			const journal = new ExecutionJournal({ sessionId: "s1", filePath: path });
			await expect(journal.repairTail()).resolves.toBe(true);
			const events = await journal.readEvents();
			expect(events).toHaveLength(1);
			expect(events[0]!.seq).toBe(1);
			// Appends continue from the repaired state.
			await expect(
				journal.appendBatch([{ type: "run/started", runId: "r1", attempt: 1, owner: "agent" }]),
			).resolves.toMatchObject({ seqFrom: 2 });

			// Mid-file corruption fails loudly instead of being repaired.
			const corrupt = join(dir, "corrupt.jsonl");
			writeFileSync(
				corrupt,
				'{"seq":1,"eventId":"e1","schemaVersion":1,"timestamp":"2026-01-01T00:00:00.000Z","type":"run/created","runId":"r1","attempt":1,"owner":"agent"}\nnot-json\n{"seq":2,"eventId":"e2","schemaVersion":1,"timestamp":"2026-01-01T00:00:00.000Z","type":"run/started","runId":"r1","attempt":1,"owner":"agent"}\n',
			);
			const corruptJournal = new ExecutionJournal({ sessionId: "s1", filePath: corrupt });
			await expect(corruptJournal.repairTail()).rejects.toThrow(ExecutionJournalError);
			await expect(corruptJournal.readEvents()).rejects.toThrow(ExecutionJournalError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists a file-backed journal across instances", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-journal-"));
		try {
			const path = join(dir, "j.jsonl");
			const first = new ExecutionJournal({ sessionId: "s1", filePath: path });
			await first.recordRunCreated("r1", "agent");
			const second = new ExecutionJournal({ sessionId: "s1", filePath: path });
			const events = await second.readEvents();
			expect(events).toHaveLength(1);
			expect(events[0]!.type).toBe("run/created");
			expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
