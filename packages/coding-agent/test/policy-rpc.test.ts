import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];
const clients: RpcClient[] = [];

function writePolicyServer(expected: "allow" | "cancelled" | "rejected" | "error" = "allow"): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-policy-"));
	tempDirs.push(dir);
	const path = join(dir, "server.mjs");
	writeFileSync(
		path,
		`import * as readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, terminal: false });
let command;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (!command) {
    command = message;
    process.stdout.write(JSON.stringify({
      type: "extension_ui_request",
      id: "policy-ui-42",
      method: "policyConfirm",
      request: {
        version: 1,
        requestId: "policy-request-7",
        toolCallId: "tool-call-7",
        toolName: "write",
        operation: {
          version: 1,
          toolName: "write",
          kind: "sensitive_path",
          classes: ["workspace_write", "sensitive_path"],
          access: "write",
          target: "local",
          signature: "policy_signature",
          equivalenceSignature: "policy_equivalence",
          fallbackFamily: "local",
          sensitive: true,
          privileged: false,
          readOnly: false,
          workspaceMutation: true,
          summary: "Local workspace modification"
        },
        reason: "Sensitive path",
        suggestion: "Allow this request only once.",
        createdAt: "2026-07-30T00:00:00.000Z"
      }
    }) + "\\n");
    return;
  }
  const sameId = message.id === "policy-ui-42";
  const valid = ${
		expected === "cancelled"
			? "message.cancelled === true"
			: expected === "rejected"
				? 'message.rejected === true && message.reason === "Not approved"'
				: expected === "error"
					? 'message.error === "host failed"'
					: 'message.policyDecision === "allow_once"'
  };
  process.stdout.write(JSON.stringify({
    type: "response",
    id: command.id,
    command: command.type,
    success: sameId && valid,
    ...(sameId && valid ? { data: { commands: [] } } : { error: "invalid Policy response" })
  }) + "\\n");
});
`,
	);
	return path;
}

afterEach(async () => {
	while (clients.length > 0) await clients.pop()?.stop();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("RpcClient Policy confirmation bridge", () => {
	it("allows one stable request and responds with the same RPC id", async () => {
		const client = new RpcClient({
			cliPath: writePolicyServer(),
			policyHandler: async (request) => {
				expect(request.request.requestId).toBe("policy-request-7");
				return { status: "allow_once" };
			},
		});
		clients.push(client);
		await client.start();
		await expect(client.getCommands()).resolves.toEqual([]);
	});

	it("cancels immediately when no Policy callback is configured", async () => {
		const client = new RpcClient({ cliPath: writePolicyServer("cancelled") });
		clients.push(client);
		await client.start();
		await expect(client.getCommands()).resolves.toEqual([]);
	});

	it("cancels an active Policy request when the callback is replaced", async () => {
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const client = new RpcClient({
			cliPath: writePolicyServer("cancelled"),
			policyHandler: async () => {
				markStarted();
				return await new Promise<never>(() => {});
			},
		});
		clients.push(client);
		await client.start();
		const command = client.getCommands();
		await started;
		client.setPolicyHandler(undefined);
		await expect(command).resolves.toEqual([]);
	});

	it("returns explicit rejection and callback errors structurally", async () => {
		const rejected = new RpcClient({
			cliPath: writePolicyServer("rejected"),
			policyHandler: async () => ({ status: "rejected", diagnostic: "Not approved" }),
		});
		clients.push(rejected);
		await rejected.start();
		await expect(rejected.getCommands()).resolves.toEqual([]);

		const failed = new RpcClient({
			cliPath: writePolicyServer("error"),
			policyHandler: async () => {
				throw new Error("host failed");
			},
		});
		clients.push(failed);
		await failed.start();
		await expect(failed.getCommands()).resolves.toEqual([]);
	});
});
