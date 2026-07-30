import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { type BashToolDetails, createBashToolDefinition } from "../tools/bash.ts";
import { createEditToolDefinition } from "../tools/edit.ts";
import { createReadToolDefinition } from "../tools/read.ts";
import { createWriteToolDefinition } from "../tools/write.ts";
import type { RemoteExecutionRuntime } from "./runtime.ts";
import { type ExecutionTargetConfig, type RemoteDiagnostic, RemoteExecutionError } from "./types.ts";

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
const terminalBashSchema = Type.Object({
	terminalId: Type.String({ minLength: 1, description: "Existing tmux terminal id" }),
	command: Type.String({ minLength: 1, description: "Bash command to execute in the terminal's current directory" }),
	timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Timeout in seconds" })),
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
type TerminalBashInput = Static<typeof terminalBashSchema>;
type TerminalSendInput = Static<typeof terminalSendSchema>;
type TerminalCaptureInput = Static<typeof terminalCaptureSchema>;
type TerminalStatusInput = Static<typeof terminalStatusSchema>;
type TerminalCloseInput = Static<typeof terminalCloseSchema>;

export interface TerminalBashToolDetails extends BashToolDetails {
	operation: "terminal_bash";
	terminalId: string;
	monitorId?: string;
	logPath?: string;
}

type TerminalBashRenderState = {
	startedAt?: number;
	endedAt?: number;
	interval?: NodeJS.Timeout;
};

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
	terminalBash: Compile(terminalBashSchema),
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

const REMOTE_OUTPUT_PREVIEW_LINES = 10;

function singleLineSummary(value: string, emptyFallback = "…"): string {
	const summary = value
		.replace(/[ \t]*(?:\r\n|\r|\n)[ \t]*/g, " ")
		.replace(/\t/g, "   ")
		.trim();
	return summary || emptyFallback;
}

function literalInputSummary(value: string): string {
	return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t") || "(empty input)";
}

class RemoteCallRenderComponent implements Component {
	private name = "";
	private contextLabel = "";
	private summary = "";
	private currentTheme: Theme | undefined;

	setCall(name: string, summary: string, currentTheme: Theme, contextLabel?: string): void {
		this.name = name;
		this.contextLabel = contextLabel ?? "";
		this.summary = singleLineSummary(summary, "");
		this.currentTheme = currentTheme;
	}

	render(width: number): string[] {
		const availableWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (availableWidth === 0 || !this.currentTheme) return [];

		const title = this.currentTheme.fg("toolTitle", this.currentTheme.bold(this.name));
		const context = this.contextLabel ? ` ${this.currentTheme.fg("toolOutput", `[${this.contextLabel}]`)}` : "";
		const heading = `${title}${context}`;
		const prefix = `${heading}(`;
		const suffix = ")";
		const summaryWidth = availableWidth - visibleWidth(prefix) - visibleWidth(suffix);
		if (summaryWidth < 0) return [truncateToWidth(heading, availableWidth, "…")];

		const summary = this.currentTheme.fg("toolOutput", this.summary);
		return [`${prefix}${truncateToWidth(summary, summaryWidth, "…")}${suffix}`];
	}

	invalidate(): void {}
}

class RemoteOutputRenderComponent implements Component {
	private text = "";
	private expanded = false;
	private currentTheme: Theme | undefined;

	setOutput(text: string, expanded: boolean, currentTheme: Theme): void {
		this.text = text;
		this.expanded = expanded;
		this.currentTheme = currentTheme;
	}

	render(width: number): string[] {
		const availableWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (availableWidth === 0 || !this.text || !this.currentTheme) return [];

		const lines = new Text(this.text, 0, 0).render(availableWidth);
		if (this.expanded || lines.length <= REMOTE_OUTPUT_PREVIEW_LINES) return lines;

		const hidden = lines.length - REMOTE_OUTPUT_PREVIEW_LINES;
		const hint =
			this.currentTheme.fg("muted", `… (${hidden} more lines, ${lines.length} total,`) +
			` ${keyHint("app.tools.expand", "to expand")}${this.currentTheme.fg("muted", ")")}`;
		return [...lines.slice(0, REMOTE_OUTPUT_PREVIEW_LINES), truncateToWidth(hint, availableWidth, "…")];
	}

	invalidate(): void {}
}

function renderCall(
	name: string,
	summary: string,
	currentTheme: Theme,
	lastComponent?: Component,
	contextLabel?: string,
): RemoteCallRenderComponent {
	const component =
		lastComponent instanceof RemoteCallRenderComponent ? lastComponent : new RemoteCallRenderComponent();
	component.setCall(name, summary, currentTheme, contextLabel);
	return component;
}

function renderTerminalCall(
	name: string,
	terminalId: string,
	summary: string,
	currentTheme: Theme,
	lastComponent?: Component,
): RemoteCallRenderComponent {
	return renderCall(name, summary, currentTheme, lastComponent, terminalId);
}

function renderOutput(text: string, currentTheme: Theme): string {
	return text
		.split("\n")
		.map((line) => currentTheme.fg("toolOutput", line))
		.join("\n");
}

function textComponent(text: string, lastComponent?: Component): Text {
	const component = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
	component.setText(text);
	return component;
}

function boundedOutputComponent(
	text: string,
	expanded: boolean,
	currentTheme: Theme,
	lastComponent?: Component,
): RemoteOutputRenderComponent {
	const component =
		lastComponent instanceof RemoteOutputRenderComponent ? lastComponent : new RemoteOutputRenderComponent();
	component.setOutput(text, expanded, currentTheme);
	return component;
}

function renderResult(
	result: AgentToolResult<RemoteToolDetails>,
	expanded: boolean,
	currentTheme: Theme,
	lastComponent?: Component,
): Component {
	const details = result.details;
	const diagnostic = details.diagnostic
		? currentTheme.fg("error", `${details.diagnostic.code}: ${details.diagnostic.message}`)
		: "";
	if (details.operation === "remote_exec") {
		const output = [details.stdout, details.stderr].filter((value): value is string => Boolean(value)).join("\n");
		const content = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");
		const body = output || (!details.diagnostic ? content || `exit ${details.exitCode ?? 0}` : "");
		return boundedOutputComponent(
			[diagnostic, body ? renderOutput(body, currentTheme) : ""].filter(Boolean).join("\n"),
			expanded,
			currentTheme,
			lastComponent,
		);
	}
	if (details.operation === "terminal_capture") {
		const content = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");
		return boundedOutputComponent(
			[diagnostic, content ? renderOutput(content, currentTheme) : ""].filter(Boolean).join("\n"),
			expanded,
			currentTheme,
			lastComponent,
		);
	}
	const summary = [
		details.status,
		details.monitorId ? `monitor ${details.monitorId}` : "",
		details.logPath ? `log ${details.logPath}` : "",
	]
		.filter(Boolean)
		.join(" · ");
	return textComponent(
		diagnostic ||
			(summary
				? renderOutput(summary, currentTheme)
				: renderOutput(
						result.content.map((item) => (item.type === "text" ? item.text : "")).join(""),
						currentTheme,
					)),
		lastComponent,
	);
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
			"Use target_select to set the default target; pass targetId explicitly to address another configured target.",
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
		renderCall: (args, currentTheme, context) =>
			renderCall("Target Select", args.targetId, currentTheme, context.lastComponent),
		renderResult: (result, options, currentTheme, context) =>
			renderResult(
				result as AgentToolResult<RemoteToolDetails>,
				options.expanded,
				currentTheme,
				context.lastComponent,
			),
	};
}

function createRemoteExecTool(
	runtime: RemoteExecutionRuntime,
): ToolDefinition<typeof remoteExecSchema, RemoteToolDetails> {
	return {
		name: "remote_exec",
		label: "remote_exec",
		description:
			"Execute one validated normal-user command on the default or explicitly requested SSH target and return its exit code. Uses that target's configured remote working directory when set.",
		promptSnippet: "Execute a command on the selected SSH target",
		promptGuidelines: [
			"Do not use sudo, su, doas, pkexec, or root shells.",
			"Use target_select to set the default target, or pass targetId explicitly when working with multiple targets.",
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
						target: runtime.getTarget(result.connectedTargetId),
						diagnostic: result.diagnostic,
					},
					output || `(no output) · exit ${result.exitCode ?? "cancelled"}`,
				);
			} catch (error) {
				return errorResult("remote_exec", error);
			}
		},
		renderCall: (args, currentTheme, context) =>
			renderCall("Remote Exec", args.command, currentTheme, context.lastComponent),
		renderResult: (result, options, currentTheme, context) =>
			renderResult(
				result as AgentToolResult<RemoteToolDetails>,
				options.expanded,
				currentTheme,
				context.lastComponent,
			),
	};
}

