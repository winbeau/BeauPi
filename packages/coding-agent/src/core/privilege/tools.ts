import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { RemoteExecutionRuntime } from "../remote/runtime.ts";
import { type BashToolDetails, createBashToolDefinition } from "../tools/bash.ts";
import type { PrivilegeRuntime } from "./runtime.ts";
import type { PrivilegeToolDetailsV1 } from "./types.ts";

const localPrivilegeSchema = Type.Object(
	{
		execution: Type.Literal("local"),
		command: Type.String({
			minLength: 1,
			description: "Complete sudo command or newline-separated command batch to stage in the terminal",
		}),
		timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Timeout in seconds" })),
	},
	{ additionalProperties: false },
);
const terminalPrivilegeSchema = Type.Object(
	{
		execution: Type.Literal("terminal"),
		terminalId: Type.String({ minLength: 1, description: "Existing interactive terminal id" }),
		command: Type.String({
			minLength: 1,
			description: "Complete sudo command or newline-separated command batch to stage in the terminal",
		}),
		timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Timeout in seconds" })),
	},
	{ additionalProperties: false },
);
export const PRIVILEGED_EXEC_PARAMETERS = Type.Union([localPrivilegeSchema, terminalPrivilegeSchema]);
export type PrivilegedExecInput = Static<typeof PRIVILEGED_EXEC_PARAMETERS>;

const validator = Compile(PRIVILEGED_EXEC_PARAMETERS);

type PrivilegeRenderState = {
	startedAt?: number;
	endedAt?: number;
	interval?: NodeJS.Timeout;
};

class PrivilegeCallComponent implements Component {
	private title = "Sudo Bash";
	private command = "";
	private context = "";
	private currentTheme: Theme | undefined;

	setCall(title: string, command: string, context: string, currentTheme: Theme): void {
		this.title = title;
		this.command = command.replace(/[ \t]*(?:\r\n|\r|\n)[ \t]*/g, " ").trim();
		this.context = context;
		this.currentTheme = currentTheme;
	}

	render(width: number): string[] {
		const available = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (available === 0 || !this.currentTheme) return [];
		const title = this.currentTheme.fg("toolTitle", this.currentTheme.bold(this.title));
		const context = this.context ? ` ${this.currentTheme.fg("toolOutput", `[${this.context}]`)}` : "";
		const prefix = `${title}${context}(`;
		const suffix = ")";
		const commandWidth = available - visibleWidth(prefix) - visibleWidth(suffix);
		if (commandWidth <= 0) return [truncateToWidth(`${title}${context}`, available, "…")];
		return [
			`${prefix}${truncateToWidth(this.currentTheme.fg("toolOutput", this.command), commandWidth, "…")}${suffix}`,
		];
	}

	invalidate(): void {}
}

export function createPrivilegedExecToolDefinition(
	runtime: PrivilegeRuntime,
	remoteRuntime: RemoteExecutionRuntime,
	cwd: string,
): ToolDefinition<typeof PRIVILEGED_EXEC_PARAMETERS, PrivilegeToolDetailsV1, PrivilegeRenderState> {
	const bashRenderer = createBashToolDefinition(cwd, { exposeSessionEnvironment: false });
	return {
		name: "privileged_exec",
		label: "privileged_exec",
		description:
			"Stage one complete sudo command or newline-separated command batch in a controlled local or existing remote tmux terminal. The text is displayed but not executed until the user presses Enter; after authentication the view detaches while output continues to the work log, and authentication input stays in the controlling TTY.",
		promptSnippet: "Stage sudo commands for user-controlled execution in the secure tmux terminal",
		promptGuidelines: [
			"Use privileged_exec whenever a complete command requires sudo; the command is only staged in the controlled tmux terminal, and the user retains final execution control with Enter or cancels with Escape.",
			"Prefer the direct sudo program that satisfies the task, such as `sudo id`; use a `bash -c` wrapper only when commands genuinely require one shared non-interactive shell context.",
			"The command may contain multiple newline-separated shell lines; preserve the intended line breaks so the terminal shows the full batch with the cursor at the end before the user executes it.",
			"Do not request an interactive root shell such as `sudo bash`, `sudo sh`, `sudo -i`, or `sudo -s`; use the direct sudo command needed for the task.",
			"When a Bash-like Tool result includes a model review, trust it on the first pass; read the full log only after a reviewed failure, never after a reviewed success.",
			"Pass one complete command that already contains sudo; do not add password, confirmation, mode, grant, or duration fields.",
			"Never ask for, receive, repeat, log, or transmit a sudo password; sudo reads authentication input from its controlling TTY after the user executes the staged command.",
		],
		parameters: PRIVILEGED_EXEC_PARAMETERS,
		executionMode: "sequential",
		execute: async (toolCallId, params, signal, onUpdate) => {
			if (!validator.Check(params)) throw new Error("privileged_exec received invalid parameters");
			if (params.execution === "local") {
				return runtime.execute(
					{
						toolCallId,
						sourceTool: "privileged_exec",
						route: "explicit_tool",
						command: params.command,
						target: { execution: "local" },
						cwd,
						timeoutMs: params.timeout ? params.timeout * 1000 : undefined,
					},
					signal,
					onUpdate,
				);
			}
			const terminal = remoteRuntime.getTerminalContext(params.terminalId);
			return runtime.execute(
				{
					toolCallId,
					sourceTool: "privileged_exec",
					route: "explicit_tool",
					command: params.command,
					target: {
						execution: "terminal",
						targetId: terminal.targetId,
						terminalId: params.terminalId,
						monitorId: terminal.monitorId,
					},
					cwd,
					timeoutMs: params.timeout ? params.timeout * 1000 : undefined,
				},
				signal,
				onUpdate,
			);
		},
		renderCall: (args, currentTheme, context) => {
			const component =
				context.lastComponent instanceof PrivilegeCallComponent
					? context.lastComponent
					: new PrivilegeCallComponent();
			const terminalId = "terminalId" in args ? args.terminalId : "";
			component.setCall(
				args.execution === "terminal" ? "Sudo Terminal Bash" : "Sudo Bash",
				args.command,
				terminalId,
				currentTheme,
			);
			return component;
		},
		renderResult: (result, options, currentTheme, context) =>
			bashRenderer.renderResult?.(
				result as unknown as { content: Array<{ type: "text"; text: string }>; details: BashToolDetails },
				options,
				currentTheme,
				context as never,
			) ?? new Text("", 0, 0),
	};
}
