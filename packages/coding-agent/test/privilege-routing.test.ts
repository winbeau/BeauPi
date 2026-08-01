import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { hasPotentialShellPrivilege, inspectShellPrivilege } from "../src/core/policy/index.ts";
import { FakePrivilegeTerminalAdapter, PrivilegeRuntime } from "../src/core/privilege/index.ts";
import { type BashOperations, createBashToolDefinition, createLocalBashOperations } from "../src/core/tools/bash.ts";

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((item) => (item.type === "text" ? (item.text ?? "") : "")).join("");
}

describe("privilege routing boundary", () => {
	it("classifies deterministic and interactive sudo separately from unsupported and opaque commands", () => {
		expect(inspectShellPrivilege("sudo id")).toMatchObject({ kind: "sudo", sudo: true, opaque: false });
		expect(inspectShellPrivilege("bash -lc 'sudo id'")).toMatchObject({ kind: "sudo", sudo: true, opaque: false });
		expect(inspectShellPrivilege("find . -exec sudo id \\;")).toMatchObject({ kind: "sudo", sudo: true });
		expect(inspectShellPrivilege("su -")).toMatchObject({ kind: "unsupported", sudo: false });
		for (const command of ["sudo -i", "sudo -s", "sudo bash", "sudo env /bin/sh -l"]) {
			expect(inspectShellPrivilege(command), command).toMatchObject({
				kind: "sudo",
				sudo: true,
				interactiveRootShell: true,
				unsupported: [],
			});
		}
		for (const command of ["sudo -A id", "sudo --askpass id"]) {
			expect(inspectShellPrivilege(command), command).toMatchObject({
				kind: "unsupported",
				sudo: true,
				sudoAskpass: true,
			});
		}
		expect(inspectShellPrivilege("sudo bash script.sh")).toMatchObject({ kind: "sudo", interactiveRootShell: false });
		expect(inspectShellPrivilege("sudo sh -c 'id'")).toMatchObject({ kind: "sudo", interactiveRootShell: false });
		expect(inspectShellPrivilege("echo $(sudo id)")).toMatchObject({ kind: "opaque", opaque: true });
		expect(hasPotentialShellPrivilege("echo $(sudoedit /etc/hosts)")).toBe(true);
		expect(inspectShellPrivilege("printf sudo")).toMatchObject({ kind: "none", sudo: false });
	});

	it("routes a sudo Bash tool call before ordinary operations execute", async () => {
		const ordinaryExec = vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 0 }));
		const adapter = new FakePrivilegeTerminalAdapter();
		adapter.setResult({ output: "root\n", exitCode: 0 });
		const runtime = new PrivilegeRuntime({
			sessionId: "session",
			cwd: "/tmp",
			terminalAdapter: adapter,
			auditWriter: {
				pathFor: () => "/tmp/audit.jsonl",
				append: async () => {},
			},
			handler: async (_request, control) => {
				await control.start();
				await control.execute();
				await control.wait();
				return { status: "completed" };
			},
		});
		const tool = createBashToolDefinition("/tmp", {
			operations: { exec: ordinaryExec },
			privilegeRuntime: runtime,
		});

		const result = await tool.execute(
			"sudo-tool",
			{ command: "sudo id" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(ordinaryExec).not.toHaveBeenCalled();
		expect(result.details).toMatchObject({ status: "succeeded", route: "local_bash", sourceTool: "bash" });
		expect(text(result)).toContain("root");
	});

	it("returns interaction_required from Bash in headless mode without executing ordinary operations", async () => {
		const ordinaryExec = vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 0 }));
		const runtime = new PrivilegeRuntime({
			sessionId: "session",
			cwd: "/tmp",
			terminalAdapter: new FakePrivilegeTerminalAdapter(),
			auditWriter: {
				pathFor: () => "/tmp/audit.jsonl",
				append: async () => {},
			},
		});
		const tool = createBashToolDefinition("/tmp", {
			operations: { exec: ordinaryExec },
			privilegeRuntime: runtime,
		});

		const result = await tool.execute(
			"headless-sudo",
			{ command: "sudo id" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(ordinaryExec).not.toHaveBeenCalled();
		expect(result.details).toMatchObject({ status: "interaction_required", ok: false });
		expect(text(result)).toContain("interaction");
	});

	it("blocks direct local sudo operations when no router is present", async () => {
		const operations = createLocalBashOperations();

		await expect(
			operations.exec("sudo id", process.cwd(), {
				onData: () => {},
			}),
		).rejects.toThrow("PrivilegeRuntime");
	});
});
