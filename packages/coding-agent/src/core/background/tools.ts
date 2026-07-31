import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import { Compile } from "typebox/compile";
import { BackgroundTaskComponent } from "../../modes/interactive/components/background.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { BackgroundTaskManager } from "./background-runtime.ts";
import { attachBackgroundToolDetails, getBackgroundToolDetails } from "./details.ts";
import {
	BACKGROUND_ATTACH_SCHEMA,
	BACKGROUND_CANCEL_SCHEMA,
	BACKGROUND_LOGS_SCHEMA,
	BACKGROUND_START_SCHEMA,
	BACKGROUND_STATUS_SCHEMA,
	BACKGROUND_WAIT_SCHEMA,
} from "./schema.ts";
import {
	BACKGROUND_DETAILS_VERSION,
	type BackgroundAttachInput,
	type BackgroundStartInput,
	type BackgroundTaskSnapshotV1,
	type BackgroundToolDetailsV1,
} from "./types.ts";

export type BackgroundStartParameters = Static<typeof BACKGROUND_START_SCHEMA>;
export type BackgroundAttachParameters = Static<typeof BACKGROUND_ATTACH_SCHEMA>;
export type BackgroundStatusParameters = Static<typeof BACKGROUND_STATUS_SCHEMA>;
export type BackgroundLogsParameters = Static<typeof BACKGROUND_LOGS_SCHEMA>;
export type BackgroundWaitParameters = Static<typeof BACKGROUND_WAIT_SCHEMA>;
export type BackgroundCancelParameters = Static<typeof BACKGROUND_CANCEL_SCHEMA>;

const validators = {
	background_start: Compile(BACKGROUND_START_SCHEMA),
	background_attach: Compile(BACKGROUND_ATTACH_SCHEMA),
	background_status: Compile(BACKGROUND_STATUS_SCHEMA),
	background_logs: Compile(BACKGROUND_LOGS_SCHEMA),
	background_wait: Compile(BACKGROUND_WAIT_SCHEMA),
	background_cancel: Compile(BACKGROUND_CANCEL_SCHEMA),
};

function validate(name: keyof typeof validators, value: unknown): void {
	if (!validators[name].Check(value)) throw new Error(`${name} received invalid parameters`);
}

function details(
	operation: BackgroundToolDetailsV1["operation"],
	value: Omit<BackgroundToolDetailsV1, "version" | "operation">,
): BackgroundToolDetailsV1 {
	return { version: BACKGROUND_DETAILS_VERSION, operation, ...value };
}

function summaryText(task: BackgroundTaskSnapshotV1): string {
	const monitor = task.monitor;
	const target = monitor?.target.kind === "process" ? `pid ${monitor.target.pid}` : (monitor?.target.kind ?? "target");
	return `${task.id} · ${task.status} · ${target}${monitor?.logPath ? ` · ${monitor.logPath}` : ""}`;
}

function renderResult(result: AgentToolResult<unknown>, options: { expanded: boolean }, theme: Theme) {
	const parsed = getBackgroundToolDetails(result.details);
	if (parsed?.task) return new BackgroundTaskComponent([parsed.task], parsed.summary, theme, options.expanded);
	if (parsed?.tasks) return new BackgroundTaskComponent(parsed.tasks, parsed.summary, theme, options.expanded);
	if (parsed?.logs) {
		const lines = [
			`${parsed.logs.mode} · cursor ${parsed.logs.cursor} · ${parsed.logs.changed ? "new output" : "unchanged"}`,
			parsed.logs.logPath ? `Log: ${parsed.logs.logPath}` : "",
			parsed.logs.diagnostic ?? "",
		].filter(Boolean);
		return new Text(lines.join("\n"), 0, 0);
	}
	return new Text(parsed?.error?.message ?? "Background result unavailable", 0, 0);
}

function textResult(text: string, metadata: BackgroundToolDetailsV1): AgentToolResult<Record<string, unknown>> {
	return { content: [{ type: "text", text }], details: attachBackgroundToolDetails(undefined, metadata) };
}

