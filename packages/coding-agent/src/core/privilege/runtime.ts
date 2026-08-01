import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { MonitorRuntime } from "../monitor/monitor-runtime.ts";
import { inspectShellPrivilege } from "../policy/index.ts";
import {
	type ReviewedTerminalOutput,
	reviewTerminalOutput,
	type TerminalOutputReviewer,
} from "../remote/output-reviewer.ts";
import { truncateTail } from "../tools/truncate.ts";
import type {
	PendingPrivilegeInteraction,
	PrivilegeAuditEventTypeV1,
	PrivilegeAuditEventV1,
	PrivilegeAuditWriter,
	PrivilegeCommandResultV1,
	PrivilegeCommandSession,
	PrivilegeDiagnosticV1,
	PrivilegeExecuteInputV1,
	PrivilegeInteractionHandler,
	PrivilegeInteractionResponse,
	PrivilegeRequestStateV1,
	PrivilegeRequestV1,
	PrivilegeResultStatusV1,
	PrivilegeTerminalAdapter,
	PrivilegeTerminalControl,
	PrivilegeToolDetailsV1,
} from "./types.ts";

export interface PrivilegeRuntimeOptions {
	sessionId: string;
	cwd: string;
	terminalAdapter: PrivilegeTerminalAdapter;
	auditWriter: PrivilegeAuditWriter;
	handler?: PrivilegeInteractionHandler;
	now?: () => Date;
	isRootTarget?: (targetId: string | undefined) => boolean;
	monitorRuntime?: Pick<MonitorRuntime, "attach" | "update">;
	outputReviewer?: TerminalOutputReviewer;
}

interface ActivePrivilegeRequest {
	request: PrivilegeRequestV1;
	state: PrivilegeRequestStateV1;
	controller: AbortController;
	session?: PrivilegeCommandSession;
	result?: PrivilegeCommandResultV1;
	confirmedAt?: string;
	startedAt?: string;
	waitPromise?: Promise<PrivilegeCommandResultV1>;
}

function diagnostic(code: PrivilegeDiagnosticV1["code"], message: string): PrivilegeDiagnosticV1 {
	return { code, message: [...message.normalize("NFKC")].slice(0, 2_000).join("") };
}

function hasUnsafeTerminalControl(command: string): boolean {
	return /[\u0000-\u0008\u000b-\u000d\u000e-\u001f\u007f-\u009f]/u.test(command);
}

function targetKey(request: PrivilegeExecuteInputV1): string {
	return request.target.execution === "local"
		? "local"
		: `terminal:${request.target.targetId ?? "selected"}:${request.target.terminalId ?? "unknown"}`;
}

function statusText(status: PrivilegeResultStatusV1, issue?: PrivilegeDiagnosticV1): string {
	switch (status) {
		case "running":
			return "Privileged command is running.";
		case "succeeded":
			return "Privileged command completed successfully.";
		case "failed":
			return issue?.message ?? "Privileged command failed.";
		case "cancelled":
			return "Privileged command was cancelled.";
		case "blocked":
			return issue?.message ?? "Privileged command was blocked.";
		case "interaction_required":
			return "User interaction is required, but no privilege interaction handler is available.";
		case "interaction_error":
			return issue?.message ?? "Privilege interaction failed.";
	}
}

export class PrivilegeRuntime {
	private readonly sessionId: string;
	private readonly cwd: string;
	private readonly terminalAdapter: PrivilegeTerminalAdapter;
	private readonly auditWriter: PrivilegeAuditWriter;
	private readonly now: () => Date;
	private readonly isRootTarget: (targetId: string | undefined) => boolean;
	private readonly monitorRuntime: Pick<MonitorRuntime, "attach" | "update"> | undefined;
	private outputReviewer: TerminalOutputReviewer | undefined;
	private handler: PrivilegeInteractionHandler | undefined;
	private active: ActivePrivilegeRequest | undefined;
	private readonly inFlightByToolCallId = new Map<string, Promise<AgentToolResult<PrivilegeToolDetailsV1>>>();
	private readonly completedByToolCallId = new Map<string, AgentToolResult<PrivilegeToolDetailsV1>>();
	private readonly listeners = new Set<(pending: PendingPrivilegeInteraction | undefined) => void>();

	constructor(options: PrivilegeRuntimeOptions) {
		this.sessionId = options.sessionId;
		this.cwd = options.cwd;
		this.terminalAdapter = options.terminalAdapter;
		this.auditWriter = options.auditWriter;
		this.handler = options.handler;
		this.now = options.now ?? (() => new Date());
		this.isRootTarget = options.isRootTarget ?? (() => false);
		this.monitorRuntime = options.monitorRuntime;
		this.outputReviewer = options.outputReviewer;
	}

