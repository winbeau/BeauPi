import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { hasPotentialShellPrivilege, inspectShellPrivilege } from "../policy/index.ts";
import type { PrivilegeRuntime, PrivilegeToolDetailsV1 } from "../privilege/index.ts";
import { type BashToolDetails, createBashToolDefinition } from "../tools/bash.ts";
import { createEditToolDefinition, type EditToolDetails, editSchema } from "../tools/edit.ts";
import { createReadToolDefinition, type ReadToolDetails, readSchema } from "../tools/read.ts";
import { createWriteToolDefinition, type WriteToolDetails, writeSchema } from "../tools/write.ts";
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
const terminalBashSchema = Type.Object({
	terminalId: Type.String({ minLength: 1, description: "Existing tmux terminal id" }),
	command: Type.String({ minLength: 1, description: "Bash command to execute in the terminal's current directory" }),
	timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Timeout in seconds" })),
});
const terminalReadSchema = Type.Object({
	terminalId: Type.String({ minLength: 1, description: "Existing tmux terminal id" }),
	...readSchema.properties,
});
const terminalWriteSchema = Type.Object({
	terminalId: Type.String({ minLength: 1, description: "Existing tmux terminal id" }),
	...writeSchema.properties,
});
const terminalEditSchema = Type.Object({
	terminalId: Type.String({ minLength: 1, description: "Existing tmux terminal id" }),
	...editSchema.properties,
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
type TerminalReadInput = Static<typeof terminalReadSchema>;
type TerminalWriteInput = Static<typeof terminalWriteSchema>;
type TerminalEditInput = Static<typeof terminalEditSchema>;
type TerminalSendInput = Static<typeof terminalSendSchema>;
type TerminalCaptureInput = Static<typeof terminalCaptureSchema>;
type TerminalStatusInput = Static<typeof terminalStatusSchema>;
type TerminalCloseInput = Static<typeof terminalCloseSchema>;

export interface TerminalBashToolDetails extends BashToolDetails {
	version: 1;
	operation: "terminal_bash";
	ok: boolean;
	terminalId: string;
	monitorId: string;
	logPath: string;
	durationMs: number;
	diagnostic?: RemoteDiagnostic;
	review: {
		model?: string;
		status: "completed" | "fallback" | "skipped";
		inputTruncated: boolean;
		error?: string;
	};
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

export function getRemoteToolDetails(value: unknown): { operation: string; ok: boolean } | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	return typeof record.operation === "string" && typeof record.ok === "boolean"
		? { operation: record.operation, ok: record.ok }
		: undefined;
}

const CONFIGURED_SSH_IDENTITY_GUIDELINE =
	"Use the target's configured OpenSSH login identity; trusted provider-managed targets may legitimately resolve to root.";
const NO_PRIVILEGE_CHANGE_GUIDELINE =
	"Do not use sudo, su, doas, pkexec, runuser, setpriv, nsenter, chroot, or machinectl to change or switch identities after login.";

const validators = {
	targetSelect: Compile(targetSelectSchema),
	remoteExec: Compile(remoteExecSchema),
	terminalCreate: Compile(terminalCreateSchema),
	terminalBash: Compile(terminalBashSchema),
	terminalRead: Compile(terminalReadSchema),
	terminalWrite: Compile(terminalWriteSchema),
	terminalEdit: Compile(terminalEditSchema),
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
			CONFIGURED_SSH_IDENTITY_GUIDELINE,
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
			"Execute one validated command as the target's configured SSH login identity and return its exit code. Uses that target's configured remote working directory when set.",
		promptSnippet: "Execute a command on the selected SSH target",
		promptGuidelines: [
			NO_PRIVILEGE_CHANGE_GUIDELINE,
			CONFIGURED_SSH_IDENTITY_GUIDELINE,
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
		description:
			"Create a controlled local tmux session whose pane runs SSH as the target's configured SSH login identity.",
		promptSnippet: "Create a local tmux SSH terminal",
		promptGuidelines: [
			"Omit command for an interactive terminal so tmux uses the remote user's default shell.",
			CONFIGURED_SSH_IDENTITY_GUIDELINE,
		],
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
	privilegeRuntime?: PrivilegeRuntime,
): ToolDefinition<
	typeof terminalBashSchema,
	TerminalBashToolDetails | PrivilegeToolDetailsV1,
	TerminalBashRenderState
> {
	const bashRenderer = createBashToolDefinition(runtime.cwd, {
		operations: runtime.createBashOperations(),
		exposeSessionEnvironment: false,
	});
	return {
		name: "terminal_bash",
		label: "terminal_bash",
		description:
			"Execute a Bash command through an existing local tmux terminal whose pane runs SSH. The command inherits the remote shell's current directory and exported environment, returns short successful output directly, reviews long or failed output, and saves complete output to the work log.",
		promptSnippet: "Execute a command in an existing local tmux SSH terminal",
		promptGuidelines: [
			"Use terminal_bash for normal commands in an existing terminal; do not follow it with terminal_status or terminal_capture just to understand the result.",
			"When a Bash-like Tool result includes a model review, trust it on the first pass; read the full log only after a reviewed failure, never after a reviewed success.",
			"When the working directory is known, use one concise command such as cd <workdir> && <command>; do not add a preliminary pwd.",
			"Only use terminal_send and terminal_capture for genuinely interactive input or terminal diagnosis.",
			"Do not add explanatory echo commands, repeated status probes, sleeps, extra capture calls, or nested bash -lc wrappers.",
			"sudo commands in terminal_bash are staged in the controlled tmux terminal; they do not execute until the user presses Enter, and Escape cancels.",
			CONFIGURED_SSH_IDENTITY_GUIDELINE,
		],
		parameters: terminalBashSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal, onUpdate) => {
			validate<TerminalBashInput>("terminal_bash", validators.terminalBash, params);
			if (hasPotentialShellPrivilege(params.command) && privilegeRuntime) {
				const terminal = runtime.getTerminalContext(params.terminalId);
				return privilegeRuntime.execute(
					{
						toolCallId: _toolCallId,
						sourceTool: "terminal_bash",
						route: "terminal_bash",
						command: params.command,
						target: {
							execution: "terminal",
							targetId: terminal.targetId,
							terminalId: params.terminalId,
							monitorId: terminal.monitorId,
						},
						cwd: runtime.cwd,
						timeoutMs: params.timeout ? params.timeout * 1000 : undefined,
					},
					signal,
					onUpdate,
				);
			}
			const result = await runtime.terminalBash(params.terminalId, params.command, {
				signal,
				timeoutMs: params.timeout ? params.timeout * 1000 : undefined,
			});
			return {
				content: [{ type: "text", text: result.report }],
				details: {
					version: 1,
					operation: "terminal_bash",
					ok: result.ok,
					command: result.command,
					exitCode: result.exitCode,
					terminalId: result.terminalId,
					monitorId: result.monitorId,
					logPath: result.logPath,
					durationMs: result.durationMs,
					diagnostic: result.diagnostic,
					review: result.review,
				},
				usage: result.usage,
			};
		},
		renderCall: (args, currentTheme, context) => {
			if (context.executionStarted && context.state.startedAt === undefined) {
				context.state.startedAt = Date.now();
				context.state.endedAt = undefined;
			}
			const privilege = inspectShellPrivilege(args.command);
			return renderTerminalCall(
				privilege.sudo ? "Sudo Terminal Bash" : "Terminal Bash",
				args.terminalId,
				`${singleLineSummary(args.command)}${args.timeout ? ` · timeout ${args.timeout}s` : ""}`,
				currentTheme,
				context.lastComponent,
			);
		},
		renderResult: (result, options, currentTheme, context) =>
			bashRenderer.renderResult?.(
				result as AgentToolResult<BashToolDetails>,
				options,
				currentTheme,
				context as never,
			) ?? textComponent("", context.lastComponent),
	};
}

function createTerminalReadTool(
	runtime: RemoteExecutionRuntime,
): ToolDefinition<typeof terminalReadSchema, ReadToolDetails | undefined> {
	const base = createReadToolDefinition(runtime.cwd);
	return {
		...base,
		name: "terminal_read",
		label: "terminal_read",
		description:
			"Read a file through an existing local tmux SSH terminal. Relative paths resolve from that remote shell's current directory, and text, image, truncation, and rendering behavior matches read.",
		promptSnippet: "Read a file in an existing local tmux SSH terminal",
		promptGuidelines: [
			"Use terminal_read for file contents that must resolve from an existing terminal's current directory and exported environment.",
			"Use read for local files and remote_read for one-shot SSH paths rooted at the configured target cwd.",
		],
		parameters: terminalReadSchema,
		prepareArguments: undefined,
		executionMode: "sequential",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			validate<TerminalReadInput>("terminal_read", validators.terminalRead, params);
			const { terminalId, ...input } = params;
			return createReadToolDefinition(runtime.cwd, {
				operations: runtime.createTerminalReadOperations(terminalId),
			}).execute(toolCallId, input, signal, onUpdate, ctx);
		},
		renderCall(args, currentTheme, context) {
			return createReadToolDefinition(runtime.cwd, {
				displayName: "Terminal Read",
				displayContext: args.terminalId,
			}).renderCall!(args, currentTheme, context as never);
		},
		renderResult(result, options, currentTheme, context) {
			const terminalId = (context.args as TerminalReadInput).terminalId;
			return createReadToolDefinition(runtime.cwd, {
				displayName: "Terminal Read",
				displayContext: terminalId,
			}).renderResult!(result, options, currentTheme, context as never);
		},
	};
}

function createTerminalWriteTool(
	runtime: RemoteExecutionRuntime,
): ToolDefinition<typeof terminalWriteSchema, WriteToolDetails> {
	const base = createWriteToolDefinition(runtime.cwd);
	return {
		...base,
		name: "terminal_write",
		label: "terminal_write",
		description:
			"Write a text file through an existing local tmux SSH terminal. Relative paths resolve from that remote shell's current directory, parent directories are created, and rendering matches write.",
		promptSnippet: "Create or overwrite a file in an existing local tmux SSH terminal",
		promptGuidelines: [
			"Use terminal_write for complete file writes that must resolve from an existing terminal's current directory and exported environment.",
			"Use terminal_edit instead for precise replacements in an existing remote file.",
		],
		parameters: terminalWriteSchema,
		prepareArguments: undefined,
		executionMode: "sequential",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			validate<TerminalWriteInput>("terminal_write", validators.terminalWrite, params);
			const { terminalId, ...input } = params;
			return createWriteToolDefinition(runtime.cwd, {
				operations: runtime.createTerminalWriteOperations(terminalId),
			}).execute(toolCallId, input, signal, onUpdate, ctx);
		},
		renderCall(args, currentTheme, context) {
			return createWriteToolDefinition(runtime.cwd, {
				displayName: "Terminal Write",
				displayContext: args.terminalId,
			}).renderCall!(args, currentTheme, context as never);
		},
		renderResult(result, options, currentTheme, context) {
			const terminalId = (context.args as TerminalWriteInput).terminalId;
			return createWriteToolDefinition(runtime.cwd, {
				displayName: "Terminal Write",
				displayContext: terminalId,
			}).renderResult!(result, options, currentTheme, context as never);
		},
	};
}

