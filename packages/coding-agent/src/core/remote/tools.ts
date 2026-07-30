import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { ToolDefinition } from "../extensions/types.ts";
import { createBashToolDefinition } from "../tools/bash.ts";
import { createEditToolDefinition } from "../tools/edit.ts";
import { createReadToolDefinition } from "../tools/read.ts";
import { createWriteToolDefinition } from "../tools/write.ts";
import type { RemoteExecutionRuntime } from "./runtime.ts";
import type { ExecutionTargetConfig, RemoteDiagnostic } from "./types.ts";

const targetSelectSchema = Type.Object({
	targetId: Type.String({ minLength: 1, description: "Configured execution target id" }),
});
const remoteExecSchema = Type.Object({
	command: Type.String({ minLength: 1, description: "Remote command to execute on the selected target" }),
	timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Timeout in seconds" })),
	targetId: Type.Optional(Type.String({ minLength: 1 })),
});
const terminalCreateSchema = Type.Object({
	terminalId: Type.Optional(Type.String({ minLength: 1 })),
	command: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String()),
	columns: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
	rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
	targetId: Type.Optional(Type.String({ minLength: 1 })),
});
const terminalSendSchema = Type.Object({ terminalId: Type.String({ minLength: 1 }), input: Type.String() });
const terminalCaptureSchema = Type.Object({
	terminalId: Type.String({ minLength: 1 }),
	cursor: Type.Optional(Type.Integer({ minimum: 0 })),
});
const terminalStatusSchema = Type.Object({ terminalId: Type.String({ minLength: 1 }) });
const terminalCloseSchema = Type.Object({ terminalId: Type.String({ minLength: 1 }) });

type TargetSelectInput = Static<typeof targetSelectSchema>;
type RemoteExecInput = Static<typeof remoteExecSchema>;
type TerminalCreateInput = Static<typeof terminalCreateSchema>;
type TerminalSendInput = Static<typeof terminalSendSchema>;
type TerminalCaptureInput = Static<typeof terminalCaptureSchema>;
type TerminalStatusInput = Static<typeof terminalStatusSchema>;
type TerminalCloseInput = Static<typeof terminalCloseSchema>;

export interface RemoteToolDetails {
	version: 1;
	operation: string;
	ok: boolean;
	target?: ExecutionTargetConfig;
	targets?: ExecutionTargetConfig[];
	command?: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number | null;
	monitorId?: string;
	terminalId?: string;
	cursor?: number;
	changed?: boolean;
	logPath?: string;
	status?: string;
	exists?: boolean;
	diagnostic?: RemoteDiagnostic;
}

const validators = {
	targetSelect: Compile(targetSelectSchema),
	remoteExec: Compile(remoteExecSchema),
	terminalCreate: Compile(terminalCreateSchema),
	terminalSend: Compile(terminalSendSchema),
	terminalCapture: Compile(terminalCaptureSchema),
	terminalStatus: Compile(terminalStatusSchema),
	terminalClose: Compile(terminalCloseSchema),
};

function validate<T>(
	toolName: string,
	validator: { Check(value: unknown): boolean },
	value: unknown,
): asserts value is T {
	if (!validator.Check(value)) throw new Error(`${toolName} received invalid parameters`);
}

function toolResult(
	operation: string,
	details: Omit<RemoteToolDetails, "version" | "operation">,
	content: string,
): AgentToolResult<RemoteToolDetails> {
	return {
		content: [{ type: "text", text: content }],
		details: { version: 1, operation, ...details },
	};
}

function renderCall(name: string, summary: string): Text {
	return new Text(`${name}(${summary})`, 0, 0);
}

function renderResult(result: AgentToolResult<RemoteToolDetails>): Text {
	const details = result.details;
	if (details.diagnostic) return new Text(`${details.diagnostic.code}: ${details.diagnostic.message}`, 0, 0);
	if (details.operation === "remote_exec") {
		const output = [details.stdout, details.stderr].filter((value): value is string => Boolean(value)).join("\n");
		const summary = output || `exit ${details.exitCode ?? 0} · monitor ${details.monitorId ?? "unknown"}`;
		return new Text(details.logPath ? `${summary}\nFull log: ${details.logPath}` : summary, 0, 0);
	}
	const summary = [
		details.status,
		details.monitorId ? `monitor ${details.monitorId}` : "",
		details.logPath ? `log ${details.logPath}` : "",
	]
		.filter(Boolean)
		.join(" · ");
	return new Text(summary || result.content.map((item) => (item.type === "text" ? item.text : "")).join(""), 0, 0);
}

function errorResult(operation: string, error: unknown): AgentToolResult<RemoteToolDetails> {
	const diagnostic =
		error instanceof Error && "diagnostic" in error
			? (error as Error & { diagnostic?: RemoteDiagnostic }).diagnostic
			: undefined;
	const fallback: RemoteDiagnostic = diagnostic ?? {
		code: "ssh_connection",
		message: error instanceof Error ? error.message : String(error),
	};
	return toolResult(operation, { ok: false, diagnostic: fallback }, fallback.message);
}

