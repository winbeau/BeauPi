import { createHash } from "node:crypto";

export const REMOTE_AGENT_PROTOCOL_VERSION = 1 as const;
export const REMOTE_AGENT_PROTOCOL_NAME = "beaupi-remote-agent" as const;
export const REMOTE_AGENT_MIN_NODE_VERSION = "22.19.0" as const;
export const REMOTE_AGENT_MAX_FRAME_BYTES = 1024 * 1024;
export const REMOTE_AGENT_MAX_HEADER_BYTES = 8 * 1024;
export const REMOTE_AGENT_MAX_OUTPUT_CHUNK_BYTES = 64 * 1024;
export const REMOTE_AGENT_MAX_IN_FLIGHT_REQUESTS = 32;
export const REMOTE_AGENT_MAX_CONCURRENT_EXEC = 4;
export const REMOTE_AGENT_MAX_QUEUED_EXEC = 64;
export const REMOTE_AGENT_MAX_COMMAND_CHARS = 64 * 1024;
export const REMOTE_AGENT_MAX_CWD_CHARS = 4 * 1024;
export const REMOTE_AGENT_MAX_ID_CHARS = 128;
export const REMOTE_AGENT_MAX_DIAGNOSTIC_MESSAGE_CHARS = 500;

export type AgentCapabilityV1 = "exec-v1";
export type AgentMethodV1 = "system.hello" | "system.ping" | "exec.start" | "exec.cancel" | "session.shutdown";
export type AgentEventNameV1 = "exec.output" | "exec.exit";
export type AgentOutputStreamV1 = "stdout" | "stderr";
export type RemoteExecutionState = "not_started" | "running" | "completed" | "unknown";

export interface AgentDiagnosticV1 {
	code: string;
	message: string;
	retryable: boolean;
	executionState?: RemoteExecutionState;
	requestId?: string;
	operationId?: string;
}

export interface AgentRequestV1<TPayload = unknown> {
	version: typeof REMOTE_AGENT_PROTOCOL_VERSION;
	type: "request";
	requestId: string;
	method: AgentMethodV1;
	payload: TPayload;
}

export interface AgentResponseV1<TResult = unknown> {
	version: typeof REMOTE_AGENT_PROTOCOL_VERSION;
	type: "response";
	requestId: string;
	ok: boolean;
	result?: TResult;
	diagnostic?: AgentDiagnosticV1;
}

export interface AgentEventV1<TPayload = unknown> {
	version: typeof REMOTE_AGENT_PROTOCOL_VERSION;
	type: "event";
	event: AgentEventNameV1;
	operationId?: string;
	sequence?: number;
	payload: TPayload;
}

export type AgentMessageV1 = AgentRequestV1 | AgentResponseV1 | AgentEventV1;

export interface HelloRequestV1 {
	protocolVersion: typeof REMOTE_AGENT_PROTOCOL_VERSION;
	clientVersion: string;
	clientSessionId: string;
	clientInstanceId: string;
	targetId: string;
	targetFingerprint: string;
	workspaceCwd?: string;
	capabilities: AgentCapabilityV1[];
}

export interface HelloResponseV1 {
	protocolVersion: typeof REMOTE_AGENT_PROTOCOL_VERSION;
	agentVersion: string;
	artifactSha256: string;
	instanceId: string;
	pid: number;
	platform: string;
	arch: string;
	nodeVersion: string;
	homeDir: string;
	workspaceCwd: string;
	capabilities: AgentCapabilityV1[];
	limits: {
		maxFrameBytes: number;
		maxConcurrentExec: number;
		maxQueuedExec: number;
	};
}

export interface PingRequestV1 {
	nonce: string;
	clientTimestamp: number;
}

export interface PingResponseV1 {
	nonce: string;
	agentTimestamp: number;
	activeOperations: number;
	queueDepth: number;
}

export interface ExecStartRequestV1 {
	operationId: string;
	command: string;
	cwd: string;
	timeoutMs?: number;
}

export interface ExecAcceptedV1 {
	operationId: string;
	pid: number;
	startedAt: number;
}

export interface ExecOutputEventV1 {
	operationId: string;
	sequence: number;
	stream: AgentOutputStreamV1;
	dataBase64: string;
}

export interface ExecExitEventV1 {
	operationId: string;
	exitCode: number | null;
	signal?: string;
	startedAt: number;
	completedAt: number;
	timedOut: boolean;
	cancelled: boolean;
	diagnostic?: AgentDiagnosticV1;
}