function createTerminalEditTool(
	runtime: RemoteExecutionRuntime,
): ToolDefinition<typeof terminalEditSchema, EditToolDetails | undefined> {
	const base = createEditToolDefinition(runtime.cwd);
	return {
		...base,
		name: "terminal_edit",
		label: "terminal_edit",
		description:
			"Edit one text file through an existing local tmux SSH terminal using the same exact, unique, non-overlapping replacements as edit. Relative paths resolve from that remote shell's current directory.",
		promptSnippet: "Apply precise edits to a file in an existing local tmux SSH terminal",
		promptGuidelines: [
			"Use terminal_edit for precise remote file changes in an existing terminal; every edits[].oldText must match exactly and uniquely.",
			"Keep separate replacements in one call and merge nearby or overlapping changes.",
		],
		parameters: terminalEditSchema,
		prepareArguments(input) {
			const terminalId =
				typeof input === "object" && input !== null && "terminalId" in input
					? (input as { terminalId?: unknown }).terminalId
					: undefined;
			return { ...base.prepareArguments?.(input), terminalId } as TerminalEditInput;
		},
		executionMode: "sequential",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			validate<TerminalEditInput>("terminal_edit", validators.terminalEdit, params);
			const { terminalId, ...input } = params;
			return createEditToolDefinition(runtime.cwd, {
				operations: runtime.createTerminalEditOperations(terminalId),
				previewDiff: false,
			}).execute(toolCallId, input, signal, onUpdate, ctx);
		},
		renderCall(args, currentTheme, context) {
			return createEditToolDefinition(runtime.cwd, {
				displayName: "Terminal Update",
				displayContext: args.terminalId,
				previewDiff: false,
			}).renderCall!(args, currentTheme, context as never);
		},
		renderResult(result, options, currentTheme, context) {
			const terminalId = (context.args as TerminalEditInput).terminalId;
			return createEditToolDefinition(runtime.cwd, {
				displayName: "Terminal Update",
				displayContext: terminalId,
				previewDiff: false,
			}).renderResult!(result, options, currentTheme, context as never);
		},
	};
}