	setOutputReviewerIfUnset(reviewer: TerminalOutputReviewer): void {
		this.outputReviewer ??= reviewer;
	}

	setHandler(handler: PrivilegeInteractionHandler | undefined): void {
		this.handler = handler;
	}

	getPending(): PendingPrivilegeInteraction | undefined {
		if (!this.active) return undefined;
		return {
			requestId: this.active.request.requestId,
			sourceTool: this.active.request.sourceTool,
			route: this.active.request.route,
			command: this.active.request.command,
			target: structuredClone(this.active.request.target),
			cwd: this.active.request.cwd,
			timeoutMs: this.active.request.timeoutMs,
			auditPath: this.auditWriter.pathFor(new Date(this.active.request.createdAt)),
			createdAt: this.active.request.createdAt,
			state: this.active.state,
		};
	}

	subscribe(listener: (pending: PendingPrivilegeInteraction | undefined) => void): () => void {
		this.listeners.add(listener);
		try {
			listener(this.getPending());
		} catch {
			// Observers are non-authoritative.
		}
		return () => this.listeners.delete(listener);
	}

	cancelPending(): void {
		this.active?.controller.abort();
	}

	async dispose(): Promise<void> {
		this.cancelPending();
		await this.active?.session?.dispose().catch(() => undefined);
		this.inFlightByToolCallId.clear();
		this.completedByToolCallId.clear();
		await this.terminalAdapter.dispose?.();
	}

	private emit(): void {
		const pending = this.getPending();
		for (const listener of this.listeners) {
			try {
				listener(pending ? structuredClone(pending) : undefined);
			} catch {
				// Observers are non-authoritative.
			}
		}
	}

	private async audit(
		active: ActivePrivilegeRequest,
		event: PrivilegeAuditEventTypeV1,
		options: {
			confirmed?: boolean;
			exitCode?: number | null;
			durationMs?: number;
			monitorId?: string;
			logPath?: string;
			diagnosticCode?: PrivilegeDiagnosticV1["code"];
		} = {},
	): Promise<void> {
		const record: PrivilegeAuditEventV1 = {
			version: 1,
			auditId: active.request.auditId,
			sessionId: this.sessionId,
			requestId: active.request.requestId,
			toolCallId: active.request.toolCallId,
			sourceTool: active.request.sourceTool,
			route: active.request.route,
			timestamp: this.now().toISOString(),
			event,
			command: active.request.command,
			target: structuredClone(active.request.target),
			cwd: active.request.cwd,
			...options,
		};
		await this.auditWriter.append(record);
	}

	async execute(
		input: PrivilegeExecuteInputV1,
		signal?: AbortSignal,
		onUpdate?: (result: AgentToolResult<PrivilegeToolDetailsV1>) => void,
	): Promise<AgentToolResult<PrivilegeToolDetailsV1>> {
		const completed = this.completedByToolCallId.get(input.toolCallId);
		if (completed) return structuredClone(completed);
		const inFlight = this.inFlightByToolCallId.get(input.toolCallId);
		if (inFlight) return structuredClone(await inFlight);
		const execution = this.executeRequest(input, signal, onUpdate);
		this.inFlightByToolCallId.set(input.toolCallId, execution);
		try {
			const result = await execution;
			this.completedByToolCallId.set(input.toolCallId, structuredClone(result));
			while (this.completedByToolCallId.size > 100) {
				const oldest = this.completedByToolCallId.keys().next().value;
				if (typeof oldest !== "string") break;
				this.completedByToolCallId.delete(oldest);
			}
			return result;
		} finally {
			this.inFlightByToolCallId.delete(input.toolCallId);
		}
	}

