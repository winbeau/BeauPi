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
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

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
			await control.execute();
			await control.wait();
			return { status: "completed" };
		},
	});
	const getTerminalContext = vi.fn(() => ({ targetId: "server", monitorId: "monitor", logPath: "/tmp/log" }));
	const remoteRuntime = { getTerminalContext } as unknown as RemoteExecutionRuntime;
	return { adapter, privilegeRuntime, remoteRuntime, getTerminalContext };
}

describe("privileged_exec tool", () => {
	it("uses a root object schema with strict local-or-terminal validation", () => {
		expect(PRIVILEGED_EXEC_PARAMETERS).toMatchObject({ type: "object", oneOf: expect.any(Array) });
		const validator = Compile(PRIVILEGED_EXEC_PARAMETERS);
		expect(validator.Check({ execution: "local", command: "sudo id" })).toBe(true);
		expect(validator.Check({ execution: "terminal", terminalId: "term", command: "sudo id", timeout: 2 })).toBe(true);
		expect(validator.Check({ execution: "local", command: "sudo apt update\nsudo apt install -y example" })).toBe(
			true,
		);
		expect(validator.Check({ execution: "local", command: "sudo id", password: "secret" })).toBe(false);
		expect(validator.Check({ execution: "local", command: "sudo id", grant: "session" })).toBe(false);
		expect(validator.Check({ execution: "terminal", command: "sudo id" })).toBe(false);
	});

	it("teaches models to prefer direct sudo and reject interactive root shells", () => {
		const fixture = runtime();
		const tool = createPrivilegedExecToolDefinition(fixture.privilegeRuntime, fixture.remoteRuntime, "/workspace");
		const systemPrompt = buildSystemPrompt({
			selectedTools: [tool.name],
			toolSnippets: { [tool.name]: tool.promptSnippet ?? "" },
			promptGuidelines: tool.promptGuidelines,
			contextFiles: [],
			skills: [],
			cwd: "/workspace",
		});

		expect(systemPrompt).toContain(
			"- privileged_exec: Stage sudo commands for user-controlled execution in the secure tmux terminal",
		);
		expect(systemPrompt).toContain("Prefer the direct sudo program that satisfies the task, such as `sudo id`");
		expect(systemPrompt).toContain("multiple newline-separated shell lines");
		expect(systemPrompt).toContain(
			"Do not request an interactive root shell such as `sudo bash`, `sudo sh`, `sudo -i`, or `sudo -s`",
		);
		expect(systemPrompt).toContain("the user retains final execution control with Enter or cancels with Escape");
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