function createTerminalCreateTool(
	runtime: RemoteExecutionRuntime,
): ToolDefinition<typeof terminalCreateSchema, RemoteToolDetails> {
	return {
		name: "terminal_create",
		label: "terminal_create",
		description: "Create a controlled normal-user tmux session on the default or explicitly requested SSH target.",
		promptSnippet: "Create a remote tmux terminal",
		promptGuidelines: ["Omit command for an interactive terminal so tmux uses the remote user's default shell."],
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
						target: runtime.getTarget(result.targetId),
					},
					`Created ${result.terminalId} · monitor ${result.monitorId}`,
				);
			} catch (error) {
				return errorResult("terminal_create", error);
			}
		},
		renderCall: (args, currentTheme, context) => {
			const summary = [args.cwd ? `cwd ${args.cwd}` : "", args.command ? singleLineSummary(args.command) : ""]
				.filter(Boolean)
				.join(" · ");
			return renderTerminalCall(
				"Terminal Create",
				args.terminalId ?? "auto",
				summary,
				currentTheme,
				context.lastComponent,
			);
		},
		renderResult: (result, options, currentTheme, context) =>
			renderResult(
				result as AgentToolResult<RemoteToolDetails>,
				options.expanded,
				currentTheme,
				context.lastComponent,
			),
	};
}

