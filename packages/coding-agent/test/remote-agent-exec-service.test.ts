import { describe, expect, it } from "vitest";
import { ExecService } from "../src/remote-agent/exec-service.ts";

describe("Remote Agent exec lifecycle", () => {
	it("limits concurrency, cancels queued work before acceptance, and keeps cancel idempotent", async () => {
		const service = new ExecService({ maxConcurrentExec: 1, maxQueuedExec: 1, terminationGraceMs: 100 });
		const exits: Array<{ operationId: string; cancelled: boolean }> = [];
		const callbacks = () => ({
			onOutput: () => undefined,
			onExit: (event: { operationId: string; cancelled: boolean }) =>
				exits.push({ operationId: event.operationId, cancelled: event.cancelled }),
		});
		const first = await service.start(
			{ operationId: "op-first", command: "sleep 1", cwd: process.cwd() },
			callbacks(),
		);
		expect(first.operationId).toBe("op-first");
		const queued = service.start(
			{ operationId: "op-queued", command: "printf queued", cwd: process.cwd() },
			callbacks(),
		);
		expect(service.queueDepth).toBe(1);
		expect(service.cancel("op-queued")).toBe("cancelled");
		await expect(queued).rejects.toMatchObject({
			diagnostic: { code: "agent_cancelled", executionState: "not_started" },
		});
		expect(service.cancel("op-queued")).toBe("cancelled");
		expect(service.cancel("op-first")).toBe("cancel_requested");
		const deadline = Date.now() + 2_000;
		while (service.activeCount > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
		expect(service.activeCount).toBe(0);
		expect(service.cancel("op-first")).toBe("cancelled");
		expect(exits).toEqual([{ operationId: "op-first", cancelled: true }]);
		await service.shutdown();
	});
});