function createTargetSelectTool(
	runtime: RemoteExecutionRuntime,
): ToolDefinition<typeof targetSelectSchema, RemoteToolDetails> {
	return {
		name: "target_select",
		label: "target_select",
		description: "Select a configured, trusted SSH execution target. Targets contain no credentials.",
		promptSnippet: "Select a trusted SSH execution target",
		promptGuidelines: [
			"Select a target before remote_exec or terminal operations.",
			"If a target is missing in interactive mode, ask the user to configure it with /target-server [target-id].",
			"Never ask for or store SSH private keys, passwords, or tokens.",
		],
		parameters: targetSelectSchema,
		execute: async (_toolCallId, params) => {
			validate<TargetSelectInput>("target_select", validators.targetSelect, params);
			try {
				const target = runtime.selectTarget(params.targetId);
				return toolResult(
					"target_select",
					{ ok: true, target, targets: runtime.listTargets() },
					`Selected target ${target.id} (${target.scope})`,
				);
			} catch (error) {
				const result = errorResult("target_select", error);
				result.details.targets = runtime.listTargets();
				return result;
			}
		},
		renderCall: (args) => renderCall("Target Select", args.targetId),
		renderResult: (result) => renderResult(result as AgentToolResult<RemoteToolDetails>),
	};
}

function createRemoteExecTool(
	runtime: RemoteExecutionRuntime,
): ToolDefinition<typeof remoteExecSchema, RemoteToolDetails> {
	return {
		name: "remote_exec",
		label: "remote_exec",
		description: "Execute one validated normal-user command on the selected SSH target and return its exit code.",
		promptSnippet: "Execute a command on the selected SSH target",
		promptGuidelines: [
			"Do not use sudo, su, doas, pkexec, or root shells.",
			"Use target_select first.",
			"Remote command output is truncated by the caller when needed.",
		],
		parameters: remoteExecSchema,
		execute: async (_toolCallId, params, signal) => {
			validate<RemoteExecInput>("remote_exec", validators.remoteExec, params);
			try {
				const result = await runtime.remoteExec(params.command, {
					signal,
					timeoutMs: params.timeout ? params.timeout * 1000 : undefined,
					targetId: params.targetId,
				});
				const output = [result.stdout, result.stderr].filter((value) => value.length > 0).join("\n");
				return toolResult(
					"remote_exec",
					{
						ok: result.exitCode === 0,
						command: result.command,
						stdout: result.stdout,
						stderr: result.stderr,
						exitCode: result.exitCode,
						monitorId: result.monitorId,
						logPath: result.logPath,
						target: runtime.selectedTarget,
						diagnostic: result.diagnostic,
					},
					output || `(no output) · exit ${result.exitCode ?? "cancelled"}`,
				);
			} catch (error) {
				return errorResult("remote_exec", error);
			}
		},
		renderCall: (args) => renderCall("Remote Exec", args.command),
		renderResult: (result) => renderResult(result as AgentToolResult<RemoteToolDetails>),
	};
}

function createTerminalCreateTool(
	runtime: RemoteExecutionRuntime,
): ToolDefinition<typeof terminalCreateSchema, RemoteToolDetails> {
	return {
		name: "terminal_create",
		label: "terminal_create",
		description: "Create a controlled normal-user tmux session on the selected SSH target.",
		promptSnippet: "Create a remote tmux terminal",
		parameters: terminalCreateSchema,
		execute: async (_toolCallId, params, signal) => {
			validate<TerminalCreateInput>("terminal_create", validators.terminalCreate, params);
			try {
				const result = await runtime.terminalCreate({ ...params, signal });
				return toolResult(
					"terminal_create",
					{
						ok: true,
						terminalId: result.terminalId,
						monitorId: result.monitorId,
						status: result.status,
						logPath: result.logPath,
						target: runtime.selectedTarget,
					},
					`Created ${result.terminalId} · monitor ${result.monitorId}`,
				);
			} catch (error) {
				return errorResult("terminal_create", error);
			}
		},
		renderCall: (args) => renderCall("Terminal Create", args.terminalId ?? "tmux"),
		renderResult: (result) => renderResult(result as AgentToolResult<RemoteToolDetails>),
	};
}

function createTerminalSendTool(
	runtime: RemoteExecutionRuntime,
): ToolDefinition<typeof terminalSendSchema, RemoteToolDetails> {
	return {
		name: "terminal_send",
		label: "terminal_send",
		description: "Send literal input to an existing remote tmux session.",
		promptSnippet: "Send input to a remote tmux terminal",
		parameters: terminalSendSchema,
		execute: async (_toolCallId, params, signal) => {
			validate<TerminalSendInput>("terminal_send", validators.terminalSend, params);
			try {
				const result = await runtime.terminalSend(params.terminalId, params.input, signal);
				return toolResult(
					"terminal_send",
					{ ok: true, terminalId: result.terminalId, monitorId: result.monitorId, status: result.status },
					`Sent input to ${result.terminalId}`,
				);
			} catch (error) {
				return errorResult("terminal_send", error);
			}
		},
		renderCall: (args) => renderCall("Terminal Send", args.terminalId),
		renderResult: (result) => renderResult(result as AgentToolResult<RemoteToolDetails>),
	};
}

