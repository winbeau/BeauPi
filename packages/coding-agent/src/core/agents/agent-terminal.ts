import { createHash } from "node:crypto";
import type { AgentSessionEvent } from "../agent-session.ts";
import { LocalTmuxTransport } from "../terminal/local-tmux-transport.ts";

const MAX_EVENT_CHARACTERS = 20_000;
const MAX_CAPTURE_CHARACTERS = 50_000;
const WRITE_FLUSH_INTERVAL_MS = 100;

export interface AgentTerminalReference {
	kind: "tmux";
	serverName: string;
	sessionId: string;
	paneId: string;
	attachCommand: string;
}

export interface AgentTerminalCapture {
	terminal: AgentTerminalReference;
	content: string;
	truncated: boolean;
}

export interface AgentTerminalRuntimeOptions {
	sessionId: string;
	transport?: LocalTmuxTransport;
	now?: () => number;
}

interface AgentTerminalRecord {
	agentId: string;
	terminal: AgentTerminalReference;
	writeQueue: Promise<void>;
	pendingText: string;
	flushTimer?: ReturnType<typeof setTimeout>;
	closed: boolean;
	writeFailed: boolean;
	bashOutputActive: boolean;
	diagnostic?: string;
}

function stableName(prefix: string, value: string, length: number): string {
	return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, length)}`;
}

function safeText(value: string): string {
	return value.replaceAll("\0", "�");
}

function bounded(value: string, maximum = MAX_EVENT_CHARACTERS): string {
	if (value.length <= maximum) return value;
	return `${value.slice(0, maximum)}\n… ${value.length - maximum} characters omitted …\n`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function jsonText(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "[unserializable value]";
	}
}

function toolResultText(value: unknown): string {
	const record = asRecord(value);
	if (!record || !Array.isArray(record.content)) return jsonText(value);
	const texts: string[] = [];
	for (const item of record.content) {
		const block = asRecord(item);
		if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
	}
	return texts.length > 0 ? texts.join("\n") : jsonText(value);
}

function eventChunk(record: AgentTerminalRecord, event: AgentSessionEvent): string | undefined {
	if (event.type === "agent_start") return "\n[agent] running\n";
	if (event.type === "turn_start") return "\n[turn] started\n";
	if (event.type === "turn_end") return "\n[turn] completed\n";
	if (event.type === "message_update") {
		const update = event.assistantMessageEvent;
		if (update.type === "thinking_start") return "\n[thinking]\n";
		if (update.type === "thinking_delta") return update.delta;
		if (update.type === "thinking_end") return "\n[/thinking]\n";
		if (update.type === "text_start") return "\n[assistant]\n";
		if (update.type === "text_delta") return update.delta;
		if (update.type === "text_end") return "\n";
		return undefined;
	}
	if (event.type === "tool_execution_start") {
		record.bashOutputActive = false;
		return `\n[tool:start] ${event.toolName} ${bounded(jsonText(event.args), 4_000)}\n`;
	}
	if (event.type === "bash_execution_update") {
		const prefix = record.bashOutputActive ? "" : "[bash output]\n";
		record.bashOutputActive = true;
		return `${prefix}${event.delta}`;
	}
	if (event.type === "tool_execution_end") {
		const output = bounded(toolResultText(event.result));
		const body = output.trim() ? `\n${output.trimEnd()}\n` : "\n";
		record.bashOutputActive = false;
		return `\n[tool:${event.isError ? "failed" : "completed"}] ${event.toolName}${body}`;
	}
	if (event.type === "queue_update") {
		const queued = [
			...event.steering.map((message) => `steer: ${message}`),
			...event.followUp.map((message) => `follow-up: ${message}`),
		];
		return queued.length > 0 ? `\n[control queue]\n${bounded(queued.join("\n"))}\n` : undefined;
	}
	if (event.type === "agent_end") return `\n[agent] ${event.willRetry ? "retrying" : "run completed"}\n`;
	if (event.type === "agent_settled") return "[agent] settled\n";
	if (event.type === "auto_retry_start")
		return `\n[retry] ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}\n`;
	if (event.type === "auto_retry_end") return `\n[retry] ${event.success ? "completed" : "failed"}\n`;
	return undefined;
}

export class AgentTerminalRuntime {
	private readonly serverName: string;
	private readonly transport: LocalTmuxTransport;
	private readonly now: () => number;
	private readonly records = new Map<string, AgentTerminalRecord>();
	private disposed = false;

	constructor(options: AgentTerminalRuntimeOptions) {
		this.serverName = stableName("beaupi-agent", options.sessionId, 16);
		this.transport = options.transport ?? new LocalTmuxTransport({ serverName: this.serverName });
		this.now = options.now ?? Date.now;
	}

	async open(input: {
		agentId: string;
		profile: string;
		taskSummary: string;
		cwd: string;
	}): Promise<AgentTerminalReference> {
		if (this.disposed) throw new Error("Agent terminal runtime is disposed");
		const existing = this.records.get(input.agentId);
		if (existing) return structuredClone(existing.terminal);
		const sessionId = stableName("agent", input.agentId, 20);
		const paneCommand = `pane_pid=$$; (while kill -0 ${process.pid} 2>/dev/null; do sleep 2; done; kill -TERM "$pane_pid") & stty -echo -icanon min 1 time 0; exec cat`;
		const created = await this.transport.run([
			"new-session",
			"-d",
			"-s",
			sessionId,
			"-x",
			"120",
			"-y",
			"40",
			"-c",
			input.cwd,
			paneCommand,
		]);
		if (created.exitCode !== 0) {
			throw new Error(created.stderr.trim() || "Could not create Agent tmux session");
		}
		try {
			await this.transport.requireSuccess("history-limit", [
				"set-option",
				"-w",
				"-t",
				sessionId,
				"history-limit",
				"100000",
			]);
			const status = await this.transport.status(sessionId);
			if (!status.exists || !status.paneId) throw new Error("Agent tmux pane was lost during startup");
			const terminal: AgentTerminalReference = {
				kind: "tmux",
				serverName: this.serverName,
				sessionId,
				paneId: status.paneId,
				attachCommand: `tmux -L ${this.serverName} attach-session -r -t ${sessionId}`,
			};
			const record: AgentTerminalRecord = {
				agentId: input.agentId,
				terminal,
				writeQueue: Promise.resolve(),
				pendingText: "",
				closed: false,
				writeFailed: false,
				bashOutputActive: false,
			};
			this.records.set(input.agentId, record);
			await this.write(
				input.agentId,
				[
					`BeauPi Agent ${input.agentId}`,
					`Profile: ${input.profile}`,
					`Task: ${input.taskSummary}`,
					`Started: ${new Date(this.now()).toISOString()}`,
					`Read-only attach: ${terminal.attachCommand}`,
					"=".repeat(80),
					"",
				].join("\n"),
			);
			return structuredClone(terminal);
		} catch (error) {
			await this.transport.close(sessionId).catch(() => undefined);
			throw error;
		}
	}

	get(agentId: string): AgentTerminalReference | undefined {
		const terminal = this.records.get(agentId)?.terminal;
		return terminal ? structuredClone(terminal) : undefined;
	}

	recordEvent(agentId: string, event: AgentSessionEvent): void {
		const record = this.records.get(agentId);
		if (!record || record.closed) return;
		const chunk = eventChunk(record, event);
		if (chunk) this.enqueue(record, chunk);
	}

	async write(agentId: string, value: string): Promise<void> {
		const record = this.records.get(agentId);
		if (!record || record.closed || record.writeFailed || !value) return;
		this.enqueue(record, value, false);
		await this.flush(record);
	}

	private enqueue(record: AgentTerminalRecord, value: string, schedule = true): void {
		if (record.closed || record.writeFailed || !value) return;
		record.pendingText += safeText(bounded(value));
		if (!schedule || record.flushTimer) return;
		record.flushTimer = setTimeout(() => {
			record.flushTimer = undefined;
			void this.flush(record);
		}, WRITE_FLUSH_INTERVAL_MS);
		record.flushTimer.unref?.();
	}

	private async flush(record: AgentTerminalRecord): Promise<void> {
		if (record.flushTimer) {
			clearTimeout(record.flushTimer);
			record.flushTimer = undefined;
		}
		if (record.closed || record.writeFailed) {
			record.pendingText = "";
			await record.writeQueue;
			return;
		}
		const pending = record.pendingText;
		record.pendingText = "";
		if (!pending) {
			await record.writeQueue;
			return;
		}
		const payload = Buffer.from(pending, "utf8");
		record.writeQueue = record.writeQueue
			.then(async () => {
				if (record.closed || record.writeFailed) return;
				await this.transport.sendSensitive(record.terminal.paneId, payload);
			})
			.catch((error) => {
				record.writeFailed = true;
				record.diagnostic = error instanceof Error ? error.message : String(error);
			});
		await record.writeQueue;
	}

	async capture(agentId: string): Promise<AgentTerminalCapture> {
		const record = this.records.get(agentId);
		if (!record) throw new Error(`Agent ${JSON.stringify(agentId)} has no tmux transcript`);
		await this.flush(record);
		const captured = await this.transport.capture(record.terminal.paneId);
		if (captured.exitCode !== 0) throw new Error(captured.stderr.trim() || "Could not capture Agent tmux pane");
		const content = safeText(captured.stdout);
		const truncated = content.length > MAX_CAPTURE_CHARACTERS;
		return {
			terminal: structuredClone(record.terminal),
			content: truncated
				? `… ${content.length - MAX_CAPTURE_CHARACTERS} earlier characters omitted …\n${content.slice(-MAX_CAPTURE_CHARACTERS)}`
				: content,
			truncated,
		};
	}

	async exists(agentId: string): Promise<boolean> {
		const record = this.records.get(agentId);
		if (!record || record.closed) return false;
		const status = await this.transport.status(record.terminal.paneId);
		return status.exists;
	}

	async close(agentId: string): Promise<void> {
		const record = this.records.get(agentId);
		if (!record || record.closed) return;
		await this.flush(record);
		record.closed = true;
		await record.writeQueue;
		await this.transport.close(record.terminal.sessionId).catch(() => undefined);
		this.records.delete(agentId);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const agentId of this.records.keys()) void this.close(agentId);
	}
}