	private async executeRequest(
		input: PrivilegeExecuteInputV1,
		signal?: AbortSignal,
		onUpdate?: (result: AgentToolResult<PrivilegeToolDetailsV1>) => void,
	): Promise<AgentToolResult<PrivilegeToolDetailsV1>> {
		const created = this.now();
		const createdAt = created.toISOString();
		const requestId = `priv-${randomUUID()}`;
		const request: PrivilegeRequestV1 = {
			version: 1,
			...input,
			target: structuredClone(input.target),
			cwd: input.cwd || this.cwd,
			requestId,
			auditId: `audit-${randomUUID()}`,
			createdAt,
			logPath: resolve(input.cwd || this.cwd, ".beaupi", "privilege-logs", this.sessionId, `${requestId}.log`),
		};
		if (request.target.execution === "local" && !request.target.monitorId && this.monitorRuntime) {
			const monitor = this.monitorRuntime.attach({
				target: {
					kind: "tool",
					toolCallId: request.toolCallId,
					toolName: request.sourceTool,
					attachment: "explicit",
					logPath: request.logPath,
				},
				name: request.sourceTool === "privileged_exec" ? "Sudo Bash" : request.sourceTool,
				taskSummary: "Controlled local sudo command",
				timeoutMs: request.timeoutMs,
			});
			request.target.monitorId = monitor.id;
		}
		const active: ActivePrivilegeRequest = {
			request,
			state: "waiting_for_user",
			controller: new AbortController(),
		};
		const finish = (
			status: PrivilegeResultStatusV1,
			issue?: PrivilegeDiagnosticV1,
			commandResult?: PrivilegeCommandResultV1,
			finalizeMonitor = true,
			reviewedOutput?: ReviewedTerminalOutput,
		): AgentToolResult<PrivilegeToolDetailsV1> => {
			const completedAt = this.now();
			const fullOutput = commandResult?.output ?? "";
			const truncation = truncateTail(fullOutput);
			const output = reviewedOutput?.report ?? (truncation.content || statusText(status, issue));
			const startedAtMs = commandResult?.startedAt ?? (active.startedAt ? Date.parse(active.startedAt) : undefined);
			const durationMs = commandResult
				? Math.max(0, commandResult.completedAt - commandResult.startedAt)
				: startedAtMs === undefined
					? 0
					: Math.max(0, completedAt.getTime() - startedAtMs);
			const monitorId = commandResult?.monitorId ?? request.target.monitorId;
			if (finalizeMonitor && request.target.execution === "local" && monitorId && this.monitorRuntime) {
				const cancelled = status === "cancelled";
				const succeeded = status === "succeeded";
				this.monitorRuntime.update(monitorId, {
					status: succeeded ? "completed" : cancelled ? "cancelled" : "failed",
					reason: succeeded
						? "completed"
						: cancelled
							? "cancelled"
							: issue?.code === "timeout"
								? "timeout"
								: "failed",
					exitReason: issue?.code ?? status,
					exitCode: typeof commandResult?.exitCode === "number" ? commandResult.exitCode : undefined,
					diagnostic: issue?.message,
				});
			}
			const details: PrivilegeToolDetailsV1 = {
				version: 1,
				operation: "privileged_exec",
				execution: request.target.execution,
				status,
				ok: status === "succeeded",
				requestId,
				auditId: request.auditId,
				toolCallId: request.toolCallId,
				command: request.command,
				targetKey: targetKey(input),
				route: request.route,
				sourceTool: request.sourceTool,
				createdAt,
				confirmedAt: active.confirmedAt,
				startedAt: active.startedAt,
				completedAt: completedAt.toISOString(),
				terminalId: request.target.terminalId,
				targetId: request.target.targetId,
				monitorId,
				logPath: commandResult?.logPath ?? request.logPath,
				exitCode: commandResult?.exitCode ?? null,
				durationMs,
				diagnostic: issue ?? commandResult?.diagnostic,
				review: reviewedOutput?.review,
				truncation: truncation.truncated ? truncation : undefined,
				fullOutputPath: truncation.truncated ? (commandResult?.logPath ?? request.logPath) : undefined,
			};
			return { content: [{ type: "text", text: output }], details, usage: reviewedOutput?.usage };
		};

		const inspection = inspectShellPrivilege(request.command);
		let validationIssue: PrivilegeDiagnosticV1 | undefined;
		if (
			!request.command.trim() ||
			hasUnsafeTerminalControl(request.command) ||
			inspection.kind === "none" ||
			inspection.opaque
		) {
			validationIssue = diagnostic(
				"invalid_command",
				"privileged_exec requires a deterministic, non-empty sudo command",
			);
		} else if (inspection.kind === "unsupported") {
			validationIssue = diagnostic(
				"unsupported_privilege",
				`Unsupported privilege-changing executable: ${inspection.unsupported.join(", ")}`,
			);
		} else if (inspection.sudoStdin) {
			validationIssue = diagnostic(
				"sudo_stdin_forbidden",
				"sudo -S/--stdin is forbidden; sudo must read from its controlling TTY",
			);
		} else if (request.target.execution === "terminal" && this.isRootTarget(request.target.targetId)) {
			validationIssue = diagnostic(
				"redundant_privilege",
				"The configured SSH login identity is root; remove sudo and use terminal_bash",
			);
		}
		if (this.active) {
			return finish(
				"interaction_error",
				diagnostic("interaction_error", `Privilege request ${this.active.request.requestId} is already active`),
			);
		}

		this.active = active;
		this.emit();
		const forwardAbort = (): void => active.controller.abort();
		signal?.addEventListener("abort", forwardAbort, { once: true });
		if (signal?.aborted) active.controller.abort();
		const cancelSession = (): void => {
			void active.session?.cancel().catch(() => undefined);
		};
		active.controller.signal.addEventListener("abort", cancelSession);
		try {
			try {
				await this.audit(active, "requested", { logPath: request.logPath });
			} catch {
				return finish(
					"blocked",
					diagnostic("audit_failed", "Privilege audit could not be written before execution"),
				);
			}
			if (validationIssue) {
				active.state = "blocked";
				this.emit();
				await this.audit(active, "blocked", {
					diagnosticCode: validationIssue.code,
					logPath: request.logPath,
				}).catch(() => undefined);
				return finish("blocked", validationIssue);
			}
			if (active.controller.signal.aborted) {
				active.state = "cancelled";
				this.emit();
				await this.audit(active, "cancelled", {
					confirmed: false,
					diagnosticCode: "cancelled",
					logPath: request.logPath,
				}).catch(() => undefined);
				return finish("cancelled", diagnostic("cancelled", "Privilege request cancelled"));
			}
			if (!this.handler) {
				active.state = "interaction_required";
				this.emit();
				const issue = diagnostic("interaction_required", "No privilege interaction handler is configured");
				await this.audit(active, "blocked", { diagnosticCode: issue.code, logPath: request.logPath }).catch(
					() => undefined,
				);
				return finish("interaction_required", issue);
			}

			const control: PrivilegeTerminalControl = {
				start: async () => {
					if (active.session || active.state !== "waiting_for_user") {
						throw new Error("Privilege command has already been staged");
					}
					if (active.controller.signal.aborted) throw new Error("Privilege request cancelled");
					active.session = await this.terminalAdapter.create(request, active.controller.signal);
					await active.session.start();
					this.emit();
				},
				execute: async () => {
					if (!active.session || active.state !== "waiting_for_user" || active.confirmedAt) {
						throw new Error("Privilege command is not waiting for user execution");
					}
					if (active.controller.signal.aborted) throw new Error("Privilege request cancelled");
					active.confirmedAt = this.now().toISOString();
					await this.audit(active, "confirmed", { confirmed: true, logPath: request.logPath });
					active.state = "starting";
					this.emit();
					await active.session.execute();
					active.startedAt = this.now().toISOString();
					active.state = "running";
					if (request.target.execution === "local" && request.target.monitorId && this.monitorRuntime) {
						this.monitorRuntime.update(request.target.monitorId, { status: "running", reason: "started" });
					}
					this.emit();
					await this.audit(active, "started", { confirmed: true, logPath: request.logPath });
				},
				sendSensitive: async (inputBytes) => {
					if (!active.session || active.state !== "running") throw new Error("Privilege terminal is not running");
					await active.session.sendSensitive(Buffer.from(inputBytes));
				},
				capture: async () => {
					if (!active.session) return { content: "", state: "starting" };
					return active.session.capture();
				},
				resize: async (columns, rows) => {
					await active.session?.resize(columns, rows);
				},
				cancel: async () => {
					active.controller.abort();
					await active.session?.cancel();
				},
				wait: async () => {
					if (!active.session || !active.startedAt) throw new Error("Privilege command has not started");
					active.waitPromise ??= active.session
						.wait((output) => {
							if (!onUpdate) return;
							const startedAt = Date.parse(active.startedAt!);
							onUpdate(
								finish(
									"running",
									undefined,
									{
										output,
										exitCode: null,
										startedAt,
										completedAt: this.now().getTime(),
										monitorId: request.target.monitorId,
										logPath: request.logPath,
									},
									false,
								),
							);
						})
						.then((result) => {
							active.result = result;
							return result;
						});
					return active.waitPromise;
				},
			};
			onUpdate?.(
				finish(
					"interaction_required",
					diagnostic(
						"interaction_required",
						"Sudo command is staged in the controlled tmux terminal; press Enter to execute or Escape to cancel",
					),
					undefined,
					false,
				),
			);
			const interactionRequest = this.getPending();
			if (!interactionRequest)
				return finish("interaction_error", diagnostic("interaction_error", "Privilege request state was lost"));
			let response: PrivilegeInteractionResponse;
			try {
				response = await Promise.race([
					this.handler(interactionRequest, control, active.controller.signal),
					new Promise<{ status: "cancelled" }>((resolveCancelled) => {
						if (active.controller.signal.aborted) resolveCancelled({ status: "cancelled" });
						else
							active.controller.signal.addEventListener(
								"abort",
								() => resolveCancelled({ status: "cancelled" }),
								{ once: true },
							);
					}),
				]);
			} catch (error) {
				response = { status: "error" as const, diagnostic: error instanceof Error ? error.message : String(error) };
			}
			if (response.status === "cancelled" || active.controller.signal.aborted) {
				active.state = "cancelled";
				await active.session?.cancel().catch(() => undefined);
				const result =
					active.result ?? (active.waitPromise ? await active.waitPromise.catch(() => undefined) : undefined);
				await this.audit(active, "cancelled", {
					confirmed: active.confirmedAt !== undefined,
					exitCode: result?.exitCode,
					durationMs: result ? Math.max(0, result.completedAt - result.startedAt) : undefined,
					monitorId: result?.monitorId,
					logPath: result?.logPath ?? request.logPath,
					diagnosticCode: "cancelled",
				}).catch(() => undefined);
				return finish("cancelled", diagnostic("cancelled", "Privilege request cancelled"), result);
			}
			if (response.status === "rejected") {
				active.state = "blocked";
				const issue = diagnostic("cancelled", response.diagnostic ?? "Privilege request rejected by user");
				await this.audit(active, "blocked", {
					confirmed: false,
					diagnosticCode: issue.code,
					logPath: request.logPath,
				});
				return finish("blocked", issue);
			}
			if (response.status === "error") {
				active.state = "failed";
				const issue = diagnostic("interaction_error", response.diagnostic);
				await this.audit(active, "failed", { diagnosticCode: issue.code, logPath: request.logPath }).catch(
					() => undefined,
				);
				return finish("interaction_error", issue);
			}
			if (!active.session || !active.startedAt) {
				return finish(
					"interaction_error",
					diagnostic("interaction_error", "Privilege interaction completed before user execution"),
				);
			}
			const commandResult = active.result ?? (await control.wait());
			const succeeded = !commandResult.cancelled && !commandResult.timedOut && commandResult.exitCode === 0;
			active.state = succeeded ? "completed" : commandResult.cancelled ? "cancelled" : "failed";
			this.emit();
			const finalEvent = succeeded ? "completed" : commandResult.cancelled ? "cancelled" : "failed";
			const finalIssue = succeeded
				? undefined
				: (commandResult.diagnostic ??
					(commandResult.timedOut
						? diagnostic("timeout", "Privileged command timed out")
						: commandResult.cancelled
							? diagnostic("cancelled", "Privileged command cancelled")
							: diagnostic(
									"command_failed",
									`Privileged command exited with code ${commandResult.exitCode ?? "unknown"}`,
								)));
			try {
				await this.audit(active, finalEvent, {
					confirmed: true,
					exitCode: commandResult.exitCode,
					durationMs: Math.max(0, commandResult.completedAt - commandResult.startedAt),
					monitorId: commandResult.monitorId,
					logPath: commandResult.logPath ?? request.logPath,
					diagnosticCode: finalIssue?.code,
				});
			} catch {
				return finish(
					"failed",
					diagnostic("audit_failed", "Final privilege audit could not be written"),
					commandResult,
				);
			}
			const reviewedOutput = await reviewTerminalOutput(
				{
					command: request.command,
					output: commandResult.output,
					exitCode: commandResult.exitCode,
					diagnosticCode: finalIssue?.code,
					diagnosticMessage: finalIssue?.message,
					durationMs: Math.max(0, commandResult.completedAt - commandResult.startedAt),
					logPath: commandResult.logPath ?? request.logPath,
				},
				this.outputReviewer,
				active.controller.signal,
			);
			return finish(
				succeeded ? "succeeded" : commandResult.cancelled ? "cancelled" : "failed",
				finalIssue,
				commandResult,
				true,
				reviewedOutput,
			);
		} finally {
			signal?.removeEventListener("abort", forwardAbort);
			active.controller.signal.removeEventListener("abort", cancelSession);
			await active.session?.dispose().catch(() => undefined);
			if (this.active?.request.requestId === requestId) {
				this.active = undefined;
				this.emit();
			}
		}
	}
}
