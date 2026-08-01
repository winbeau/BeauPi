import { Compile } from "typebox/compile";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	createPrivilegedExecToolDefinition,
	FakePrivilegeTerminalAdapter,
	getPrivilegeToolDetails,
	PRIVILEGED_EXEC_PARAMETERS,
	PrivilegeRuntime,
} from "../src/core/privilege/index.ts";
import type { RemoteExecutionRuntime } from "../src/core/remote/runtime.ts";

function runtime() {
	const adapter = new FakePrivilegeTerminalAdapter();
	adapter.setResult({ output: "root\n", exitCode: 0 });
	const privilegeRuntime = new PrivilegeRuntime({
		sessionId: "session",
		cwd: "/workspace",
		terminalAdapter: adapter,
		auditWriter: { pathFor: () => "/tmp/audit.jsonl", append: async () => {} },
		handler: async (_request, control) => {
			await control.start();
			await control.wait();
			return { status: "completed" };
		},
	});
	const getTerminalContext = vi.fn(() => ({ targetId: "server", monitorId: "monitor", logPath: "/tmp/log" }));
	const remoteRuntime = { getTerminalContext } as unknown as RemoteExecutionRuntime;
	return { adapter, privilegeRuntime, remoteRuntime, getTerminalContext };
}

describe("privileged_exec tool", () => {
	it("uses a strict local-or-terminal schema without password or grant fields", () => {
		const validator = Compile(PRIVILEGED_EXEC_PARAMETERS);
		expect(validator.Check({ execution: "local", command: "sudo id" })).toBe(true);
		expect(validator.Check({ execution: "terminal", terminalId: "term", command: "sudo id", timeout: 2 })).toBe(true);
		expect(validator.Check({ execution: "local", command: "sudo id", password: "secret" })).toBe(false);
		expect(validator.Check({ execution: "local", command: "sudo id", grant: "session" })).toBe(false);
		expect(validator.Check({ execution: "terminal", command: "sudo id" })).toBe(false);
	});

	it("executes local and existing-terminal requests through the same runtime", async () => {
		const fixture = runtime();
		const tool = createPrivilegedExecToolDefinition(fixture.privilegeRuntime, fixture.remoteRuntime, "/workspace");
		const context = {} as ExtensionContext;
		const local = await tool.execute(
			"local-tool",
			{ execution: "local", command: "sudo id" },
			undefined,
			undefined,
			context,
		);
		const terminal = await tool.execute(
			"terminal-tool",
			{ execution: "terminal", terminalId: "term", command: "sudo id" },
			undefined,
			undefined,
			context,
		);

		expect(local.details).toMatchObject({ status: "succeeded", execution: "local", route: "explicit_tool" });
		expect(getPrivilegeToolDetails({ ...local.details, unknown: true })).toBeUndefined();
		expect(getPrivilegeToolDetails({ ...local.details, version: 2 })).toBeUndefined();
		expect(terminal.details).toMatchObject({
			status: "succeeded",
			execution: "terminal",
			targetId: "server",
			terminalId: "term",
			monitorId: "monitor",
		});
		expect(fixture.adapter.createCalls).toBe(2);
		expect(fixture.getTerminalContext).toHaveBeenCalledWith("term");
	});

	it("blocks commands without deterministic sudo and unsupported identity switches", async () => {
		const fixture = runtime();
		const tool = createPrivilegedExecToolDefinition(fixture.privilegeRuntime, fixture.remoteRuntime, "/workspace");
		for (const command of ["id", "su -", "echo $(sudo id)"]) {
			const result = await tool.execute(
				command,
				{ execution: "local", command },
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			expect(result.details.status, command).toBe("blocked");
		}
		expect(fixture.adapter.createCalls).toBe(0);
	});
});
