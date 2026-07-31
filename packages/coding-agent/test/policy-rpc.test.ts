import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];
const clients: RpcClient[] = [];

function writePolicyServer(): string {
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
  const valid = message.cancelled === true;
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

describe("RpcClient legacy Policy confirmation handling", () => {
	it("cancels stale Policy requests without exposing or invoking a callback", async () => {
		const client = new RpcClient({ cliPath: writePolicyServer() });
		clients.push(client);
		await client.start();
		await expect(client.getCommands()).resolves.toEqual([]);
	});
});
