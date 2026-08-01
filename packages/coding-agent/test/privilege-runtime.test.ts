import { describe, expect, it, vi } from "vitest";
import {
	FakePrivilegeTerminalAdapter,
	type PrivilegeAuditEventV1,
	type PrivilegeAuditWriter,
	PrivilegeRuntime,
} from "../src/core/privilege/index.ts";

class FakeAuditWriter implements PrivilegeAuditWriter {
	readonly events: PrivilegeAuditEventV1[] = [];

	pathFor(): string {
		return "/tmp/beaupi-privileged-audit.jsonl";
	}

	async append(event: PrivilegeAuditEventV1): Promise<void> {
		this.events.push(structuredClone(event));
	}
}

function request(toolCallId: string) {
	return {
		toolCallId,
		sourceTool: "bash",
		route: "local_bash" as const,
		command: "sudo id",
		target: { execution: "local" as const },
		cwd: "/tmp",
	};
}

describe("PrivilegeRuntime", () => {
	it("returns interaction_required without creating or starting a command session", async () => {
		const adapter = new FakePrivilegeTerminalAdapter();
		const audit = new FakeAuditWriter();
		const runtime = new PrivilegeRuntime({
			sessionId: "session",
			cwd: "/tmp",
			terminalAdapter: adapter,
			auditWriter: audit,
		});

		const result = await runtime.execute(request("headless"));

		expect(result.details).toMatchObject({
			status: "interaction_required",
			ok: false,
			diagnostic: { code: "interaction_required" },
		});
		expect(adapter.createCalls).toBe(0);
		expect(adapter.startCalls).toBe(0);
		expect(audit.events.map((event) => event.event)).toEqual(["requested", "blocked"]);
	});

	it("stages every request before a fresh user execution", async () => {
		const adapter = new FakePrivilegeTerminalAdapter();
		adapter.setResult({ output: "uid=0(root)\n", exitCode: 0 });
		const audit = new FakeAuditWriter();
		const runtime = new PrivilegeRuntime({
			sessionId: "session",
			cwd: "/tmp",
			terminalAdapter: adapter,
			auditWriter: audit,
		});
		const confirmations: string[] = [];
		runtime.setHandler(async (interaction, control) => {
			confirmations.push(interaction.requestId);
			expect(adapter.startCalls).toBe(confirmations.length - 1);
			expect(adapter.executeCalls).toBe(confirmations.length - 1);
			await control.start();
			expect(adapter.executeCalls).toBe(confirmations.length - 1);
			await control.execute();
			await control.wait();
			return { status: "completed" };
		});

		const first = await runtime.execute(request("first"));
		const second = await runtime.execute(request("second"));

		expect(first.details.status).toBe("succeeded");
		expect(second.details.status).toBe("succeeded");
		expect(confirmations).toHaveLength(2);
		expect(new Set(confirmations).size).toBe(2);
		expect(adapter.createCalls).toBe(2);
		expect(adapter.startCalls).toBe(2);
		expect(adapter.executeCalls).toBe(2);
		expect(audit.events.filter((event) => event.event === "confirmed")).toHaveLength(2);
	});

	it("deduplicates repeated entry for the same tool call", async () => {
		const adapter = new FakePrivilegeTerminalAdapter();
		const runtime = new PrivilegeRuntime({
			sessionId: "session",
			cwd: "/tmp",
			terminalAdapter: adapter,
			auditWriter: new FakeAuditWriter(),
			handler: async (_interaction, control) => {
				await control.start();
				await control.execute();
				await control.wait();
				return { status: "completed" };
			},
		});

		const [first, duplicate] = await Promise.all([
			runtime.execute(request("same-tool-call")),
			runtime.execute(request("same-tool-call")),
		]);
		const replay = await runtime.execute(request("same-tool-call"));

		expect(duplicate).toEqual(first);
		expect(replay).toEqual(first);
		expect(adapter.createCalls).toBe(1);
		expect(adapter.startCalls).toBe(1);
	});

	it("keeps sensitive input only in the fake adapter test field", async () => {
		const secret = Buffer.from("M13-secret-fixture-token\r", "utf8");
		const adapter = new FakePrivilegeTerminalAdapter();
		adapter.setResult({ output: "done\n", exitCode: 0, logPath: "/tmp/privilege.log" });
		const audit = new FakeAuditWriter();
		const runtime = new PrivilegeRuntime({
			sessionId: "session",
			cwd: "/tmp",
			terminalAdapter: adapter,
			auditWriter: audit,
		});
		runtime.setHandler(async (_interaction, control) => {
			await control.start();
			await control.execute();
			await control.sendSensitive(secret);
			await control.wait();
			return { status: "completed" };
		});

		const result = await runtime.execute(request("secret"));
		const serialized = JSON.stringify({ result, audit: audit.events });

		expect(adapter.getReceivedInputForTest()).toEqual(secret);
		expect(serialized).not.toContain(secret.toString("utf8").trim());
		expect(result.details).not.toHaveProperty("input");
		expect(result).not.toHaveProperty("input");
	});

	it("cancels the active terminal session when the request signal aborts", async () => {
		const adapter = new FakePrivilegeTerminalAdapter();
		adapter.setWaitPending(true);
		const runtime = new PrivilegeRuntime({
			sessionId: "session",
			cwd: "/tmp",
			terminalAdapter: adapter,
			auditWriter: new FakeAuditWriter(),
		});
		const controller = new AbortController();
		runtime.setHandler(async (_interaction, control) => {
			await control.start();
			await control.execute();
			controller.abort();
			await control.wait();
			return { status: "completed" };
		});

		const result = await runtime.execute(request("cancel"), controller.signal);

		expect(result.details.status).toBe("cancelled");
		expect(adapter.cancelCalls).toBe(1);
	});

	it("fails closed when the requested audit record cannot be written", async () => {
		const adapter = new FakePrivilegeTerminalAdapter();
		const runtime = new PrivilegeRuntime({
			sessionId: "session",
			cwd: "/tmp",
			terminalAdapter: adapter,
			auditWriter: {
				pathFor: () => "/tmp/audit.jsonl",
				append: async () => {
					throw new Error("disk unavailable");
				},
			},
			handler: vi.fn(),
		});

		const result = await runtime.execute(request("audit-failure"));

		expect(result.details).toMatchObject({ status: "blocked", diagnostic: { code: "audit_failed" } });
		expect(adapter.createCalls).toBe(0);
	});

	it("maps nonzero exits and timeouts into stable result facts", async () => {
		for (const configured of [
			{ output: "denied\n", exitCode: 7 },
			{ output: "partial\n", exitCode: null, timedOut: true },
		]) {
			const adapter = new FakePrivilegeTerminalAdapter();
			adapter.setResult(configured);
			const runtime = new PrivilegeRuntime({
				sessionId: "session",
				cwd: "/tmp",
				terminalAdapter: adapter,
				auditWriter: new FakeAuditWriter(),
				handler: async (_interaction, control) => {
					await control.start();
					await control.execute();
					await control.wait();
					return { status: "completed" };
				},
			});
			const result = await runtime.execute(request(`exit-${configured.exitCode}`));
			expect(result.details.ok).toBe(false);
			expect(result.details.status).toBe("failed");
			expect(result.details.exitCode).toBe(configured.exitCode);
			expect(result.details.diagnostic?.code).toBe(configured.timedOut ? "timeout" : "command_failed");
		}
	});

	it("rejects unsupported identity switching and sudo stdin mode before interaction", async () => {
		const adapter = new FakePrivilegeTerminalAdapter();
		const handler = vi.fn();
		const runtime = new PrivilegeRuntime({
			sessionId: "session",
			cwd: "/tmp",
			terminalAdapter: adapter,
			auditWriter: new FakeAuditWriter(),
			handler,
		});

		for (const command of [
			"sudo id\u001b[2J",
			"sudo id\rprintf spoofed",
			"sudo id\b",
			"su -",
			"doas id",
			"pkexec bash",
			"sudo -S id",
			"sudo --stdin id",
			"sudo -A id",
			"sudo --askpass id",
			"sudo -i",
			"sudo -s",
			"sudo bash",
		]) {
			const result = await runtime.execute({ ...request(command), toolCallId: command, command });
			expect(result.details.status, command).toBe("blocked");
		}
		expect(handler).not.toHaveBeenCalled();
		expect(adapter.createCalls).toBe(0);
	});
});
