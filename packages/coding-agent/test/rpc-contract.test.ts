import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import {
	RPC_MAX_LINE_BYTES,
	RPC_PROTOCOL_VERSION,
	type RpcErrorCode,
	rpcLineBytes,
} from "../src/modes/rpc/rpc-types.ts";

const tempDirs: string[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-contract-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

async function startClient(script: string): Promise<RpcClient> {
	const client = new RpcClient({ cliPath: writeChildScript(script) });
	await client.start();
	return client;
}

describe("local JSONL RPC contract", () => {
	test("parses the hello greeting and never surfaces it as an event", async () => {
		const events: unknown[] = [];
		const client = await startClient(`
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	const command = JSON.parse(chunk);
	process.stdout.write(JSON.stringify({
		type: "hello",
		protocolVersion: 1,
		serverVersion: "9.9.9",
		capabilities: ["prompt", "bash"],
		limits: { maxLineBytes: 4194304 },
	}) + "\\n");
	process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { commands: [] } }) + "\\n");
});
process.stdin.resume();
`);
		client.onEvent((event) => events.push(event));
		await client.getCommands();
		expect(client.serverHello).toMatchObject({
			type: "hello",
			protocolVersion: 1,
			serverVersion: "9.9.9",
			capabilities: ["prompt", "bash"],
		});
		expect(client.serverHello?.limits.maxLineBytes).toBe(4194304);
		expect(events).toEqual([]);
	});

	test("surfaces typed error codes on failed requests", async () => {
		const client = await startClient(`
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	const command = JSON.parse(chunk);
	process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "Unknown command: frobnicate", code: "unsupported_command" }) + "\\n");
});
process.stdin.resume();
`);
		const failure = await client.getCommands().catch((error: Error & { code?: RpcErrorCode }) => error);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("Unknown command: frobnicate");
		expect((failure as Error & { code?: RpcErrorCode }).code).toBe("unsupported_command");
	});

	test("correlates responses with request ids while events keep order", async () => {
		const events: Array<{ type: string }> = [];
		let settledResolve!: () => void;
		const settled = new Promise<void>((resolve) => {
			settledResolve = resolve;
		});
		const client = await startClient(`
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	const command = JSON.parse(chunk);
	process.stdout.write(JSON.stringify({ type: "agent_start", timestamp: 1 }) + "\\n");
	process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { commands: [{ name: "a", source: "prompt" }] } }) + "\\n");
	process.stdout.write(JSON.stringify({ type: "agent_settled", timestamp: 2 }) + "\\n");
});
process.stdin.resume();
`);
		client.onEvent((event) => {
			events.push(event as { type: string });
			if ((event as { type: string }).type === "agent_settled") settledResolve();
		});
		const data = await client.getCommands();
		await settled;
		expect(data).toHaveLength(1);
		// The response is not an event; events keep arrival order.
		expect(events.map((event) => event.type)).toEqual(["agent_start", "agent_settled"]);
	});

	test("shutdown-coded errors settle pending requests deterministically", async () => {
		const client = await startClient(`
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	const command = JSON.parse(chunk);
	process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "Server shutting down", code: "shutdown" }) + "\\n");
	setTimeout(() => process.exit(0), 50);
});
process.stdin.resume();
`);
		const failure = await client.getCommands().catch((error: Error & { code?: RpcErrorCode }) => error);
		expect((failure as Error & { code?: RpcErrorCode }).code).toBe("shutdown");
	});

	test("enforces a single-line size limit (local-process stability)", () => {
		expect(RPC_MAX_LINE_BYTES).toBe(4 * 1024 * 1024);
		expect(RPC_PROTOCOL_VERSION).toBe(1);
		expect(rpcLineBytes({ type: "hello", protocolVersion: 1 })).toBeLessThan(100);
		const huge = {
			type: "response",
			command: "get_entries",
			success: true,
			data: { entries: Array.from({ length: 400_000 }, (_, i) => ({ id: `e${i}` })) },
		};
		expect(rpcLineBytes(huge)).toBeGreaterThan(RPC_MAX_LINE_BYTES);
	});
});
