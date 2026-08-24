import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { arch, platform, versions } from "node:process";
import type { Readable, Writable } from "node:stream";
import { ContentLengthFrameParser, decodeJsonFrame, FrameWriter } from "../core/remote-agent/framing.ts";
import {
	type AgentDiagnosticV1,
	type AgentEventV1,
	AgentProtocolError,
	type AgentRequestV1,
	type AgentResponseV1,
	type ExecCancelResponseV1,
	type ExecExitEventV1,
	type ExecOutputEventV1,
	errorResponse,
	eventMessage,
	type HelloResponseV1,
	type PingResponseV1,
	parseAgentMessage,
	REMOTE_AGENT_MAX_CONCURRENT_EXEC,
	REMOTE_AGENT_MAX_FRAME_BYTES,
	REMOTE_AGENT_MAX_IN_FLIGHT_REQUESTS,
	REMOTE_AGENT_MAX_QUEUED_EXEC,
	REMOTE_AGENT_PROTOCOL_VERSION,
	responseMessage,
	validateExecCancelRequest,
	validateExecStartRequest,
	validateHelloRequest,
	validatePingRequest,
} from "../core/remote-agent/protocol.ts";
import { ExecService, ExecServiceError } from "./exec-service.ts";

export interface AgentServerOptions {
	artifactSha256: string;
	agentVersion?: string;
	instanceId?: string;
	workspaceCwd?: string;
	maxConcurrentExec?: number;
	maxQueuedExec?: number;
	execService?: ExecService;
	now?: () => number;
}

function safeMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

function emptyPayload(value: unknown): void {
	if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 0) {
		throw new AgentProtocolError("agent_protocol", "This method requires an empty object payload");
	}
}

function diagnosticForError(error: unknown, requestId?: string, operationId?: string): AgentDiagnosticV1 {
	if (error instanceof AgentProtocolError) {
		return {
			...error.diagnostic,
			requestId: error.diagnostic.requestId ?? requestId,
			operationId: error.diagnostic.operationId ?? operationId,
		};
	}
	if (error instanceof ExecServiceError) {
		return {
			...error.diagnostic,
			requestId: error.diagnostic.requestId ?? requestId,
			operationId: error.diagnostic.operationId ?? operationId,
		};
	}
	return {
		code: "agent_internal",
		message: safeMessage(error),
		retryable: false,
		requestId,
		operationId,
		executionState: "not_started",
	};
}

export class AgentServer {
	private readonly artifactSha256: string;
	private readonly agentVersion: string;
	private readonly instanceId: string;
	private readonly defaultWorkspaceCwd?: string;
	private readonly execService: ExecService;
	private readonly maxConcurrentExec: number;
	private readonly maxQueuedExec: number;
	private readonly now: () => number;
	private readonly parser = new ContentLengthFrameParser();
	private writer: FrameWriter | undefined;
	private readonly requestIds = new Set<string>();
	private readonly inFlightRequests = new Set<string>();
	private readonly pendingExecStarts = new Map<string, "preparing" | "registered" | "cancelled">();
	private readonly eventSequences = new Map<string, number>();
	private helloComplete = false;
	private shuttingDown = false;
	private closed = false;
	private input: Readable | undefined;
	private output: Writable | undefined;
	private closePromise: Promise<void> | undefined;
	private resolveRun: (() => void) | undefined;

	constructor(options: AgentServerOptions) {
		if (!/^[a-f0-9]{64}$/.test(options.artifactSha256))
			throw new AgentProtocolError("agent_artifact", "Agent server requires a valid artifact SHA-256 digest");
		this.artifactSha256 = options.artifactSha256;
		this.agentVersion = options.agentVersion ?? "mvp-a";
		this.instanceId = options.instanceId ?? `agent-${randomUUID()}`;
		this.defaultWorkspaceCwd = options.workspaceCwd;
		this.now = options.now ?? (() => Date.now());
		this.maxConcurrentExec = Math.max(1, Math.floor(options.maxConcurrentExec ?? REMOTE_AGENT_MAX_CONCURRENT_EXEC));
		this.maxQueuedExec = Math.max(0, Math.floor(options.maxQueuedExec ?? REMOTE_AGENT_MAX_QUEUED_EXEC));
		this.execService =
			options.execService ??
			new ExecService({
				maxConcurrentExec: this.maxConcurrentExec,
				maxQueuedExec: this.maxQueuedExec,
				now: this.now,
			});
	}

	get activeOperations(): number {
		return this.execService.activeCount;
	}

	get queueDepth(): number {
		return this.execService.queueDepth;
	}

