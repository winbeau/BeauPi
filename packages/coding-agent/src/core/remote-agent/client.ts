import { randomUUID } from "node:crypto";
import {
	type RemoteAgentExecutionReferenceV1,
	type RemoteCommandOptions,
	type RemoteCommandResult,
	RemoteExecutionError,
} from "../remote/types.ts";
import { ContentLengthFrameParser, decodeJsonFrame, FrameWriter } from "./framing.ts";
import {
	type AgentDiagnosticV1,
	type AgentEventV1,
	AgentProtocolError,
	type AgentResponseV1,
	type ExecAcceptedV1,
	type HelloRequestV1,
	type HelloResponseV1,
	parseAgentMessage,
	REMOTE_AGENT_MAX_IN_FLIGHT_REQUESTS,
	REMOTE_AGENT_MAX_OUTPUT_CHUNK_BYTES,
	REMOTE_AGENT_PROTOCOL_VERSION,
	requestMessage,
	validateExecExitEvent,
	validateExecOutputEvent,
} from "./protocol.ts";
import type { RemoteAgentTransport } from "./ssh-transport.ts";

export type RemoteAgentClientState = "idle" | "connecting" | "handshaking" | "ready" | "closing" | "closed" | "lost";

export interface RemoteAgentClientOptions {
	hello: HelloRequestV1;
	expectedArtifactSha256: string;
	transportFactory: (signal?: AbortSignal) => Promise<RemoteAgentTransport>;
	connectTimeoutMs?: number;
	now?: () => number;
}

interface PendingResponse {
	resolve: (response: AgentResponseV1) => void;
	reject: (error: unknown) => void;
}

interface ClientOperation {
	operationId: string;
	requestId: string;
	stdout: Buffer[];
	stderr: Buffer[];
	nextSequence: number;
	dispatchStarted: boolean;
	accepted: boolean;
	startedAt?: number;
	onData?: (data: Buffer) => void;
	cancelSent: boolean;
	settled: boolean;
	resolve: (result: RemoteCommandResult) => void;
	reject: (error: unknown) => void;
}

function safeMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

function acceptedResult(value: unknown): ExecAcceptedV1 {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new AgentProtocolError("agent_protocol", "exec.start response is not an object");
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).some((key) => !["operationId", "pid", "startedAt"].includes(key)) ||
		typeof record.operationId !== "string" ||
		typeof record.pid !== "number" ||
		typeof record.startedAt !== "number"
	)
		throw new AgentProtocolError("agent_protocol", "exec.start response is malformed");
	return { operationId: record.operationId, pid: record.pid, startedAt: record.startedAt };
}

function helloResult(value: unknown): HelloResponseV1 {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new AgentProtocolError("agent_protocol", "system.hello response is not an object");
	const record = value as Record<string, unknown>;
	const expectedKeys = [
		"protocolVersion",
		"agentVersion",
		"artifactSha256",
		"instanceId",
		"pid",
		"platform",
		"arch",
		"nodeVersion",
		"homeDir",
		"workspaceCwd",
		"capabilities",
		"limits",
	];
	if (Object.keys(record).some((key) => !expectedKeys.includes(key)) || expectedKeys.some((key) => !(key in record)))
		throw new AgentProtocolError("agent_protocol", "system.hello response contains an unknown or missing field");
	const limits = record.limits;
	if (
		record.protocolVersion !== REMOTE_AGENT_PROTOCOL_VERSION ||
		typeof record.agentVersion !== "string" ||
		typeof record.artifactSha256 !== "string" ||
		typeof record.instanceId !== "string" ||
		typeof record.pid !== "number" ||
		!Number.isSafeInteger(record.pid) ||
		record.pid <= 0 ||
		typeof record.platform !== "string" ||
		typeof record.arch !== "string" ||
		typeof record.nodeVersion !== "string" ||
		typeof record.homeDir !== "string" ||
		typeof record.workspaceCwd !== "string" ||
		!Array.isArray(record.capabilities) ||
		record.capabilities.some((entry) => entry !== "exec-v1") ||
		typeof limits !== "object" ||
		limits === null ||
		Array.isArray(limits)
	)
		throw new AgentProtocolError("agent_protocol", "system.hello response is malformed");
	const limitRecord = limits as Record<string, unknown>;
	const limitKeys = ["maxFrameBytes", "maxConcurrentExec", "maxQueuedExec"];
	if (
		Object.keys(limitRecord).some((key) => !limitKeys.includes(key)) ||
		limitKeys.some((key) => !(key in limitRecord)) ||
		typeof limitRecord.maxFrameBytes !== "number" ||
		typeof limitRecord.maxConcurrentExec !== "number" ||
		typeof limitRecord.maxQueuedExec !== "number" ||
		!Number.isSafeInteger(limitRecord.maxFrameBytes) ||
		!Number.isSafeInteger(limitRecord.maxConcurrentExec) ||
		!Number.isSafeInteger(limitRecord.maxQueuedExec) ||
		limitRecord.maxFrameBytes <= 0 ||
		limitRecord.maxConcurrentExec <= 0 ||
		limitRecord.maxQueuedExec < 0
	)
		throw new AgentProtocolError("agent_protocol", "system.hello limits are malformed");
	if (!/^[a-f0-9]{64}$/.test(record.artifactSha256))
		throw new AgentProtocolError("artifact_mismatch", "Agent hello returned an invalid artifact hash");
	return {
		protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
		agentVersion: record.agentVersion,
		artifactSha256: record.artifactSha256,
		instanceId: record.instanceId,
		pid: record.pid,
		platform: record.platform,
		arch: record.arch,
		nodeVersion: record.nodeVersion,
		homeDir: record.homeDir,
		workspaceCwd: record.workspaceCwd,
		capabilities: ["exec-v1"],
		limits: {
			maxFrameBytes: limitRecord.maxFrameBytes,
			maxConcurrentExec: limitRecord.maxConcurrentExec,
			maxQueuedExec: limitRecord.maxQueuedExec,
		},
	};
}