export interface ExecCancelRequestV1 {
	operationId: string;
}

export interface ExecCancelResponseV1 {
	operationId: string;
	status: "cancel_requested" | "cancelled" | "completed";
}

export interface ShutdownResponseV1 {
	accepted: true;
	activeOperations: number;
	queueDepth: number;
}

export interface RemoteAgentExecutionReferenceV1 {
	protocolVersion: typeof REMOTE_AGENT_PROTOCOL_VERSION;
	artifactSha256: string;
	instanceId: string;
	operationId: string;
}

export class AgentProtocolError extends Error {
	readonly diagnostic: AgentDiagnosticV1;

	constructor(
		code: string,
		message: string,
		options: { retryable?: boolean; requestId?: string; operationId?: string } = {},
	) {
		super(message);
		this.name = "AgentProtocolError";
		this.diagnostic = {
			code,
			message: limitDiagnosticMessage(message),
			retryable: options.retryable ?? false,
			requestId: options.requestId,
			operationId: options.operationId,
		};
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function limitDiagnosticMessage(message: string): string {
	return message
		.replace(/[\r\n\t]+/g, " ")
		.trim()
		.slice(0, REMOTE_AGENT_MAX_DIAGNOSTIC_MESSAGE_CHARS);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key)) && keys.every((key) => key in value);
}

function hasOptionalKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[],
): boolean {
	const allowed = new Set([...required, ...optional]);
	return Object.keys(value).every((key) => allowed.has(key)) && required.every((key) => key in value);
}

function requireString(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\0")) {
		throw new AgentProtocolError(
			"agent_protocol",
			`${label} must be non-empty ASCII text of at most ${maxLength} characters`,
		);
	}
	return value;
}

function requireId(value: unknown, label: string): string {
	const id = requireString(value, label, REMOTE_AGENT_MAX_ID_CHARS);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
		throw new AgentProtocolError("agent_protocol", `${label} contains unsafe characters`);
	}
	return id;
}

function requireNumber(value: unknown, label: string, minimum = Number.NEGATIVE_INFINITY): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
		throw new AgentProtocolError("agent_protocol", `${label} must be a finite number`);
	}
	return value;
}

function requireInteger(value: unknown, label: string, minimum = Number.MIN_SAFE_INTEGER): number {
	const number = requireNumber(value, label, minimum);
	if (!Number.isSafeInteger(number)) throw new AgentProtocolError("agent_protocol", `${label} must be an integer`);
	return number;
}

function requireBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new AgentProtocolError("agent_protocol", `${label} must be boolean`);
	return value;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new AgentProtocolError("agent_protocol", `${label} must be an object`);
	return value;
}

function requireCapabilityArray(value: unknown, label: string): AgentCapabilityV1[] {
	if (!Array.isArray(value) || value.some((entry) => entry !== "exec-v1")) {
		throw new AgentProtocolError("agent_capability_unavailable", `${label} contains an unsupported capability`);
	}
	return [...new Set(value)] as AgentCapabilityV1[];
}

function requireSha256(value: unknown, label: string): string {
	const hash = requireString(value, label, 64);
	if (!/^[a-f0-9]{64}$/.test(hash))
		throw new AgentProtocolError("agent_protocol", `${label} must be a lowercase SHA-256 digest`);
	return hash;
}

export function validateHelloRequest(value: unknown): HelloRequestV1 {
	const record = requireObject(value, "hello payload");
	if (
		!hasOptionalKeys(
			record,
			[
				"protocolVersion",
				"clientVersion",
				"clientSessionId",
				"clientInstanceId",
				"targetId",
				"targetFingerprint",
				"capabilities",
			],
			["workspaceCwd"],
		)
	) {
		throw new AgentProtocolError("agent_protocol", "hello payload contains an unknown or missing field");
	}
	const protocolVersion = requireInteger(record.protocolVersion, "protocolVersion", 1);
	if (protocolVersion !== REMOTE_AGENT_PROTOCOL_VERSION)
		throw new AgentProtocolError("unsupported_protocol", `Unsupported protocol version ${protocolVersion}`);
	const capabilities = requireCapabilityArray(record.capabilities, "capabilities");
	if (!capabilities.includes("exec-v1"))
		throw new AgentProtocolError("agent_capability_unavailable", "Client does not advertise exec-v1");
	const workspaceCwd =
		record.workspaceCwd === undefined
			? undefined
			: requireString(record.workspaceCwd, "workspaceCwd", REMOTE_AGENT_MAX_CWD_CHARS);
	return {
		protocolVersion,
		clientVersion: requireString(record.clientVersion, "clientVersion", 128),
		clientSessionId: requireId(record.clientSessionId, "clientSessionId"),
		clientInstanceId: requireId(record.clientInstanceId, "clientInstanceId"),
		targetId: requireId(record.targetId, "targetId"),
		targetFingerprint: requireSha256(record.targetFingerprint, "targetFingerprint"),
		...(workspaceCwd === undefined ? {} : { workspaceCwd }),
		capabilities,
	};
}