function createTerminalSendTool(
	runtime: RemoteExecutionRuntime,
): ToolDefinition<typeof terminalSendSchema, RemoteToolDetails> {
	return {
		name: "terminal_send",
		label: "terminal_send",
		description:
			"Send literal input to an existing local tmux pane whose process is SSH for genuinely interactive terminal control.",
		promptSnippet: "Send interactive input to a local tmux SSH terminal",
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
			"Capture only new output from a local tmux SSH terminal using a cursor; complete output remains in the work log.",
		promptSnippet: "Read incremental output from a local tmux SSH terminal",
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
		description: "Read deterministic local tmux existence and Monitor status for a terminal.",
		promptSnippet: "Check a local tmux SSH terminal status",
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
			"Close a local tmux SSH terminal and its Monitor lifecycle without closing the SSH target unless requested separately.",
		promptSnippet: "Close a local tmux SSH terminal",
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
export function createRemoteToolDefinitions(
	runtime: RemoteExecutionRuntime,
	privilegeRuntime?: PrivilegeRuntime,
): ToolDefinition[] {
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
		createTerminalBashTool(runtime, privilegeRuntime),
		createTerminalReadTool(runtime),
		createTerminalWriteTool(runtime),
		createTerminalEditTool(runtime),
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
	terminalReadSchema,
	terminalWriteSchema,
	terminalEditSchema,
	terminalCaptureSchema,
	terminalCloseSchema,
	terminalCreateSchema,
	terminalSendSchema,
	terminalStatusSchema,
};