function createTerminalBashTool(
	runtime: RemoteExecutionRuntime,
): ToolDefinition<typeof terminalBashSchema, TerminalBashToolDetails | undefined, TerminalBashRenderState> {
	const bashRenderer = createBashToolDefinition(runtime.cwd, {
		operations: runtime.createBashOperations(),
		exposeSessionEnvironment: false,
	});
	return {
		name: "terminal_bash",
		label: "terminal_bash",
		description:
			"Execute a Bash command through an existing remote tmux terminal. The command inherits that terminal's current directory and exported environment, waits for completion, and uses Bash-compatible output, timeout, cancellation, truncation, and exit-code behavior.",
		promptSnippet: "Execute a command in an existing remote tmux terminal",
		promptGuidelines: [
			"Use terminal_bash for normal commands in an existing terminal; treat it like bash running in that terminal's current directory.",
			"Prefer terminal_bash over terminal_send plus terminal_capture when a command should run to completion and return output.",
			"Use terminal_send and terminal_capture only for genuinely interactive input or terminal diagnosis.",
			"Do not use sudo, su, doas, pkexec, or root shells.",
		],
		parameters: terminalBashSchema,
		executionMode: "sequential",
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			validate<TerminalBashInput>("terminal_bash", validators.terminalBash, params);
			let terminalResult: Awaited<ReturnType<RemoteExecutionRuntime["terminalBash"]>> | undefined;
			const executor = createBashToolDefinition(runtime.cwd, {
				exposeSessionEnvironment: false,
				operations: {
					exec: async (command, _cwd, options) => {
						try {
							terminalResult = await runtime.terminalBash(params.terminalId, command, {
								signal: options.signal,
								timeoutMs: options.timeout ? options.timeout * 1000 : undefined,
								onData: options.onData,
							});
							return { exitCode: terminalResult.exitCode };
						} catch (error) {
							if (error instanceof RemoteExecutionError && error.diagnostic.code === "remote_cancelled") {
								throw new Error("aborted");
							}
							if (error instanceof RemoteExecutionError && error.diagnostic.code === "remote_timeout") {
								throw new Error(`timeout:${options.timeout ?? params.timeout ?? 0}`);
							}
							throw error;
						}
					},
				},
			});
			const result = await executor.execute(
				toolCallId,
				{ command: params.command, timeout: params.timeout },
				signal,
				onUpdate
					? (update) =>
							onUpdate({
								...update,
								details: update.details
									? { ...update.details, operation: "terminal_bash", terminalId: params.terminalId }
									: undefined,
							})
					: undefined,
				ctx,
			);
			return {
				...result,
				details: result.details
					? {
							...result.details,
							operation: "terminal_bash",
							terminalId: params.terminalId,
							monitorId: terminalResult?.monitorId,
							logPath: terminalResult?.logPath,
						}
					: undefined,
			};
		},
		renderCall: (args, currentTheme, context) => {
			if (context.executionStarted && context.state.startedAt === undefined) {
				context.state.startedAt = Date.now();
				context.state.endedAt = undefined;
			}
			return renderTerminalCall(
				"Terminal Bash",
				args.terminalId,
				`${singleLineSummary(args.command)}${args.timeout ? ` · timeout ${args.timeout}s` : ""}`,
				currentTheme,
				context.lastComponent,
			);
		},
		renderResult: (result, options, currentTheme, context) =>
			bashRenderer.renderResult?.(
				result as AgentToolResult<BashToolDetails | undefined>,
				options,
				currentTheme,
				context as never,
			) ?? textComponent("", context.lastComponent),
	};
}