export function validatePingRequest(value: unknown): PingRequestV1 {
	const record = requireObject(value, "ping payload");
	if (!hasExactKeys(record, ["nonce", "clientTimestamp"]))
		throw new AgentProtocolError("agent_protocol", "ping payload contains an unknown or missing field");
	return {
		nonce: requireId(record.nonce, "nonce"),
		clientTimestamp: requireNumber(record.clientTimestamp, "clientTimestamp"),
	};
}

export function validateExecStartRequest(value: unknown): ExecStartRequestV1 {
	const record = requireObject(value, "exec.start payload");
	if (!hasOptionalKeys(record, ["operationId", "command", "cwd"], ["timeoutMs"]))
		throw new AgentProtocolError("agent_protocol", "exec.start payload contains an unknown or missing field");
	const command = requireString(record.command, "command", REMOTE_AGENT_MAX_COMMAND_CHARS);
	if (command.includes("\0")) throw new AgentProtocolError("agent_protocol", "command cannot contain NUL bytes");
	const cwd = requireString(record.cwd, "cwd", REMOTE_AGENT_MAX_CWD_CHARS);
	if (cwd.includes("\0")) throw new AgentProtocolError("agent_protocol", "cwd cannot contain NUL bytes");
	const timeoutMs = record.timeoutMs === undefined ? undefined : requireInteger(record.timeoutMs, "timeoutMs", 1);
	if (timeoutMs !== undefined && timeoutMs > 86_400_000)
		throw new AgentProtocolError("agent_protocol", "timeoutMs exceeds the supported limit");
	return {
		operationId: requireId(record.operationId, "operationId"),
		command,
		cwd,
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	};
}

export function validateExecCancelRequest(value: unknown): ExecCancelRequestV1 {
	const record = requireObject(value, "exec.cancel payload");
	if (!hasExactKeys(record, ["operationId"]))
		throw new AgentProtocolError("agent_protocol", "exec.cancel payload contains an unknown or missing field");
	return { operationId: requireId(record.operationId, "operationId") };
}

export function validateExecOutputEvent(value: unknown): ExecOutputEventV1 {
	const record = requireObject(value, "exec.output payload");
	if (!hasExactKeys(record, ["operationId", "sequence", "stream", "dataBase64"]))
		throw new AgentProtocolError("agent_protocol", "exec.output payload contains an unknown or missing field");
	const dataBase64 = requireString(record.dataBase64, "dataBase64", REMOTE_AGENT_MAX_OUTPUT_CHUNK_BYTES * 2);
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64))
		throw new AgentProtocolError("agent_protocol", "dataBase64 is invalid");
	const data = Buffer.from(dataBase64, "base64");
	if (data.length > REMOTE_AGENT_MAX_OUTPUT_CHUNK_BYTES)
		throw new AgentProtocolError("agent_protocol", "output event exceeds the decoded size limit");
	return {
		operationId: requireId(record.operationId, "operationId"),
		sequence: requireInteger(record.sequence, "sequence", 0),
		stream:
			record.stream === "stdout" || record.stream === "stderr"
				? record.stream
				: (() => {
						throw new AgentProtocolError("agent_protocol", "stream must be stdout or stderr");
					})(),
		dataBase64,
	};
}

