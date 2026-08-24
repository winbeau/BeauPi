import {
	type RemoteCommandOptions,
	type RemoteCommandResult,
	type RemoteDiagnosticCode,
	RemoteExecutionError,
	type SshConnection,
	type TmuxCreateOptions,
	type TmuxStatus,
} from "../remote/types.ts";
import type { RemoteAgentClient } from "./client.ts";
import { AgentProtocolError } from "./protocol.ts";

export type AgentClientFactory = (signal?: AbortSignal) => Promise<RemoteAgentClient>;

/** Combines a lazy Agent command channel with the existing local-tmux SSH terminal backend. */
export class AgentSshConnection implements SshConnection {
	readonly connectionId: string;
	readonly targetId: string;
	readonly transport = "agent" as const;

	private readonly legacyTerminal: SshConnection;
	private readonly agentClientFactory: AgentClientFactory;
	private agentClientValue?: RemoteAgentClient;
	private agentPromise?: Promise<RemoteAgentClient>;
	private closed = false;

	constructor(agent: RemoteAgentClient, legacyTerminal: SshConnection);
	constructor(legacyTerminal: SshConnection, agentClientFactory: AgentClientFactory);
	constructor(first: RemoteAgentClient | SshConnection, second: SshConnection | AgentClientFactory) {
		if (typeof second === "function") {
			this.legacyTerminal = first as SshConnection;
			this.agentClientFactory = second;
		} else {
			this.agentClientValue = first as RemoteAgentClient;
			this.legacyTerminal = second;
			this.agentClientFactory = () => Promise.resolve(this.agentClientValue as RemoteAgentClient);
		}
		this.connectionId = `agent-${this.legacyTerminal.connectionId}`;
		this.targetId = this.legacyTerminal.targetId;
	}

	get agentClient(): RemoteAgentClient | undefined {
		return this.agentClientValue;
	}

	private ensureAgent(signal?: AbortSignal): Promise<RemoteAgentClient> {
		if (this.closed)
			return Promise.reject(
				new RemoteExecutionError({
					code: "agent_disconnected",
					message: "Agent connection is closed",
					targetId: this.targetId,
					executionState: "not_started",
					transport: "agent",
				}),
			);
		if (this.agentClientValue) return Promise.resolve(this.agentClientValue);
		if (!this.agentPromise) {
			const promise = Promise.resolve()
				.then(() => this.agentClientFactory(signal))
				.then((client) => {
					if (this.closed) {
						void client.close();
						throw new RemoteExecutionError({
							code: "agent_disconnected",
							message: "Agent connection was closed during bootstrap",
							targetId: this.targetId,
							executionState: "not_started",
							transport: "agent",
						});
					}
					this.agentClientValue = client;
					return client;
				})
				.catch((error: unknown) => {
					if (this.agentPromise === promise) this.agentPromise = undefined;
					if (error instanceof AgentProtocolError) {
						throw new RemoteExecutionError({
							code: error.diagnostic.code as RemoteDiagnosticCode,
							message: error.diagnostic.message,
							targetId: this.targetId,
							retryable: error.diagnostic.retryable,
							executionState: error.diagnostic.executionState ?? "not_started",
							transport: "agent",
						});
					}
					if (error instanceof RemoteExecutionError) {
						throw new RemoteExecutionError({
							...error.diagnostic,
							targetId: error.diagnostic.targetId ?? this.targetId,
							transport: "agent",
						});
					}
					throw error;
				});
			this.agentPromise = promise;
		}
		return this.agentPromise;
	}

	async execute(command: string, options?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		const agent = await this.ensureAgent(options?.signal);
		return agent.execute(command, options);
	}

	tmuxCreate(options: TmuxCreateOptions, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		return this.legacyTerminal.tmuxCreate(options, commandOptions);
	}

	tmuxSend(target: string, input: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		return this.legacyTerminal.tmuxSend(target, input, commandOptions);
	}

	tmuxSendSensitive(target: string, input: Buffer, commandOptions?: RemoteCommandOptions): Promise<void> {
		return this.legacyTerminal.tmuxSendSensitive(target, input, commandOptions);
	}

	tmuxSendKey(target: string, key: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		return this.legacyTerminal.tmuxSendKey(target, key, commandOptions);
	}

	tmuxResize(
		target: string,
		columns: number,
		rows: number,
		commandOptions?: RemoteCommandOptions,
	): Promise<RemoteCommandResult> {
		return this.legacyTerminal.tmuxResize(target, columns, rows, commandOptions);
	}

	tmuxExecute(target: string, command: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		return this.legacyTerminal.tmuxExecute(target, command, commandOptions);
	}

	tmuxCapture(target: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		return this.legacyTerminal.tmuxCapture(target, commandOptions);
	}

	tmuxCaptureStyled(target: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		return this.legacyTerminal.tmuxCaptureStyled(target, commandOptions);
	}

	tmuxCaptureScreen(target: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		return this.legacyTerminal.tmuxCaptureScreen(target, commandOptions);
	}

	tmuxStatus(target: string, commandOptions?: RemoteCommandOptions): Promise<TmuxStatus> {
		return this.legacyTerminal.tmuxStatus(target, commandOptions);
	}

	tmuxClose(sessionId: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult> {
		return this.legacyTerminal.tmuxClose(sessionId, commandOptions);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const closeAgent = this.agentPromise
			? this.agentPromise.then((agent) => agent.close()).catch(() => undefined)
			: this.agentClientValue?.close();
		await closeAgent;
		await this.legacyTerminal.close();
	}
}