	async run(input: Readable, output: Writable): Promise<void> {
		if (this.input || this.output) throw new Error("Agent server can only be run once");
		this.input = input;
		this.output = output;
		this.writer = new FrameWriter(output);
		await new Promise<void>((resolveRun) => {
			this.resolveRun = resolveRun;
			const finishRun = (): void => {
				if (this.resolveRun === resolveRun) this.resolveRun = undefined;
				resolveRun();
			};
			const onData = (chunk: Buffer | string): void => {
				if (this.closed) return;
				let frames: Buffer[];
				try {
					frames = this.parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				} catch (error) {
					void this.protocolFailure(diagnosticForError(error));
					return;
				}
				for (const frame of frames) void this.handleFrame(frame).catch(() => undefined);
			};
			const onEnd = (): void => {
				if (this.closed) {
					finishRun();
					return;
				}
				try {
					this.parser.end();
				} catch (error) {
					void this.protocolFailure(diagnosticForError(error));
					return;
				}
				void this.close().then(finishRun);
			};
			const onError = (): void => void this.close().then(finishRun);
			input.on("data", onData);
			input.once("end", onEnd);
			input.once("error", onError);
		});
	}

	async close(): Promise<void> {
		this.closePromise ??= (async () => {
			if (this.closed) return;
			this.closed = true;
			this.shuttingDown = true;
			await this.execService.shutdown();
			this.writer?.close();
		})();
		await this.closePromise;
	}

