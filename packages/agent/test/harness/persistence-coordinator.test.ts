import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExecutionJournal } from "../../src/harness/session/execution-journal.ts";
import {
	createMemoryPersistence,
	PersistenceCoordinator,
	type PersistenceEvent,
} from "../../src/harness/session/persistence-coordinator.ts";
import { FileError, type FileSystem, SessionError } from "../../src/harness/types.ts";

function fileError(error: unknown): FileError {
	const code = (error as { code?: unknown } | null)?.code;
	return new FileError(
		code === "ENOENT" || code === "ENOTDIR" ? "not_found" : "unknown",
		error instanceof Error ? error.message : String(error),
	);
}

const fs: Pick<FileSystem, "readTextFile" | "appendFile" | "writeFile"> = {
	async readTextFile(path: string) {
		const { readFileSync } = await import("node:fs");
		try {
			return { ok: true as const, value: readFileSync(path, "utf8") };
		} catch (error) {
			return { ok: false as const, error: fileError(error) };
		}
	},
	async appendFile(path: string, data: string) {
		const { appendFileSync } = await import("node:fs");
		appendFileSync(path, data, "utf8");
		return { ok: true as const, value: undefined };
	},
	async writeFile(path: string, data: string) {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(path, data, "utf8");
		return { ok: true as const, value: undefined };
	},
};

describe("PersistenceCoordinator", () => {
	it("appends batches with continuous seq and schema metadata", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-coord-"));
		try {
			const coordinator = new PersistenceCoordinator({
				fs,
				filePath: join(dir, "j.jsonl"),
				sessionId: "s1",
			});
			const first = await coordinator.appendBatch([
				{ type: "run/created", runId: "r1", attempt: 1, owner: "agent" },
			]);
			expect(first).toEqual({ seqFrom: 1, seqTo: 1, revision: 1 });
			const second = await coordinator.appendBatch(
				[
					{ type: "tool/started", runId: "r1", toolCallId: "t1", attempt: 1, owner: "agent" },
					{
						type: "tool/completed",
						runId: "r1",
						toolCallId: "t1",
						attempt: 1,
						owner: "agent",
						status: "completed",
					},
				],
				{ expectedRevision: 1 },
			);
			expect(second).toEqual({ seqFrom: 2, seqTo: 3, revision: 3 });
			const after = await coordinator.readAfter(1);
			expect(after).toHaveLength(2);
			for (const event of after) {
				expect(event.schemaVersion).toBe(1);
				expect(event.eventId).toBeTruthy();
				expect(event.timestamp).toBeTruthy();
			}
			// Serialized appends: overlapping calls never interleave.
			const coordinator2 = new PersistenceCoordinator({ fs, filePath: join(dir, "j2.jsonl"), sessionId: "s2" });
			await Promise.all([
				coordinator2.appendBatch([{ n: 1 }]),
				coordinator2.appendBatch([{ n: 2 }]),
				coordinator2.appendBatch([{ n: 3 }]),
			]);
			const seqs = (await coordinator2.readAfter(0)).map((event: PersistenceEvent) => event.seq);
			expect(seqs).toEqual([1, 2, 3]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects stale expected revisions", async () => {
		const coordinator = new PersistenceCoordinator({
			fs,
			filePath: join(tmpdir(), "pi-coord-rev.jsonl"),
			sessionId: "s1",
		});
		await coordinator.appendBatch([{ type: "run/created", runId: "r1", attempt: 1, owner: "agent" }]);
		await expect(
			coordinator.appendBatch([{ type: "run/started", runId: "r1", attempt: 1, owner: "agent" }], {
				expectedRevision: 0,
			}),
		).rejects.toThrow(SessionError);
	});

	it("repairs only an incomplete tail and fails loudly on mid-file corruption", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-coord-"));
		try {
			const path = join(dir, "j.jsonl");
			writeFileSync(
				path,
				'{"seq":1,"eventId":"e1","schemaVersion":1,"timestamp":"2026-01-01T00:00:00.000Z","type":"run/created","runId":"r1","attempt":1,"owner":"agent"}\n{"type":"tool/st',
			);
			const coordinator = new PersistenceCoordinator({ fs, filePath: path, sessionId: "s1" });
			await expect(coordinator.repairTail()).resolves.toBe(true);
			expect(await coordinator.readAfter(0)).toHaveLength(1);
			await expect(
				coordinator.appendBatch([{ type: "run/started", runId: "r1", attempt: 1, owner: "agent" }]),
			).resolves.toMatchObject({ seqFrom: 2 });

			const corrupt = join(dir, "corrupt.jsonl");
			writeFileSync(
				corrupt,
				'{"seq":1,"eventId":"e1","schemaVersion":1,"timestamp":"2026-01-01T00:00:00.000Z","type":"run/created","runId":"r1","attempt":1,"owner":"agent"}\nnot-json\n',
			);
			const bad = new PersistenceCoordinator({ fs, filePath: corrupt, sessionId: "s1" });
			await expect(bad.repairTail()).rejects.toThrow(SessionError);
			await expect(bad.readAfter(0)).rejects.toThrow(SessionError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("supports a memory backend for non-persisted sessions", async () => {
		const backend = createMemoryPersistence();
		const journal = new ExecutionJournal({ sessionId: "s1", backend });
		await journal.recordRunCreated("r1", "agent");
		await journal.recordToolStarted("r1", "t1", "agent");
		await journal.recordToolFinished("r1", "t1", "completed", "agent");
		await journal.recordRunSettled("r1", "completed", "agent");
		await expect(journal.wasCompleted("t1")).resolves.toBe(true);
		await expect(journal.settledStatus("r1")).resolves.toBe("completed");
		const inspection = await backend.inspect();
		expect(inspection.revision).toBe(4);
		expect(inspection.lastSeq).toBe(4);
	});
});
