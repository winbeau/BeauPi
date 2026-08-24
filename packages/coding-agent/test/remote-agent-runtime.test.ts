import { describe, expect, it } from "vitest";
import { MonitorRuntime } from "../src/core/monitor/index.ts";
import { ExecutionTargetRegistry, FakeSshTmuxAdapter, RemoteExecutionRuntime } from "../src/core/remote/index.ts";
import type { ExecutionTargetConfig, SshConnection, SshTmuxAdapter } from "../src/core/remote/types.ts";
import {
	AgentServer,
	AgentSshConnection,
	createFakeRemoteAgentTransportPair,
	MemoryRemoteAgentArtifactProvider,
	RemoteAgentClient,
	targetFingerprint,
} from "../src/core/remote-agent/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

class AgentRuntimeAdapter implements SshTmuxAdapter {
	readonly kind = "ssh-tmux" as const;
	private readonly legacy: FakeSshTmuxAdapter;
	private readonly client: RemoteAgentClient;

	constructor(legacy: FakeSshTmuxAdapter, client: RemoteAgentClient) {
		this.legacy = legacy;
		this.client = client;
	}

	async connect(target: ExecutionTargetConfig): Promise<SshConnection> {
		return new AgentSshConnection(this.client, await this.legacy.connect(target));
	}

	setSnapshot(monitorId: string, snapshot: Parameters<FakeSshTmuxAdapter["setSnapshot"]>[1]): void {
		this.legacy.setSnapshot(monitorId, snapshot);
	}

	poll(record: Parameters<FakeSshTmuxAdapter["poll"]>[0]) {
		return this.legacy.poll(record);
	}

	stop(record: Parameters<FakeSshTmuxAdapter["stop"]>[0], _force: boolean) {
		return this.legacy.stop(record);
	}

	async closeTarget(targetId: string): Promise<void> {
		await this.legacy.closeTarget(targetId);
	}
}

describe("RemoteExecutionRuntime Agent transport", () => {
	it("routes command execution through Agent and keeps the shared MonitorRuntime", async () => {
		const cwd = process.cwd();
		const sessionManager = SessionManager.inMemory(cwd);
		const settings = SettingsManager.inMemory({ remote: { commandTransport: "agent" } });
		const target: ExecutionTargetConfig = {
			id: "agent-target",
			scope: "session",
			sshAlias: "agent-alias",
			remoteCwd: cwd,
		};
		const targets = new ExecutionTargetRegistry({ settingsManager: settings, sessionTargets: [target] });
		const monitor = new MonitorRuntime({ sessionId: sessionManager.getSessionId(), cwd, sessionManager });
		const legacy = new FakeSshTmuxAdapter();
		const artifact = await new MemoryRemoteAgentArtifactProvider(Buffer.from("runtime-agent")).load();
		const pair = createFakeRemoteAgentTransportPair();
		const server = new AgentServer({ artifactSha256: artifact.manifest.sha256 });
		void server.run(pair.serverInput, pair.serverOutput);
		const client = new RemoteAgentClient({
			hello: {
				protocolVersion: 1,
				clientVersion: "test",
				clientSessionId: "runtime-session",
				clientInstanceId: "runtime-client",
				targetId: target.id,
				targetFingerprint: targetFingerprint(target),
				workspaceCwd: cwd,
				capabilities: ["exec-v1"],
			},
			expectedArtifactSha256: artifact.manifest.sha256,
			transportFactory: () => Promise.resolve(pair.client),
		});
		const adapter = new AgentRuntimeAdapter(legacy, client);
		const runtime = new RemoteExecutionRuntime({
			cwd,
			sessionId: sessionManager.getSessionId(),
			settingsManager: settings,
			sessionManager,
			targets,
			monitorRuntime: monitor,
			adapter,
		});
		try {
			runtime.selectTarget(target.id);
			const result = await runtime.remoteExec("printf runtime-agent");
			expect(result).toMatchObject({ stdout: "runtime-agent", transport: "agent", executionState: "completed" });
			const records = monitor.list({ kind: "ssh-tmux" });
			expect(
				records.some((record) => record.target.kind === "ssh-tmux" && record.target.transport === "agent"),
			).toBe(true);
			expect(
				records.some(
					(record) => record.target.kind === "ssh-tmux" && record.target.connectionId?.startsWith("agent-"),
				),
			).toBe(true);
		} finally {
			await runtime.close(target.id);
			await server.close();
		}
	});
});