function taskInput(params: BackgroundStartParameters): BackgroundStartInput {
	return params;
}

function attachInput(params: BackgroundAttachParameters): BackgroundAttachInput {
	return params;
}

function createStartTool(
	runtime: BackgroundTaskManager,
): ToolDefinition<typeof BACKGROUND_START_SCHEMA, Record<string, unknown>> {
	return {
		name: "background_start",
		label: "Background",
		description: "Start a local executable as a session-scoped background task and return immediately.",
		promptSnippet: "background_start: start an executable with structured monitoring and optional wake triggers",
		promptGuidelines: [
			"Prefer executable plus args; do not concatenate a shell command unless the executable itself is a shell.",
			"background_start returns immediately. Use background_wait to register automatic wake delivery.",
		],
		parameters: BACKGROUND_START_SCHEMA,
		executionMode: "parallel",
		execute: async (_toolCallId, params, signal) => {
			validate("background_start", params);
			try {
				const task = await runtime.start(taskInput(params), signal);
				return textResult(summaryText(task), details("background_start", { ok: true, task }));
			} catch (error) {
				if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
				const message = error instanceof Error ? error.message : String(error);
				return textResult(
					message,
					details("background_start", { ok: false, error: { code: "start_failed", message } }),
				);
			}
		},
		renderCall: (args, theme) => new Text(`${theme.bold("Background")}(${args.executable})`, 0, 0),
		renderResult,
	};
}

function createAttachTool(
	runtime: BackgroundTaskManager,
): ToolDefinition<typeof BACKGROUND_ATTACH_SCHEMA, Record<string, unknown>> {
	return {
		name: "background_attach",
		label: "Background Attach",
		description: "Adopt a local process or SSH/tmux target already confirmed by the existing Monitor adapter.",
		promptSnippet: "background_attach: adopt an existing Monitor target without creating a second monitor",
		parameters: BACKGROUND_ATTACH_SCHEMA,
		executionMode: "parallel",
		execute: async (_toolCallId, params) => {
			validate("background_attach", params);
			try {
				const task = await runtime.attach(attachInput(params));
				return textResult(summaryText(task), details("background_attach", { ok: true, task }));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(
					message,
					details("background_attach", { ok: false, error: { code: "attach_failed", message } }),
				);
			}
		},
		renderCall: (args, theme) => new Text(`${theme.bold("Background Attach")}(${args.monitorId})`, 0, 0),
		renderResult,
	};
}