function agentReference(
	metadata: HelloResponseV1 | undefined,
	operationId: string,
): RemoteAgentExecutionReferenceV1 | undefined {
	if (!metadata) return undefined;
	return {
		protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
		artifactSha256: metadata.artifactSha256,
		instanceId: metadata.instanceId,
		operationId,
	};
}

export class RemoteAgentExecutionError extends RemoteExecutionError {
	readonly result: RemoteCommandResult;

	constructor(diagnostic: RemoteExecutionError["diagnostic"], result: RemoteCommandResult) {
		super(diagnostic, result);
		this.result = result;
	}
}

export class RemoteAgentClient {
	private readonly options: RemoteAgentClientOptions;
	private readonly now: () => number;
	private stateValue: RemoteAgentClientState = "idle";
	private connectPromise: Promise<void> | undefined;
	private transport: RemoteAgentTransport | undefined;
	private writer: FrameWriter | undefined;
	private readonly parser = new ContentLengthFrameParser();
	private readonly pendingResponses = new Map<string, PendingResponse>();
	private readonly operations = new Map<string, ClientOperation>();
	private metadataValue: HelloResponseV1 | undefined;
	private closePromise: Promise<void> | undefined;

	constructor(options: RemoteAgentClientOptions) {
		this.options = options;
		this.now = options.now ?? (() => Date.now());
	}

	get state(): RemoteAgentClientState {
		return this.stateValue;
	}

	get metadata(): HelloResponseV1 | undefined {
		return this.metadataValue ? structuredClone(this.metadataValue) : undefined;
	}