export function validateExecExitEvent(value: unknown): ExecExitEventV1 {
	const record = requireObject(value, "exec.exit payload");
	if (
		!hasOptionalKeys(
			record,
			["operationId", "exitCode", "startedAt", "completedAt", "timedOut", "cancelled"],
			["signal", "diagnostic"],
		)
	)
		throw new AgentProtocolError("agent_protocol", "exec.exit payload contains an unknown or missing field");
	const exitCode = record.exitCode === null ? null : requireInteger(record.exitCode, "exitCode");
	const signal = record.signal === undefined ? undefined : requireString(record.signal, "signal", 32);
	const diagnostic = record.diagnostic === undefined ? undefined : validateDiagnostic(record.diagnostic);
	return {
		operationId: requireId(record.operationId, "operationId"),
		exitCode,
		...(signal === undefined ? {} : { signal }),
		startedAt: requireNumber(record.startedAt, "startedAt"),
		completedAt: requireNumber(record.completedAt, "completedAt"),
		timedOut: requireBoolean(record.timedOut, "timedOut"),
		cancelled: requireBoolean(record.cancelled, "cancelled"),
		...(diagnostic === undefined ? {} : { diagnostic }),
	};
}

export function validateDiagnostic(value: unknown): AgentDiagnosticV1 {
	const record = requireObject(value, "diagnostic");
	if (!hasOptionalKeys(record, ["code", "message", "retryable"], ["executionState", "requestId", "operationId"]))
		throw new AgentProtocolError("agent_protocol", "diagnostic contains an unknown or missing field");
	const executionState = record.executionState;
	if (
		executionState !== undefined &&
		executionState !== "not_started" &&
		executionState !== "running" &&
		executionState !== "completed" &&
		executionState !== "unknown"
	)
		throw new AgentProtocolError("agent_protocol", "diagnostic executionState is invalid");
	const requestId = record.requestId === undefined ? undefined : requireId(record.requestId, "diagnostic.requestId");
	const operationId =
		record.operationId === undefined ? undefined : requireId(record.operationId, "diagnostic.operationId");
	return {
		code: requireString(record.code, "diagnostic.code", 128),
		message: limitDiagnosticMessage(
			requireString(record.message, "diagnostic.message", REMOTE_AGENT_MAX_DIAGNOSTIC_MESSAGE_CHARS),
		),
		retryable: requireBoolean(record.retryable, "diagnostic.retryable"),
		...(executionState === undefined ? {} : { executionState }),
		...(requestId === undefined ? {} : { requestId }),
		...(operationId === undefined ? {} : { operationId }),
	};
}

export function validateAgentRequest(value: unknown): AgentRequestV1 {
	const record = requireObject(value, "request");
	if (!hasExactKeys(record, ["version", "type", "requestId", "method", "payload"]) || record.type !== "request")
		throw new AgentProtocolError("agent_protocol", "request envelope is invalid");
	const version = requireInteger(record.version, "version", 1);
	if (version !== REMOTE_AGENT_PROTOCOL_VERSION)
		throw new AgentProtocolError("unsupported_protocol", `Unsupported protocol version ${version}`);
	const method = record.method;
	if (
		method !== "system.hello" &&
		method !== "system.ping" &&
		method !== "exec.start" &&
		method !== "exec.cancel" &&
		method !== "session.shutdown"
	)
		throw new AgentProtocolError("agent_protocol", "Unknown request method");
	return {
		version,
		type: "request",
		requestId: requireId(record.requestId, "requestId"),
		method,
		payload: record.payload,
	};
}

export function validateAgentResponse(value: unknown): AgentResponseV1 {
	const record = requireObject(value, "response");
	if (
		!hasOptionalKeys(record, ["version", "type", "requestId", "ok"], ["result", "diagnostic"]) ||
		record.type !== "response"
	)
		throw new AgentProtocolError("agent_protocol", "response envelope is invalid");
	const version = requireInteger(record.version, "version", 1);
	if (version !== REMOTE_AGENT_PROTOCOL_VERSION)
		throw new AgentProtocolError("unsupported_protocol", `Unsupported protocol version ${version}`);
	const diagnostic = record.diagnostic === undefined ? undefined : validateDiagnostic(record.diagnostic);
	if (record.ok !== true && record.ok !== false)
		throw new AgentProtocolError("agent_protocol", "response.ok must be boolean");
	if (record.ok && diagnostic !== undefined)
		throw new AgentProtocolError("agent_protocol", "successful response cannot contain a diagnostic");
	if (!record.ok && diagnostic === undefined)
		throw new AgentProtocolError("agent_protocol", "failed response must contain a diagnostic");
	return {
		version,
		type: "response",
		requestId: requireId(record.requestId, "requestId"),
		ok: record.ok,
		...(record.result === undefined ? {} : { result: record.result }),
		...(diagnostic === undefined ? {} : { diagnostic }),
	};
}