	private async protocolFailure(diagnostic: AgentDiagnosticV1): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const writer = this.writer;
		if (writer) {
			await writer
				.write(
					errorResponse(diagnostic.requestId ?? "protocol-error", {
						...diagnostic,
						code: diagnostic.code === "agent_internal" ? "agent_protocol" : diagnostic.code,
					}),
				)
				.catch(() => undefined);
		}
		this.shuttingDown = true;
		await this.execService.shutdown();
		await writer?.flush().catch(() => undefined);
		writer?.close();
		this.output?.end();
		this.input?.destroy();
		this.resolveRun?.();
		this.resolveRun = undefined;
	}

	private async handleFrame(frame: Buffer): Promise<void> {
		if (this.closed) return;
		let message: ReturnType<typeof parseAgentMessage>;
		try {
			message = parseAgentMessage(decodeJsonFrame(frame));
		} catch (error) {
			await this.protocolFailure(diagnosticForError(error));
			return;
		}
		if (message.type !== "request") {
			await this.sendError("protocol-error", {
				code: "agent_protocol",
				message: "Agent server accepts requests only",
				retryable: false,
			});
			return;
		}
		if (this.requestIds.has(message.requestId)) {
			await this.sendError(message.requestId, {
				code: "duplicate_request_id",
				message: "Request ID was already used on this channel",
				retryable: false,
				requestId: message.requestId,
			});
			return;
		}
		if (this.inFlightRequests.size >= REMOTE_AGENT_MAX_IN_FLIGHT_REQUESTS) {
			await this.sendError(message.requestId, {
				code: "agent_busy",
				message: "Agent request limit is full",
				retryable: true,
				requestId: message.requestId,
			});
			return;
		}
		this.requestIds.add(message.requestId);
		this.inFlightRequests.add(message.requestId);
		try {
			await this.handleRequest(message);
		} finally {
			this.inFlightRequests.delete(message.requestId);
		}
	}

	private async handleRequest(request: AgentRequestV1): Promise<void> {
		if (this.shuttingDown && request.method !== "session.shutdown") {
			await this.sendError(request.requestId, {
				code: "agent_disconnected",
				message: "Agent is shutting down",
				retryable: false,
				requestId: request.requestId,
			});
			return;
		}
		if (!this.helloComplete && request.method !== "system.hello") {
			await this.sendError(request.requestId, {
				code: "agent_protocol",
				message: "system.hello must complete before other methods",
				retryable: false,
				requestId: request.requestId,
			});
			return;
		}
		try {
			switch (request.method) {
				case "system.hello":
					await this.handleHello(request);
					return;
				case "system.ping":
					await this.handlePing(request);
					return;
				case "exec.start":
					await this.handleExecStart(request);
					return;
				case "exec.cancel":
					await this.handleExecCancel(request);
					return;
				case "session.shutdown":
					await this.handleShutdown(request);
					return;
			}
		} catch (error) {
			await this.sendError(request.requestId, diagnosticForError(error, request.requestId));
		}
	}

	private async handleHello(request: AgentRequestV1): Promise<void> {
		if (this.helloComplete) {
			await this.sendError(request.requestId, {
				code: "agent_protocol",
				message: "system.hello may only be called once",
				retryable: false,
				requestId: request.requestId,
			});
			return;
		}
		const hello = validateHelloRequest(request.payload);
		if (hello.targetFingerprint.length !== 64)
			throw new AgentProtocolError("agent_protocol", "targetFingerprint is invalid", {
				requestId: request.requestId,
			});
		const homeDir = homedir();
		const workspaceCwd = resolve(homeDir, hello.workspaceCwd ?? this.defaultWorkspaceCwd ?? ".");
		const result: HelloResponseV1 = {
			protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
			agentVersion: this.agentVersion,
			artifactSha256: this.artifactSha256,
			instanceId: this.instanceId,
			pid: process.pid,
			platform,
			arch,
			nodeVersion: versions.node,
			homeDir,
			workspaceCwd,
			capabilities: ["exec-v1"],
			limits: {
				maxFrameBytes: REMOTE_AGENT_MAX_FRAME_BYTES,
				maxConcurrentExec: this.maxConcurrentExec,
				maxQueuedExec: this.maxQueuedExec,
			},
		};
		this.helloComplete = true;
		await this.send(responseMessage(request.requestId, result));
	}

	private async handlePing(request: AgentRequestV1): Promise<void> {
		const ping = validatePingRequest(request.payload);
		const result: PingResponseV1 = {
			nonce: ping.nonce,
			agentTimestamp: this.now(),
			activeOperations: this.execService.activeCount,
			queueDepth: this.execService.queueDepth,
		};
		await this.send(responseMessage(request.requestId, result));
	}

	private async handleExecStart(request: AgentRequestV1): Promise<void> {
		const exec = validateExecStartRequest(request.payload);
		if (this.pendingExecStarts.has(exec.operationId))
			throw new ExecServiceError("duplicate_operation_id", "Operation ID is already active", exec.operationId);
		this.pendingExecStarts.set(exec.operationId, "preparing");
		const cwd = resolve(homedir(), exec.cwd);
		try {
			const cwdStat = await stat(cwd);
			if (!cwdStat.isDirectory()) throw new Error("cwd is not a directory");
		} catch {
			this.pendingExecStarts.delete(exec.operationId);
			throw new AgentProtocolError("remote_command", "Remote cwd does not exist or is not a directory", {
				requestId: request.requestId,
				operationId: exec.operationId,
			});
		}
		if (this.pendingExecStarts.get(exec.operationId) === "cancelled") {
			this.pendingExecStarts.delete(exec.operationId);
			throw new ExecServiceError("agent_cancelled", "Operation was cancelled before it started", exec.operationId);
		}
		const acceptedPromise = this.execService.start(
			{ ...exec, cwd },
			{
				onOutput: (event) => void this.sendOutput(event).catch(() => undefined),
				onExit: (event) => void this.sendExit(event).catch(() => undefined),
			},
		);
		this.pendingExecStarts.set(exec.operationId, "registered");
		try {
			const accepted = await acceptedPromise;
			await this.send(responseMessage(request.requestId, accepted));
		} finally {
			this.pendingExecStarts.delete(exec.operationId);
		}
	}

	private async handleExecCancel(request: AgentRequestV1): Promise<void> {
		const cancel = validateExecCancelRequest(request.payload);
		let status: ExecCancelResponseV1["status"];
		const pending = this.pendingExecStarts.get(cancel.operationId);
		if (pending === "preparing") {
			this.pendingExecStarts.set(cancel.operationId, "cancelled");
			status = "cancelled";
		} else if (pending === "cancelled") {
			status = "cancelled";
		} else {
			try {
				status = this.execService.cancel(cancel.operationId);
			} catch (_error) {
				throw new AgentProtocolError("operation_not_found", "Operation was not found", {
					requestId: request.requestId,
					operationId: cancel.operationId,
				});
			}
		}
		await this.send(
			responseMessage(request.requestId, { operationId: cancel.operationId, status } satisfies ExecCancelResponseV1),
		);
	}

	private async handleShutdown(request: AgentRequestV1): Promise<void> {
		emptyPayload(request.payload);
		this.shuttingDown = true;
		await this.send(
			responseMessage(request.requestId, {
				accepted: true,
				activeOperations: this.execService.activeCount,
				queueDepth: this.execService.queueDepth,
			}),
		);
		await this.close();
	}

	private async sendOutput(event: ExecOutputEventV1): Promise<void> {
		if (this.closed) return;
		this.eventSequences.set(event.operationId, event.sequence);
		const message = eventMessage("exec.output", event.operationId, event.sequence, event);
		await this.send(message);
	}

	private async sendExit(event: ExecExitEventV1): Promise<void> {
		if (this.closed) return;
		const sequence = (this.eventSequences.get(event.operationId) ?? -1) + 1;
		this.eventSequences.delete(event.operationId);
		await this.send(eventMessage("exec.exit", event.operationId, sequence, event));
	}

	private async send<TResult>(message: AgentResponseV1<TResult> | AgentEventV1): Promise<void> {
		await this.writer?.write(message);
	}

	private async sendError(requestId: string, diagnostic: AgentDiagnosticV1): Promise<void> {
		await this.send(errorResponse(requestId, diagnostic));
	}
}