function createTerminalSendTool(
	runtime: RemoteExecutionRuntime,
): ToolDefinition<typeof terminalSendSchema, RemoteToolDetails> {
	return {
		name: "terminal_send",
		label: "terminal_send",
		description: "Send literal input to an existing remote tmux session for genuinely interactive terminal control.",
		promptSnippet: "Send interactive input to a remote tmux terminal",
		promptGuidelines: [
			"Do not use terminal_send plus terminal_capture for ordinary commands; use terminal_bash instead.",
		],
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
		renderCall: (args, currentTheme, context) =>
			renderTerminalCall(
				"Terminal Send",
				args.terminalId,
				literalInputSummary(args.input),
				currentTheme,
				context.lastComponent,
			),
		renderResult: (result, options, currentTheme, context) =>
			renderResult(
				result as AgentToolResult<RemoteToolDetails>,
				options.expanded,
				currentTheme,
				context.lastComponent,
			),
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
		renderCall: (args, currentTheme, context) =>
			renderTerminalCall(
				"Terminal Capture",
				args.terminalId,
				args.cursor === undefined ? "" : `cursor ${args.cursor}`,
				currentTheme,
				context.lastComponent,
			),
		renderResult: (result, options, currentTheme, context) =>
			renderResult(
				result as AgentToolResult<RemoteToolDetails>,
				options.expanded,
				currentTheme,
				context.lastComponent,
			),
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
		renderCall: (args, currentTheme, context) =>
			renderTerminalCall("Terminal Status", args.terminalId, "", currentTheme, context.lastComponent),
		renderResult: (result, options, currentTheme, context) =>
			renderResult(
				result as AgentToolResult<RemoteToolDetails>,
				options.expanded,
				currentTheme,
				context.lastComponent,
			),
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
		renderCall: (args, currentTheme, context) =>
			renderTerminalCall("Terminal Close", args.terminalId, "", currentTheme, context.lastComponent),
		renderResult: (result, options, currentTheme, context) =>
			renderResult(
				result as AgentToolResult<RemoteToolDetails>,
				options.expanded,
				currentTheme,
				context.lastComponent,
			),
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
	const remoteBash = rename(bash, "remote_bash");
	remoteBash.renderCall = (args, currentTheme, context) => {
		const input = args as { command?: unknown; timeout?: unknown };
		const command = typeof input.command === "string" ? input.command : "";
		const timeout = typeof input.timeout === "number" ? ` · timeout ${input.timeout}s` : "";
		return renderCall("Remote Bash", `${singleLineSummary(command)}${timeout}`, currentTheme, context.lastComponent);
	};
	return [
		createTargetSelectTool(runtime),
		createRemoteExecTool(runtime),
		createTerminalCreateTool(runtime),
		createTerminalBashTool(runtime),
		createTerminalSendTool(runtime),
		createTerminalCaptureTool(runtime),
		createTerminalStatusTool(runtime),
		createTerminalCloseTool(runtime),
		rename(read, "remote_read"),
		rename(write, "remote_write"),
		rename(edit, "remote_edit"),
		remoteBash,
	] as ToolDefinition[];
}

export {
	remoteExecSchema,
	targetSelectSchema,
	terminalBashSchema,
	terminalCaptureSchema,
	terminalCloseSchema,
	terminalCreateSchema,
	terminalSendSchema,
	terminalStatusSchema,
};