function createStatusTool(
	runtime: BackgroundTaskManager,
): ToolDefinition<typeof BACKGROUND_STATUS_SCHEMA, Record<string, unknown>> {
	return {
		name: "background_status",
		label: "Background Status",
		description: "Read deterministic Background Task and existing Monitor state without calling a model.",
		promptSnippet: "background_status: inspect background task snapshots and wake counts",
		parameters: BACKGROUND_STATUS_SCHEMA,
		executionMode: "parallel",
		execute: async (_toolCallId, params) => {
			validate("background_status", params);
			try {
				const value = await runtime.status(params.taskId, params.includeTerminal ?? true);
				if (Array.isArray(value)) {
					return textResult(
						JSON.stringify(value),
						details("background_status", { ok: true, tasks: value, summary: runtime.getSummary() }),
					);
				}
				return textResult(
					summaryText(value),
					details("background_status", { ok: true, task: value, summary: runtime.getSummary() }),
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(
					message,
					details("background_status", { ok: false, error: { code: "status_failed", message } }),
				);
			}
		},
		renderCall: (args, theme) => new Text(`${theme.bold("Background Status")}(${args.taskId ?? ""})`, 0, 0),
		renderResult,
	};
}

function createLogsTool(
	runtime: BackgroundTaskManager,
): ToolDefinition<typeof BACKGROUND_LOGS_SCHEMA, Record<string, unknown>> {
	return {
		name: "background_logs",
		label: "Background Logs",
		description: "Read bounded incremental, tail, error, summary, or full background logs by cursor and hash.",
		promptSnippet: "background_logs: read only new output by cursor/hash; full logs remain on disk",
		parameters: BACKGROUND_LOGS_SCHEMA,
		executionMode: "parallel",
		execute: async (_toolCallId, params) => {
			validate("background_logs", params);
			try {
				const value = await runtime.logs(params.taskId, params);
				const logs = value.logs;
				const text = logs.content || (logs.logPath ? `No new output. Full log: ${logs.logPath}` : "No new output.");
				const { content: _content, ...metadataLogs } = logs;
				return {
					content: [{ type: "text", text }],
					details: attachBackgroundToolDetails(
						undefined,
						details("background_logs", { ok: !logs.missing, task: value.task, logs: metadataLogs }),
					),
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(
					message,
					details("background_logs", { ok: false, error: { code: "logs_failed", message } }),
				);
			}
		},
		renderCall: (args, theme) => new Text(`${theme.bold("Background Logs")}(${args.taskId})`, 0, 0),
		renderResult,
	};
}

function createWaitTool(
	runtime: BackgroundTaskManager,
): ToolDefinition<typeof BACKGROUND_WAIT_SCHEMA, Record<string, unknown>> {
	return {
		name: "background_wait",
		label: "Background Wait",
		description: "Register wake triggers for a background task and return immediately so the current turn can end.",
		promptSnippet: "background_wait: register deterministic wake targets without blocking the turn",
		parameters: BACKGROUND_WAIT_SCHEMA,
		executionMode: "parallel",
		execute: async (_toolCallId, params) => {
			validate("background_wait", params);
			try {
				const task = await runtime.wait(params.taskId, params.triggers);
				return textResult(
					`Wake registered: ${summaryText(task)}`,
					details("background_wait", { ok: true, task, summary: runtime.getSummary() }),
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(
					message,
					details("background_wait", { ok: false, error: { code: "wait_failed", message } }),
				);
			}
		},
		renderCall: (args, theme) => new Text(`${theme.bold("Background Wait")}(${args.taskId})`, 0, 0),
		renderResult,
	};
}

function createCancelTool(
	runtime: BackgroundTaskManager,
): ToolDefinition<typeof BACKGROUND_CANCEL_SCHEMA, Record<string, unknown>> {
	return {
		name: "background_cancel",
		label: "Background Cancel",
		description:
			"Gracefully stop a background task, then force-stop its local process tree after a bounded grace period.",
		promptSnippet: "background_cancel: request graceful cancellation with deterministic escalation",
		parameters: BACKGROUND_CANCEL_SCHEMA,
		executionMode: "parallel",
		execute: async (_toolCallId, params, signal) => {
			validate("background_cancel", params);
			try {
				const value = await runtime.cancel(params.taskId, params.graceMs, signal);
				const ok = value.cancel.accepted || value.cancel.reason === "already_terminal";
				return textResult(
					value.task ? summaryText(value.task) : value.cancel.reason,
					details("background_cancel", {
						ok,
						task: value.task,
						cancel: value.cancel,
						summary: runtime.getSummary(),
					}),
				);
			} catch (error) {
				if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
				const message = error instanceof Error ? error.message : String(error);
				return textResult(
					message,
					details("background_cancel", { ok: false, error: { code: "cancel_failed", message } }),
				);
			}
		},
		renderCall: (args, theme) => new Text(`${theme.bold("Background Cancel")}(${args.taskId})`, 0, 0),
		renderResult,
	};
}

export function createBackgroundToolDefinitions(runtime: BackgroundTaskManager): ToolDefinition[] {
	return [
		createStartTool(runtime),
		createAttachTool(runtime),
		createStatusTool(runtime),
		createLogsTool(runtime),
		createWaitTool(runtime),
		createCancelTool(runtime),
	] as ToolDefinition[];
}

export {
	BACKGROUND_ATTACH_SCHEMA,
	BACKGROUND_CANCEL_SCHEMA,
	BACKGROUND_LOGS_SCHEMA,
	BACKGROUND_START_SCHEMA,
	BACKGROUND_STATUS_SCHEMA,
	BACKGROUND_WAIT_SCHEMA,
};
