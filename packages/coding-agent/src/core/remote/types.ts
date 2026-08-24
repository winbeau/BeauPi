import type { MonitorAdapter, MonitorAdapterSnapshot, MonitorRecord, MonitorStopResult } from "../monitor/types.ts";
import type {
	RemoteExecutionState as AgentRemoteExecutionState,
	RemoteAgentExecutionReferenceV1,
} from "../remote-agent/protocol.ts";

export const EXECUTION_TARGET_VERSION = 1;
export const REMOTE_TARGET_SESSION_ENTRY_TYPE = "beaupi.execution.target";

export type ExecutionTargetScope = "user" | "project" | "session";

/** Non-secret configuration for one OpenSSH target. */
export interface ExecutionTargetConfig {
	version?: typeof EXECUTION_TARGET_VERSION;
	id: string;
	label?: string;
	scope: ExecutionTargetScope;
	/** OpenSSH Host alias. This is never expanded into a hostname by BeauPi. */
	sshAlias: string;
	/** Optional OpenSSH login user. Trusted provider-managed targets may use root without authorizing privilege changes. */
	user?: string;
	port?: number;
	/** Default directory used for relative remote paths and tmux sessions; relative values resolve from the remote user's home. */
	remoteCwd?: string;
	connectTimeoutMs?: number;
	controlPersistSeconds?: number;
}

export interface SelectedExecutionTarget extends ExecutionTargetConfig {
	selectedAt: number;
}

export type RemoteCommandTransport = "legacy-ssh" | "agent";
export type RemoteExecutionState = AgentRemoteExecutionState;
export type { RemoteAgentExecutionReferenceV1 };

export type RemoteDiagnosticCode =
	| "target_invalid"
	| "target_not_found"
	| "target_untrusted"
	| "target_not_selected"
	| "target_mismatch"
	| "ssh_authentication"
	| "ssh_host_key"
	| "ssh_connection"
	| "ssh_timeout"
	| "ssh_disconnected"
	| "remote_command"
	| "remote_cancelled"
	| "remote_timeout"
	| "terminal_required"
	| "redundant_privilege"
	| "tmux_unavailable"
	| "terminal_invalid"
	| "terminal_not_found"
	| "terminal_busy"
	| "terminal_session_lost"
	| "terminal_closed"
	| "adapter_unavailable"
	| "agent_bootstrap"
	| "agent_node_unavailable"
	| "agent_node_version"
	| "agent_probe_failed"
	| "agent_install"
	| "agent_install_permission"
	| "agent_install_symlink"
	| "agent_install_size"
	| "agent_install_hash"
	| "agent_install_race"
	| "agent_artifact_missing"
	| "agent_startup"
	| "agent_startup_failed"
	| "agent_protocol"
	| "unsupported_protocol"
	| "agent_artifact"
	| "agent_version_mismatch"
	| "agent_capability_unavailable"
	| "agent_busy"
	| "agent_disconnected"
	| "agent_cancelled"
	| "agent_timeout"
	| "agent_internal"
	| "remote_execution_unknown"
	| "duplicate_request_id"
	| "duplicate_operation_id"
	| "operation_not_found";

export interface RemoteDiagnostic {
	code: RemoteDiagnosticCode;
	message: string;
	targetId?: string;
	operationId?: string;
	exitCode?: number | null;
	retryable?: boolean;
	executionState?: RemoteExecutionState;
	transport?: RemoteCommandTransport;
	agent?: RemoteAgentExecutionReferenceV1;
}

export class RemoteExecutionError extends Error {
	readonly diagnostic: RemoteDiagnostic;
	readonly result?: RemoteCommandResult;

	constructor(diagnostic: RemoteDiagnostic, result?: RemoteCommandResult) {
		super(diagnostic.message);
		this.name = "RemoteExecutionError";
		this.diagnostic = diagnostic;
		this.result = result;
	}
}

export interface RemoteCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	startedAt: number;
	completedAt: number;
	transport?: RemoteCommandTransport;
	executionState?: RemoteExecutionState;
	agent?: RemoteAgentExecutionReferenceV1;
}

export interface RemoteCommandOptions {
	onData?: (data: Buffer) => void;
	signal?: AbortSignal;
	timeoutMs?: number;
	cwd?: string;
}

export interface TmuxCreateOptions {
	sessionId: string;
	cwd: string;
	command?: string;
	columns?: number;
	rows?: number;
}

export interface TmuxStatus {
	exists: boolean;
	attached: boolean;
	paneId?: string;
	currentCommand?: string;
	cursorY?: number;
	lastActivityAt?: number;
	dead?: boolean;
	exitCode?: number;
}

export interface SshConnection {
	readonly connectionId: string;
	readonly targetId: string;
	readonly transport?: RemoteCommandTransport;
	execute(command: string, options?: RemoteCommandOptions): Promise<RemoteCommandResult>;
	tmuxCreate(options: TmuxCreateOptions, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult>;
	tmuxSend(target: string, input: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult>;
	tmuxSendSensitive(target: string, input: Buffer, commandOptions?: RemoteCommandOptions): Promise<void>;
	tmuxSendKey(target: string, key: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult>;
	tmuxResize(
		target: string,
		columns: number,
		rows: number,
		commandOptions?: RemoteCommandOptions,
	): Promise<RemoteCommandResult>;
	tmuxExecute(target: string, command: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult>;
	tmuxCapture(target: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult>;
	tmuxCaptureStyled(target: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult>;
	tmuxCaptureScreen(target: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult>;
	tmuxStatus(target: string, commandOptions?: RemoteCommandOptions): Promise<TmuxStatus>;
	tmuxClose(sessionId: string, commandOptions?: RemoteCommandOptions): Promise<RemoteCommandResult>;
	close(): Promise<void>;
}

export interface SshTmuxAdapter extends MonitorAdapter {
	readonly kind: "ssh-tmux";
	connect(target: ExecutionTargetConfig, signal?: AbortSignal): Promise<SshConnection>;
	setSnapshot(monitorId: string, snapshot: MonitorAdapterSnapshot): void;
}

export interface SshTmuxMonitorTarget {
	kind: "ssh-tmux";
	targetId: string;
	resource: "connection" | "command" | "terminal";
	operationId: string;
	sessionId?: string;
	logPath?: string;
	transport?: RemoteCommandTransport;
	connectionId?: string;
}

export interface RemoteOperationResult<T> {
	ok: boolean;
	value?: T;
	diagnostic?: RemoteDiagnostic;
	monitorId?: string;
}

export interface RemoteConnectionSnapshot {
	connection: SshConnection;
	target: ExecutionTargetConfig;
}

export type RemoteMonitorRecord = MonitorRecord & {
	target: SshTmuxMonitorTarget;
};

export type RemoteMonitorStopResult = MonitorStopResult;