export function validateAgentEvent(value: unknown): AgentEventV1 {
	const record = requireObject(value, "event");
	if (
		!hasOptionalKeys(record, ["version", "type", "event", "payload"], ["operationId", "sequence"]) ||
		record.type !== "event"
	)
		throw new AgentProtocolError("agent_protocol", "event envelope is invalid");
	const version = requireInteger(record.version, "version", 1);
	if (version !== REMOTE_AGENT_PROTOCOL_VERSION)
		throw new AgentProtocolError("unsupported_protocol", `Unsupported protocol version ${version}`);
	if (record.event !== "exec.output" && record.event !== "exec.exit")
		throw new AgentProtocolError("agent_protocol", "Unknown event name");
	const operationId = record.operationId === undefined ? undefined : requireId(record.operationId, "operationId");
	const sequence = record.sequence === undefined ? undefined : requireInteger(record.sequence, "sequence", 0);
	if (operationId === undefined) throw new AgentProtocolError("agent_protocol", "event operationId is required");
	if (sequence === undefined) throw new AgentProtocolError("agent_protocol", "event sequence is required");
	if (record.event === "exec.output") {
		const payload = validateExecOutputEvent(record.payload);
		if (payload.operationId !== operationId || payload.sequence !== sequence)
			throw new AgentProtocolError("agent_protocol", "exec.output envelope and payload IDs differ");
		return { version, type: "event", event: record.event, operationId, sequence, payload };
	}
	const payload = validateExecExitEvent(record.payload);
	if (payload.operationId !== operationId)
		throw new AgentProtocolError("agent_protocol", "exec.exit envelope and payload IDs differ");
	return { version, type: "event", event: record.event, operationId, sequence, payload };
}

export function parseAgentMessage(value: unknown): AgentMessageV1 {
	if (!isRecord(value) || typeof value.type !== "string")
		throw new AgentProtocolError("agent_protocol", "message must be an object with a type");
	if (value.type === "request") return validateAgentRequest(value);
	if (value.type === "response") return validateAgentResponse(value);
	if (value.type === "event") return validateAgentEvent(value);
	throw new AgentProtocolError("agent_protocol", "Unknown message type");
}

export function requestMessage<TPayload>(
	requestId: string,
	method: AgentMethodV1,
	payload: TPayload,
): AgentRequestV1<TPayload> {
	return {
		version: REMOTE_AGENT_PROTOCOL_VERSION,
		type: "request",
		requestId: requireId(requestId, "requestId"),
		method,
		payload,
	};
}

export function responseMessage<TResult>(requestId: string, result: TResult): AgentResponseV1<TResult> {
	return {
		version: REMOTE_AGENT_PROTOCOL_VERSION,
		type: "response",
		requestId: requireId(requestId, "requestId"),
		ok: true,
		result,
	};
}

export function errorResponse(requestId: string, diagnostic: AgentDiagnosticV1): AgentResponseV1 {
	return {
		version: REMOTE_AGENT_PROTOCOL_VERSION,
		type: "response",
		requestId: requireId(requestId, "requestId"),
		ok: false,
		diagnostic: validateDiagnostic(diagnostic),
	};
}

export function eventMessage<TPayload>(
	event: AgentEventNameV1,
	operationId: string,
	sequence: number,
	payload: TPayload,
): AgentEventV1<TPayload> {
	return {
		version: REMOTE_AGENT_PROTOCOL_VERSION,
		type: "event",
		event,
		operationId: requireId(operationId, "operationId"),
		sequence: requireInteger(sequence, "sequence", 0),
		payload,
	};
}

export function targetFingerprint(target: {
	sshAlias: string;
	user?: string;
	port?: number;
	remoteCwd?: string;
	connectTimeoutMs?: number;
	controlPersistSeconds?: number;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				sshAlias: target.sshAlias,
				user: target.user,
				port: target.port,
				remoteCwd: target.remoteCwd,
				connectTimeoutMs: target.connectTimeoutMs,
				controlPersistSeconds: target.controlPersistSeconds,
			}),
		)
		.digest("hex");
}

export function compareNodeVersions(actual: string, minimum = REMOTE_AGENT_MIN_NODE_VERSION): number {
	const parse = (value: string): [number, number, number] => {
		const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
		return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
	};
	const left = parse(actual);
	const right = parse(minimum);
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) return (left[index] ?? 0) - (right[index] ?? 0);
	}
	return 0;
}

export function isSupportedNodeVersion(actual: string): boolean {
	return compareNodeVersions(actual) >= 0;
}
