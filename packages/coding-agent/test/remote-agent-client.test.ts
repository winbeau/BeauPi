import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeSshTmuxAdapter } from "../src/core/remote/index.ts";
import {
	AgentServer,
	AgentSshConnection,
	createFakeRemoteAgentTransportPair,
	MemoryRemoteAgentArtifactProvider,
	RemoteAgentClient,
	RemoteAgentExecutionError,
	targetFingerprint,
} from "../src/core/remote-agent/index.ts";

const target = {
	sshAlias: "test-alias",
	remoteCwd: resolve("."),
};
const artifact = Buffer.from("test-agent-artifact", "utf8");
const artifactProvider = new MemoryRemoteAgentArtifactProvider(artifact);
const manifest = await artifactProvider.load();
const openServers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
	for (const server of openServers.splice(0)) await server.close();
});

async function createClient() {
	const pair = createFakeRemoteAgentTransportPair();
	const server = new AgentServer({ artifactSha256: manifest.manifest.sha256 });
	void server.run(pair.serverInput, pair.serverOutput);
	openServers.push(server);
	const client = new RemoteAgentClient({
		hello: {
			protocolVersion: 1,
			clientVersion: "test",
			clientSessionId: "session-test",
			clientInstanceId: "client-test",
			targetId: "target-test",
			targetFingerprint: targetFingerprint(target),
			workspaceCwd: target.remoteCwd,
			capabilities: ["exec-v1"],
		},
		expectedArtifactSha256: manifest.manifest.sha256,
		transportFactory: () => Promise.resolve(pair.client),
	});
	return { client, pair, server };
}

describe("Remote Agent client/server", () => {
	it("replies once and closes the channel after malformed framing", async () => {
		const pair = createFakeRemoteAgentTransportPair();
		const server = new AgentServer({ artifactSha256: manifest.manifest.sha256 });
		const frames: Buffer[] = [];
		pair.serverOutput.on("data", (chunk: Buffer) => frames.push(Buffer.from(chunk)));
		const serverRun = server.run(pair.serverInput, pair.serverOutput);
		pair.serverInput.write(Buffer.from("not-a-frame", "ascii"));
		pair.serverInput.end();
		await expect(
			Promise.race([
				serverRun,
				new Promise((_, reject) => setTimeout(() => reject(new Error("server did not close")), 1_000)),
			]),
		).resolves.toBeUndefined();
		expect(Buffer.concat(frames).toString("utf8")).toContain("agent_protocol");
	});

	it("handshakes once and multiplexes stdout/stderr commands on one channel", async () => {
		const { client } = await createClient();
		const seen: Buffer[] = [];
		const first = await client.execute("printf 'out'; printf 'err' >&2", {
			onData: (data) => seen.push(Buffer.from(data)),
		});
		const second = await client.execute("printf 'sudo -i'");
		expect(first).toMatchObject({
			stdout: "out",
			stderr: "err",
			exitCode: 0,
			transport: "agent",
			executionState: "completed",
		});
		expect(second.stdout).toBe("sudo -i");
		expect(Buffer.concat(seen).toString("utf8")).toContain("out");
		expect(client.metadata?.artifactSha256).toBe(manifest.manifest.sha256);
		expect(client.state).toBe("ready");
		await client.close();
	});

	it("keeps terminal operations on the legacy connection while commands use Agent", async () => {
		const { client } = await createClient();
		const legacyAdapter = new FakeSshTmuxAdapter();
		const legacy = await legacyAdapter.connect({ id: "target-test", scope: "session", sshAlias: "test-alias" });
		let bootstrapCount = 0;
		const connection = new AgentSshConnection(legacy, async () => {
			bootstrapCount++;
			return client;
		});
		expect(await connection.tmuxStatus("missing")).toMatchObject({ exists: false });
		expect(bootstrapCount).toBe(0);
		const result = await connection.execute("printf compatibility");
		expect(result).toMatchObject({ stdout: "compatibility", transport: "agent" });
		expect(bootstrapCount).toBe(1);
		expect(connection.transport).toBe("agent");
		await connection.close();
	});

	it("returns a structured completed timeout without replaying the command", async () => {
		const { client } = await createClient();
		await expect(client.execute("sleep 1", { timeoutMs: 20 })).rejects.toMatchObject({
			diagnostic: { code: "remote_timeout", executionState: "completed" },
		});
		await client.close();
	});

	it("classifies an accepted operation as unknown after channel loss", async () => {
		const { client, pair } = await createClient();
		const operation = client.execute("sleep 1");
		const deadline = Date.now() + 2_000;
		while (client.activeOperationCount === 0 && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 5));
		pair.client.disconnect();
		await expect(operation).rejects.toBeInstanceOf(RemoteAgentExecutionError);
		await expect(operation).rejects.toMatchObject({
			diagnostic: { code: "remote_execution_unknown", executionState: "unknown" },
		});
		expect(client.state).toBe("lost");
	});
});