function createTerminalCaptureTool(
	runtime: RemoteExecutionRuntime,
): ToolDefinition<typeof terminalCaptureSchema, RemoteToolDetails> {
	return {
		name: "terminal_capture",
		label: "terminal_capture",
		description:
			"Capture only new output from a remote tmux terminal using a cursor; complete output remains in the log file.",
		promptSnippet: "Read incremental output from a remote tmux terminal",
		parameters: terminalCaptureSchema,
		execute: async (_toolCallId, params, signal) => {
			validate<TerminalCaptureInput>("terminal_capture", validators.terminalCapture, params);
			try {
				const result = await runtime.terminalCapture(params.terminalId, signal, params.cursor);
				return toolResult(
					"terminal_capture",
					{
						ok: true,
						terminalId: result.terminalId,
						monitorId: result.monitorId,
						cursor: result.cursor,
						changed: result.changed,
						logPath: result.logPath,
						status: result.status,
					},
					result.content || "No new terminal output.",
				);
			} catch (error) {
				return errorResult("terminal_capture", error);
			}
		},
		renderCall: (args) => renderCall("Terminal Capture", args.terminalId),
		renderResult: (result) => renderResult(result as AgentToolResult<RemoteToolDetails>),
	};
}

function createTerminalStatusTool(
	runtime: RemoteExecutionRuntime,
): ToolDefinition<typeof terminalStatusSchema, RemoteToolDetails> {
	return {
		name: "terminal_status",
		label: "terminal_status",
		description: "Read deterministic tmux existence and Monitor status for a remote terminal.",
		promptSnippet: "Check a remote tmux terminal status",
		parameters: terminalStatusSchema,
		execute: async (_toolCallId, params, signal) => {
			validate<TerminalStatusInput>("terminal_status", validators.terminalStatus, params);
			try {
				const result = await runtime.terminalStatus(params.terminalId, signal);
				return toolResult(
					"terminal_status",
					{
						ok: true,
						terminalId: result.terminalId,
						monitorId: result.monitorId,
						status: result.status,
						exists: result.exists,
						logPath: result.logPath,
					},
					`${result.terminalId} · ${result.status} · exists=${result.exists}`,
				);
			} catch (error) {
				return errorResult("terminal_status", error);
			}
		},
		renderCall: (args) => renderCall("Terminal Status", args.terminalId),
		renderResult: (result) => renderResult(result as AgentToolResult<RemoteToolDetails>),
	};
}

function createTerminalCloseTool(
	runtime: RemoteExecutionRuntime,
): ToolDefinition<typeof terminalCloseSchema, RemoteToolDetails> {
	return {
		name: "terminal_close",
		label: "terminal_close",
		description:
			"Close a remote tmux terminal and its Monitor lifecycle without closing the SSH target unless requested separately.",
		promptSnippet: "Close a remote tmux terminal",
		parameters: terminalCloseSchema,
		execute: async (_toolCallId, params, signal) => {
			validate<TerminalCloseInput>("terminal_close", validators.terminalClose, params);
			try {
				const result = await runtime.terminalClose(params.terminalId, signal);
				return toolResult(
					"terminal_close",
					{ ok: true, terminalId: result.terminalId, monitorId: result.monitorId, status: result.status },
					`Closed ${result.terminalId} · ${result.status}`,
				);
			} catch (error) {
				return errorResult("terminal_close", error);
			}
		},
		renderCall: (args) => renderCall("Terminal Close", args.terminalId),
		renderResult: (result) => renderResult(result as AgentToolResult<RemoteToolDetails>),
	};
}

function rename(definition: object, name: string): ToolDefinition {
	return { ...definition, name, label: name } as unknown as ToolDefinition;
}

/** Built-in M7 tools plus explicit remote file operation adapters. */
export function createRemoteToolDefinitions(runtime: RemoteExecutionRuntime): ToolDefinition[] {
	const read = createReadToolDefinition(runtime.cwd, { operations: runtime.createReadOperations() });
	const write = createWriteToolDefinition(runtime.cwd, { operations: runtime.createWriteOperations() });
	const edit = createEditToolDefinition(runtime.cwd, { operations: runtime.createEditOperations() });
	const bash = createBashToolDefinition(runtime.cwd, {
		operations: runtime.createBashOperations(),
		exposeSessionEnvironment: false,
	});
	return [
		createTargetSelectTool(runtime),
		createRemoteExecTool(runtime),
		createTerminalCreateTool(runtime),
		createTerminalSendTool(runtime),
		createTerminalCaptureTool(runtime),
		createTerminalStatusTool(runtime),
		createTerminalCloseTool(runtime),
		rename(read, "remote_read"),
		rename(write, "remote_write"),
		rename(edit, "remote_edit"),
		rename(bash, "remote_bash"),
	] as ToolDefinition[];
}

export {
	remoteExecSchema,
	targetSelectSchema,
	terminalCaptureSchema,
	terminalCloseSchema,
	terminalCreateSchema,
	terminalSendSchema,
	terminalStatusSchema,
};