	get activeOperationCount(): number {
		return this.operations.size;
	}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.stateValue === "ready") return;
		if (this.stateValue === "lost" || this.stateValue === "closed")
			throw this.connectionError("Agent connection is not reusable");
		if (this.connectPromise) return this.connectPromise;
		this.connectPromise = this.connectInternal(signal).finally(() => {
			this.connectPromise = undefined;
		});
		return this.connectPromise;
	}

	async execute(command: string, options: RemoteCommandOptions = {}): Promise<RemoteCommandResult> {
		await this.connect(options.signal);
		if (this.stateValue !== "ready") throw this.connectionError("Agent connection is not ready");
		if (this.operations.size >= REMOTE_AGENT_MAX_IN_FLIGHT_REQUESTS)
			throw new RemoteAgentExecutionError(
				{
					code: "agent_busy",
					message: "Agent request limit is full",
					retryable: true,
					executionState: "not_started",
				},
				this.emptyResult("", "not_started"),
			);
		const operationId = `op-${randomUUID()}`;
		const requestId = `req-${randomUUID()}`;
		let resolveOperation!: (result: RemoteCommandResult) => void;
		let rejectOperation!: (error: unknown) => void;
		const resultPromise = new Promise<RemoteCommandResult>((resolve, reject) => {
			resolveOperation = resolve;
			rejectOperation = reject;
		});
		const operation: ClientOperation = {
			operationId,
			requestId,
			stdout: [],
			stderr: [],
			nextSequence: 0,
			dispatchStarted: false,
			accepted: false,
			onData: options.onData,
			cancelSent: false,
			settled: false,
			resolve: resolveOperation,
			reject: rejectOperation,
		};
		this.operations.set(operationId, operation);
		const onAbort = (): void => {
			void this.cancel(operation).catch(() => undefined);
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const response = await this.sendRequest(
				"exec.start",
				{
					operationId,
					command,
					cwd: options.cwd ?? this.options.hello.workspaceCwd ?? ".",
					...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
				},
				requestId,
				undefined,
				() => {
					operation.dispatchStarted = true;
				},
			);
			if (!response.ok) throw this.errorFromDiagnostic(response.diagnostic, operation);
			const accepted = acceptedResult(response.result);
			if (accepted.operationId !== operationId)
				throw new AgentProtocolError("agent_protocol", "exec.start response operation ID differs");
			operation.accepted = true;
			operation.startedAt = accepted.startedAt;
			if (options.signal?.aborted) await this.cancel(operation);
			return await resultPromise;
		} catch (error) {
			if (!operation.settled) {
				operation.settled = true;
				this.operations.delete(operationId);
				if (error instanceof RemoteAgentExecutionError) operation.reject(error);
				else if (error instanceof RemoteExecutionError) operation.reject(error);
				else operation.reject(this.errorFromUnknown(error, operation));
			}
			return await resultPromise;
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
		}
	}

	async ping(): Promise<unknown> {
		await this.connect();
		const response = await this.sendRequest("system.ping", {
			nonce: `ping-${randomUUID()}`,
			clientTimestamp: this.now(),
		});
		if (!response.ok) throw this.errorFromDiagnostic(response.diagnostic);
		return response.result;
	}

	async close(): Promise<void> {
		this.closePromise ??= this.closeInternal();
		await this.closePromise;
	}

	private async connectInternal(signal?: AbortSignal): Promise<void> {
		this.stateValue = "connecting";
		let transport: RemoteAgentTransport;
		try {
			transport = await this.options.transportFactory(signal);
		} catch (error) {
			this.stateValue = "lost";
			throw this.errorFromUnknown(error);
		}
		this.transport = transport;
		this.writer = new FrameWriter(transport.stdin);
		this.stateValue = "handshaking";
		transport.stdout.on("data", (chunk: Buffer | string) => this.onData(chunk));
		transport.stdout.once("end", () => this.onTransportLost("Agent stdout closed"));
		transport.stdout.once("close", () => this.onTransportLost("Agent stdout closed"));
		transport.stdout.once("error", (error) => this.onTransportLost(safeMessage(error)));
		transport.stderr.on("data", () => undefined);
		const timeoutMs = Math.max(1, Math.floor(this.options.connectTimeoutMs ?? 15_000));
		try {
			const response = await this.withTimeout(
				this.sendRequest("system.hello", this.options.hello),
				timeoutMs,
				"Agent hello timed out",
			);
			if (!response.ok) throw this.errorFromDiagnostic(response.diagnostic);
			const metadata = helloResult(response.result);
			if (metadata.artifactSha256 !== this.options.expectedArtifactSha256)
				throw new RemoteExecutionError({
					code: "agent_version_mismatch",
					message: "Remote Agent artifact hash does not match the local manifest",
					retryable: false,
					executionState: "not_started",
				});
			if (!metadata.capabilities.includes("exec-v1"))
				throw new RemoteExecutionError({
					code: "agent_capability_unavailable",
					message: "Remote Agent does not support exec-v1",
					retryable: false,
					executionState: "not_started",
				});
			this.metadataValue = metadata;
			this.stateValue = "ready";
		} catch (error) {
			await transport.close().catch(() => undefined);
			this.stateValue = "lost";
			throw error instanceof RemoteExecutionError ? error : this.errorFromUnknown(error);
		}
	}

	private onData(chunk: Buffer | string): void {
		if (this.stateValue === "closed") return;
		let frames: Buffer[];
		try {
			frames = this.parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		} catch (error) {
			this.onTransportLost(safeMessage(error));
			return;
		}
		for (const frame of frames) {
			try {
				this.handleMessage(parseAgentMessage(decodeJsonFrame(frame)));
			} catch (error) {
				this.onTransportLost(safeMessage(error));
				return;
			}
		}
	}

	private handleMessage(message: ReturnType<typeof parseAgentMessage>): void {
		if (message.type === "response") {
			const pending = this.pendingResponses.get(message.requestId);
			if (!pending) return;
			this.pendingResponses.delete(message.requestId);
			pending.resolve(message);
			return;
		}
		if (message.type !== "event") return;
		if (message.event === "exec.output") this.handleOutput(message);
		else this.handleExit(message);
	}

	private handleOutput(message: AgentEventV1): void {
		const operation = this.operations.get(message.operationId ?? "");
		if (!operation || message.sequence === undefined)
			throw new AgentProtocolError("agent_protocol", "Output event refers to an unknown operation");
		const payload = validateExecOutputEvent(message.payload);
		if (message.sequence !== operation.nextSequence || payload.sequence !== operation.nextSequence)
			throw new AgentProtocolError("agent_protocol", "Output event sequence is not contiguous", {
				operationId: operation.operationId,
			});
		if (payload.operationId !== operation.operationId)
			throw new AgentProtocolError("agent_protocol", "Output event operation ID differs", {
				operationId: operation.operationId,
			});
		const data = Buffer.from(payload.dataBase64, "base64");
		if (data.length > REMOTE_AGENT_MAX_OUTPUT_CHUNK_BYTES)
			throw new AgentProtocolError("agent_protocol", "Output event exceeds decoded size limit", {
				operationId: operation.operationId,
			});
		if (payload.stream === "stdout") operation.stdout.push(data);
		else operation.stderr.push(data);
		operation.nextSequence++;
		try {
			operation.onData?.(data);
		} catch {
			// A caller's output observer is non-authoritative.
		}
	}

	private handleExit(message: AgentEventV1): void {
		const operation = this.operations.get(message.operationId ?? "");
		if (!operation || message.sequence === undefined)
			throw new AgentProtocolError("agent_protocol", "Exit event refers to an unknown operation");
		if (message.sequence !== operation.nextSequence)
			throw new AgentProtocolError("agent_protocol", "Exit event sequence is not contiguous", {
				operationId: operation.operationId,
			});
		const payload = validateExecExitEvent(message.payload);
		if (payload.operationId !== operation.operationId)
			throw new AgentProtocolError("agent_protocol", "Exit event operation ID differs", {
				operationId: operation.operationId,
			});
		operation.nextSequence++;
		const result: RemoteCommandResult = {
			stdout: Buffer.concat(operation.stdout).toString("utf8"),
			stderr: Buffer.concat(operation.stderr).toString("utf8"),
			exitCode: payload.exitCode,
			startedAt: operation.startedAt ?? payload.startedAt,
			completedAt: payload.completedAt,
			transport: "agent",
			executionState: "completed",
			agent: agentReference(this.metadataValue, operation.operationId),
		};
		operation.settled = true;
		this.operations.delete(operation.operationId);
		if (payload.cancelled || payload.timedOut) {
			const diagnostic: RemoteExecutionError["diagnostic"] = {
				code: payload.cancelled ? "remote_cancelled" : "remote_timeout",
				message: payload.cancelled ? "Remote Agent command was cancelled" : "Remote Agent command timed out",
				targetId: this.options.hello.targetId,
				operationId: operation.operationId,
				retryable: payload.timedOut,
				executionState: "completed",
				transport: "agent",
				agent: result.agent,
			};
			operation.reject(new RemoteAgentExecutionError(diagnostic, result));
			return;
		}
		operation.resolve(result);
	}

	private async cancel(operation: ClientOperation): Promise<void> {
		if (operation.settled || operation.cancelSent) return;
		operation.cancelSent = true;
		if (this.stateValue !== "ready") return;
		try {
			const response = await this.sendRequest("exec.cancel", { operationId: operation.operationId });
			if (!response.ok && response.diagnostic?.code !== "operation_not_found")
				throw this.errorFromDiagnostic(response.diagnostic, operation);
		} catch {
			// A simultaneous channel loss is classified by onTransportLost as unknown.
		}
	}

	private async sendRequest(
		method: "system.hello" | "system.ping" | "exec.start" | "exec.cancel" | "session.shutdown",
		payload: unknown,
		requestId = `req-${randomUUID()}`,
		timeoutMs?: number,
		onWriteStart?: () => void,
	): Promise<AgentResponseV1> {
		if (!this.writer) throw this.connectionError("Agent frame writer is unavailable");
		if (this.pendingResponses.size >= REMOTE_AGENT_MAX_IN_FLIGHT_REQUESTS)
			throw this.connectionError("Agent request limit is full");
		const message = requestMessage(requestId, method, payload);
		const responsePromise = new Promise<AgentResponseV1>((resolve, reject) => {
			this.pendingResponses.set(requestId, { resolve, reject });
		});
		try {
			await this.writer.write(message, onWriteStart);
			return await (timeoutMs === undefined
				? responsePromise
				: this.withTimeout(responsePromise, Math.max(1, Math.floor(timeoutMs)), "Remote Agent request timed out"));
		} finally {
			this.pendingResponses.delete(requestId);
		}
	}

	private onTransportLost(message: string): void {
		if (this.stateValue === "closed" || this.stateValue === "closing" || this.stateValue === "lost") return;
		this.stateValue = "lost";
		const diagnostic: RemoteExecutionError["diagnostic"] = {
			code: "agent_disconnected",
			message: safeMessage(message),
			targetId: this.options.hello.targetId,
			retryable: true,
			executionState: "unknown",
			transport: "agent",
		};
		for (const pending of this.pendingResponses.values())
			pending.reject(new RemoteExecutionError({ ...diagnostic, executionState: "not_started" }));
		this.pendingResponses.clear();
		for (const operation of this.operations.values()) {
			const state = operation.accepted || operation.dispatchStarted ? "unknown" : "not_started";
			const result = this.emptyResult(operation.operationId, state, operation);
			operation.settled = true;
			operation.reject(
				new RemoteAgentExecutionError(
					{
						...diagnostic,
						code: state === "unknown" ? "remote_execution_unknown" : "agent_disconnected",
						executionState: state,
						operationId: operation.operationId,
						agent: result.agent,
					},
					result,
				),
			);
		}
		this.operations.clear();
	}

	private async closeInternal(): Promise<void> {
		const wasReady = this.stateValue === "ready";
		this.stateValue = this.stateValue === "closed" ? "closed" : "closing";
		for (const operation of this.operations.values()) {
			if (!operation.settled) {
				const result = this.emptyResult(operation.operationId, "unknown", operation);
				operation.settled = true;
				operation.reject(
					new RemoteAgentExecutionError(
						{
							code: "remote_execution_unknown",
							message: "Agent connection closed before command completion",
							retryable: false,
							executionState: "unknown",
							operationId: operation.operationId,
							transport: "agent",
							agent: result.agent,
						},
						result,
					),
				);
			}
		}
		this.operations.clear();
		if (wasReady) {
			await this.sendRequest("session.shutdown", {}, `req-${randomUUID()}`, 2_000).catch(() => undefined);
		}
		await this.transport?.close().catch(() => undefined);
		this.writer?.close();
		this.stateValue = "closed";
	}

	private connectionError(message: string): RemoteExecutionError {
		return new RemoteExecutionError({
			code: "agent_disconnected",
			message,
			targetId: this.options.hello.targetId,
			retryable: true,
			executionState: "not_started",
			transport: "agent",
		});
	}

	private errorFromDiagnostic(
		diagnostic: AgentDiagnosticV1 | undefined,
		operation?: ClientOperation,
	): RemoteExecutionError {
		const state = diagnostic?.executionState ?? (operation?.accepted ? "unknown" : "not_started");
		return new RemoteExecutionError({
			code: (diagnostic?.code as RemoteExecutionError["diagnostic"]["code"]) ?? "agent_protocol",
			message: diagnostic?.message ?? "Remote Agent request failed",
			targetId: this.options.hello.targetId,
			operationId: diagnostic?.operationId ?? operation?.operationId,
			retryable: diagnostic?.retryable ?? false,
			executionState: state,
			transport: "agent",
		});
	}

	private errorFromUnknown(error: unknown, operation?: ClientOperation): RemoteExecutionError {
		if (error instanceof RemoteExecutionError) return error;
		return new RemoteExecutionError({
			code: "agent_startup",
			message: safeMessage(error),
			targetId: this.options.hello.targetId,
			operationId: operation?.operationId,
			retryable: true,
			executionState: operation?.accepted || operation?.dispatchStarted ? "unknown" : "not_started",
			transport: "agent",
		});
	}

	private emptyResult(
		operationId: string,
		executionState: "not_started" | "unknown",
		operation?: ClientOperation,
	): RemoteCommandResult {
		return {
			stdout: operation ? Buffer.concat(operation.stdout).toString("utf8") : "",
			stderr: operation ? Buffer.concat(operation.stderr).toString("utf8") : "",
			exitCode: null,
			startedAt: operation?.startedAt ?? this.now(),
			completedAt: this.now(),
			transport: "agent",
			executionState,
			agent: agentReference(this.metadataValue, operationId),
		};
	}

	private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(
				() =>
					reject(
						new RemoteExecutionError({
							code: "agent_startup",
							message,
							targetId: this.options.hello.targetId,
							retryable: true,
							executionState: "not_started",
							transport: "agent",
						}),
					),
				timeoutMs,
			);
			promise.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(error: unknown) => {
					clearTimeout(timer);
					reject(error);
				},
			);
		});
	}
}
