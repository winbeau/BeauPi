import { resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { MonitorRuntime } from "./monitor-runtime.ts";
import { MONITOR_RECORD_VERSION, type MonitorRecord, type MonitorStatus, type MonitorSummary } from "./types.ts";

const monitorAttachSchema = Type.Object({
	kind: Type.Union([
		Type.Literal("process"),
		Type.Literal("tool"),
		Type.Literal("sub-agent"),
		Type.Literal("ssh-tmux"),
	]),
	pid: Type.Optional(Type.Integer({ minimum: 1 })),
	toolCallId: Type.Optional(Type.String({ minLength: 1 })),
	taskId: Type.Optional(Type.String({ minLength: 1 })),
	profile: Type.Optional(Type.String({ minLength: 1 })),
	targetId: Type.Optional(Type.String({ minLength: 1 })),
	sessionId: Type.Optional(Type.String({ minLength: 1 })),
	name: Type.Optional(Type.String({ minLength: 1 })),
	taskSummary: Type.Optional(Type.String({ minLength: 1 })),
	logPath: Type.Optional(Type.String({ minLength: 1 })),
	stallTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

const monitorListSchema = Type.Object({
	kind: Type.Optional(
		Type.Union([Type.Literal("process"), Type.Literal("tool"), Type.Literal("sub-agent"), Type.Literal("ssh-tmux")]),
	),
	status: Type.Optional(
		Type.Union([
			Type.Literal("starting"),
			Type.Literal("running"),
			Type.Literal("healthy"),
			Type.Literal("stalled"),
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("cancelled"),
			Type.Literal("lost"),
		]),
	),
	includeTerminal: Type.Optional(Type.Boolean()),
});

const monitorStatusSchema = Type.Object({ monitorId: Type.String({ minLength: 1 }) });

const monitorLogsSchema = Type.Object({
	monitorId: Type.String({ minLength: 1 }),
	cursor: Type.Optional(Type.Integer({ minimum: 0 })),
	mode: Type.Optional(Type.Union([Type.Literal("incremental"), Type.Literal("full")])),
});

const monitorWaitSchema = Type.Object({
	monitorId: Type.String({ minLength: 1 }),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

const monitorStopSchema = Type.Object({
	monitorId: Type.String({ minLength: 1 }),
	force: Type.Optional(Type.Boolean()),
});

type MonitorAttachInput = Static<typeof monitorAttachSchema>;
type MonitorListInput = Static<typeof monitorListSchema>;
type MonitorStatusInput = Static<typeof monitorStatusSchema>;
type MonitorLogsInput = Static<typeof monitorLogsSchema>;
type MonitorWaitInput = Static<typeof monitorWaitSchema>;
type MonitorStopInput = Static<typeof monitorStopSchema>;

export interface MonitorToolDetails {
	version: typeof MONITOR_RECORD_VERSION;
	ok: boolean;
	operation: string;
	monitor?: MonitorRecord;
	monitors?: MonitorRecord[];
	summary?: MonitorSummary;
	logs?: {
		cursor: number;
		hash: string;
		changed: boolean;
		truncated: boolean;
		rotated: boolean;
		missing: boolean;
		logPath?: string;
	};
	error?: { code: string; message: string };
}

const attachValidator = Compile(monitorAttachSchema);
const listValidator = Compile(monitorListSchema);
const statusValidator = Compile(monitorStatusSchema);
const logsValidator = Compile(monitorLogsSchema);
const waitValidator = Compile(monitorWaitSchema);
const stopValidator = Compile(monitorStopSchema);

function validateParameters<T>(
	toolName: string,
	validator: { Check(value: unknown): boolean },
	value: unknown,
): asserts value is T {
	if (!validator.Check(value)) throw new Error(`${toolName} received invalid parameters`);
}

function operationResult(
	operation: string,
	details: Omit<MonitorToolDetails, "version" | "operation">,
): MonitorToolDetails {
	return { version: MONITOR_RECORD_VERSION, operation, ...details };
}

function resultText(result: AgentToolResult<MonitorToolDetails>): string {
	return result.content.map((item) => (item.type === "text" ? item.text : "")).join("");
}

function statusColor(status: MonitorStatus): "accent" | "success" | "warning" | "error" | "muted" | "dim" {
	if (status === "starting" || status === "running" || status === "healthy")
		return status === "healthy" ? "success" : "accent";
	if (status === "completed") return "success";
	if (status === "failed") return "error";
	if (status === "stalled" || status === "lost") return "warning";
	if (status === "cancelled") return "muted";
	return "dim";
}

function monitorLine(record: MonitorRecord, theme: Theme, now = Date.now()): string {
	const duration = record.durationMs > 0 ? `${(record.durationMs / 1000).toFixed(1)}s` : "0.0s";
	const activityAge = Math.max(0, now - record.lastActivityAt);
	const activity = activityAge >= 1000 ? ` · idle ${(activityAge / 1000).toFixed(0)}s` : "";
	return `${theme.fg(statusColor(record.status), "●")} ${record.name} · ${theme.fg(statusColor(record.status), record.status)} · ${duration}${activity}`;
}

function plainMonitorLine(record: MonitorRecord, now = Date.now()): string {
	const duration = record.durationMs > 0 ? `${(record.durationMs / 1000).toFixed(1)}s` : "0.0s";
	const activityAge = Math.max(0, now - record.lastActivityAt);
	const activity = activityAge >= 1000 ? ` · idle ${(activityAge / 1000).toFixed(0)}s` : "";
	return `● ${record.name} · ${record.status} · ${duration}${activity}`;
}

function monitorCall(name: string, summary: string, theme: Theme): Text {
	return new Text(`${theme.bold(name)}(${summary})`, 0, 0);
}

function monitorResult(
	result: AgentToolResult<MonitorToolDetails>,
	options: { expanded: boolean },
	theme: Theme,
): Text {
	const details = result.details;
	if (details.operation === "monitor_logs") {
		const text = resultText(result);
		const lines = details.monitor ? [monitorLine(details.monitor, theme), text] : [text];
		if (details.monitor?.logPath) lines.splice(1, 0, theme.fg("dim", `Log: ${details.monitor.logPath}`));
		if (details.error) lines.push(theme.fg("error", details.error.message));
		const output = lines.join("\n");
		return new Text(options.expanded || output.length <= 800 ? output : `${output.slice(0, 799)}…`, 0, 0);
	}
	if (details.monitor) {
		const lines = [monitorLine(details.monitor, theme)];
		if (details.monitor.logPath) lines.push(theme.fg("dim", `Log: ${details.monitor.logPath}`));
		if (details.error) lines.push(theme.fg("error", details.error.message));
		return new Text(lines.join("\n"), 0, 0);
	}
	if (details.monitors) {
		const lines = details.monitors.map((record) => monitorLine(record, theme));
		if (lines.length === 0) lines.push(theme.fg("dim", "No monitors registered."));
		return new Text(lines.join("\n"), 0, 0);
	}
	return new Text(resultText(result), 0, 0);
}

function attachTarget(runtime: MonitorRuntime, params: MonitorAttachInput) {
	const logPath = params.logPath ? resolve(runtime.cwd, params.logPath) : undefined;
	switch (params.kind) {
		case "process":
			if (params.pid === undefined) throw new Error("monitor_attach process targets require pid");
			return {
				target: { kind: "process" as const, pid: params.pid, logPath },
				name: params.name,
				taskSummary: params.taskSummary,
				stallTimeoutMs: params.stallTimeoutMs,
				timeoutMs: params.timeoutMs,
			};
		case "tool":
			if (!params.toolCallId) throw new Error("monitor_attach Tool targets require toolCallId");
			return {
				target: { kind: "tool" as const, toolCallId: params.toolCallId, logPath },
				name: params.name,
				taskSummary: params.taskSummary,
				stallTimeoutMs: params.stallTimeoutMs,
				timeoutMs: params.timeoutMs,
			};
		case "sub-agent":
			if (!params.taskId) throw new Error("monitor_attach sub-agent targets require taskId");
			return {
				target: { kind: "sub-agent" as const, taskId: params.taskId, profile: params.profile, logPath },
				name: params.name,
				taskSummary: params.taskSummary,
				stallTimeoutMs: params.stallTimeoutMs,
				timeoutMs: params.timeoutMs,
			};
		case "ssh-tmux":
			return {
				target: { kind: "ssh-tmux" as const, targetId: params.targetId, sessionId: params.sessionId, logPath },
				name: params.name,
				taskSummary: params.taskSummary,
				stallTimeoutMs: params.stallTimeoutMs,
				timeoutMs: params.timeoutMs,
			};
	}
}

function createAttachTool(runtime: MonitorRuntime): ToolDefinition<typeof monitorAttachSchema, MonitorToolDetails> {
	return {
		name: "monitor_attach",
		label: "monitor_attach",
		description:
			"Attach the session Monitor Runtime to a local process, Tool, sub-agent, or reserved SSH/tmux target.",
		promptSnippet: "Attach a target to the session Monitor Runtime",
		promptGuidelines: [
			"Monitor facts are deterministic; do not infer business state from log text.",
			"SSH/tmux monitor attachment is reserved for M7 and does not open a remote connection in M6.",
		],
		parameters: monitorAttachSchema,
		execute: async (_toolCallId, params) => {
			validateParameters<MonitorAttachInput>("monitor_attach", attachValidator, params);
			const record = runtime.attach(attachTarget(runtime, params));
			return {
				content: [{ type: "text", text: plainMonitorLine(record) }],
				details: operationResult("monitor_attach", { ok: true, monitor: record }),
			};
		},
		renderCall: (args, theme) => monitorCall("Monitor Attach", args.kind, theme),
		renderResult: (result, options, theme) =>
			monitorResult(result as AgentToolResult<MonitorToolDetails>, options, theme),
	};
}

function createListTool(runtime: MonitorRuntime): ToolDefinition<typeof monitorListSchema, MonitorToolDetails> {
	return {
		name: "monitor_list",
		label: "monitor_list",
		description: "List session-scoped Monitor records and deterministic lifecycle status.",
		promptSnippet: "List monitored targets and their status",
		parameters: monitorListSchema,
		execute: async (_toolCallId, params) => {
			validateParameters<MonitorListInput>("monitor_list", listValidator, params);
			const monitors = runtime.list(params);
			return {
				content: [
					{
						type: "text",
						text:
							monitors.map((record) => `${record.id} ${record.status} ${record.name}`).join("\n") ||
							"No monitors registered.",
					},
				],
				details: operationResult("monitor_list", { ok: true, monitors, summary: runtime.getSummary() }),
			};
		},
		renderCall: (_args, theme) => monitorCall("Monitor List", "", theme),
		renderResult: (result, options, theme) =>
			monitorResult(result as AgentToolResult<MonitorToolDetails>, options, theme),
	};
}

function createStatusTool(runtime: MonitorRuntime): ToolDefinition<typeof monitorStatusSchema, MonitorToolDetails> {
	return {
		name: "monitor_status",
		label: "monitor_status",
		description: "Read one Monitor record with status, duration, activity, exit reason, resources, and log path.",
		promptSnippet: "Inspect one Monitor status snapshot",
		parameters: monitorStatusSchema,
		execute: async (_toolCallId, params) => {
			validateParameters<MonitorStatusInput>("monitor_status", statusValidator, params);
			const monitor = runtime.status(params.monitorId);
			return {
				content: [{ type: "text", text: plainMonitorLine(monitor) }],
				details: operationResult("monitor_status", { ok: true, monitor }),
			};
		},
		renderCall: (args, theme) => monitorCall("Monitor Status", args.monitorId, theme),
		renderResult: (result, options, theme) =>
			monitorResult(result as AgentToolResult<MonitorToolDetails>, options, theme),
	};
}

function createLogsTool(runtime: MonitorRuntime): ToolDefinition<typeof monitorLogsSchema, MonitorToolDetails> {
	return {
		name: "monitor_logs",
		label: "monitor_logs",
		description: "Read only new Monitor log bytes by cursor/hash, or explicitly request the complete log.",
		promptSnippet: "Read incremental Monitor logs without repeating history",
		parameters: monitorLogsSchema,
		execute: async (_toolCallId, params) => {
			validateParameters<MonitorLogsInput>("monitor_logs", logsValidator, params);
			const result = await runtime.logs(params.monitorId, { cursor: params.cursor, mode: params.mode });
			const content = result.missing
				? (result.diagnostic ?? "No log is available.")
				: result.content || "No new log output.";
			return {
				content: [{ type: "text", text: content }],
				details: operationResult("monitor_logs", {
					ok: !result.missing,
					monitor: result.monitor,
					logs: {
						cursor: result.cursor,
						hash: result.hash,
						changed: result.changed,
						truncated: result.truncated,
						rotated: result.rotated,
						missing: result.missing,
						logPath: result.path || undefined,
					},
					error: result.missing
						? { code: "log_unavailable", message: result.diagnostic ?? "Log is unavailable" }
						: undefined,
				}),
			};
		},
		renderCall: (args, theme) => monitorCall("Monitor Logs", args.monitorId, theme),
		renderResult: (result, options, theme) =>
			monitorResult(result as AgentToolResult<MonitorToolDetails>, options, theme),
	};
}

function createWaitTool(runtime: MonitorRuntime): ToolDefinition<typeof monitorWaitSchema, MonitorToolDetails> {
	return {
		name: "monitor_wait",
		label: "monitor_wait",
		description: "Wait for a Monitor target to reach a terminal state without starting a model review.",
		promptSnippet: "Wait for a monitored target to finish",
		parameters: monitorWaitSchema,
		execute: async (_toolCallId, params) => {
			validateParameters<MonitorWaitInput>("monitor_wait", waitValidator, params);
			try {
				const monitor = await runtime.wait(params.monitorId, params.timeoutMs);
				return {
					content: [{ type: "text", text: plainMonitorLine(monitor) }],
					details: operationResult("monitor_wait", { ok: true, monitor }),
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const monitor = runtime.status(params.monitorId);
				return {
					content: [{ type: "text", text: message }],
					details: operationResult("monitor_wait", {
						ok: false,
						monitor,
						error: { code: "wait_timeout", message },
					}),
				};
			}
		},
		renderCall: (args, theme) => monitorCall("Monitor Wait", args.monitorId, theme),
		renderResult: (result, options, theme) =>
			monitorResult(result as AgentToolResult<MonitorToolDetails>, options, theme),
	};
}

function createStopTool(runtime: MonitorRuntime): ToolDefinition<typeof monitorStopSchema, MonitorToolDetails> {
	return {
		name: "monitor_stop",
		label: "monitor_stop",
		description: "Request cancellation of a cancellable monitored target.",
		promptSnippet: "Stop a cancellable monitored target",
		parameters: monitorStopSchema,
		execute: async (_toolCallId, params) => {
			validateParameters<MonitorStopInput>("monitor_stop", stopValidator, params);
			const result = await runtime.stop(params.monitorId, params.force ?? false);
			return {
				content: [
					{
						type: "text",
						text: result.result.accepted
							? `Stop requested: ${result.record.id}`
							: `Stop not accepted: ${result.result.reason ?? "unknown"}`,
					},
				],
				details: operationResult("monitor_stop", {
					ok: result.result.accepted,
					monitor: result.record,
					error: result.result.accepted
						? undefined
						: { code: "stop_rejected", message: result.result.reason ?? "Stop was not accepted" },
				}),
			};
		},
		renderCall: (args, theme) => monitorCall("Monitor Stop", args.monitorId, theme),
		renderResult: (result, options, theme) =>
			monitorResult(result as AgentToolResult<MonitorToolDetails>, options, theme),
	};
}

export function createMonitorToolDefinitions(runtime: MonitorRuntime): ToolDefinition[] {
	return [
		createAttachTool(runtime),
		createListTool(runtime),
		createStatusTool(runtime),
		createLogsTool(runtime),
		createWaitTool(runtime),
		createStopTool(runtime),
	] as unknown as ToolDefinition[];
}

export {
	monitorAttachSchema,
	monitorListSchema,
	monitorLogsSchema,
	monitorStatusSchema,
	monitorStopSchema,
	monitorWaitSchema,
};
