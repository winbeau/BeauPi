import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];
const clients: RpcClient[] = [];

function writeQuestionServer(expected: "answered" | "cancelled" | "rejected" | "error" = "answered"): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-question-"));
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
      id: "ui-request-42",
      method: "askUserQuestion",
      requestId: "tool-call-7",
      questions: [{
        question: "Choose a library",
        header: "Library",
        options: [
          { label: "React", description: "Use React" },
          { label: "Vue", description: "Use Vue" }
        ],
        multiSelect: false
      }]
    }) + "\\n");
    return;
  }
  const sameId = message.id === "ui-request-42";
  const valid = ${
		expected === "cancelled"
			? "message.cancelled === true"
			: expected === "rejected"
				? 'message.rejected === true && message.reason === "Decision deferred"'
				: expected === "error"
					? 'message.error === "host failed"'
					: 'Array.isArray(message.answers) && message.answers[0]?.selectedLabels?.[0] === "React"'
  };
  process.stdout.write(JSON.stringify({
    type: "response",
    id: command.id,
    command: command.type,
    success: sameId && valid,
    ...(sameId && valid ? { data: { commands: [] } } : { error: "invalid question response" })
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

describe("RpcClient askUserQuestion bridge", () => {
	it("invokes the controlled callback and responds with the same request id", async () => {
		const client = new RpcClient({
			cliPath: writeQuestionServer(),
			questionHandler: async (request) => ({
				status: "answered",
				answers: [
					{
						header: request.questions[0].header,
						selectedLabels: [request.questions[0].options[0].label],
					},
				],
			}),
		});
		clients.push(client);
		await client.start();
		await expect(client.getCommands()).resolves.toEqual([]);
	});

	it("cancels immediately when no callback is configured", async () => {
		const client = new RpcClient({ cliPath: writeQuestionServer("cancelled") });
		clients.push(client);
		await client.start();
		await expect(client.getCommands()).resolves.toEqual([]);
	});

	it("returns explicit rejections with the same id", async () => {
		const client = new RpcClient({
			cliPath: writeQuestionServer("rejected"),
			questionHandler: async () => ({ status: "rejected", diagnostic: "Decision deferred" }),
		});
		clients.push(client);
		await client.start();
		await expect(client.getCommands()).resolves.toEqual([]);
	});

	it("returns callback failures as structured interaction errors with the same id", async () => {
		const client = new RpcClient({
			cliPath: writeQuestionServer("error"),
			questionHandler: async () => {
				throw new Error("host failed");
			},
		});
		clients.push(client);
		await client.start();
		await expect(client.getCommands()).resolves.toEqual([]);
	});
});
