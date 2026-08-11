import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { AgentTerminalRuntime } from "../src/core/agents/agent-terminal.ts";
import { LocalTmuxTransport, type LocalTmuxTransportRunner } from "../src/core/terminal/local-tmux-transport.ts";

function ok(stdout = "") {
	return { stdout, stderr: "", exitCode: 0, startedAt: 1, completedAt: 2 };
}

describe("AgentTerminalRuntime", () => {
	it("creates a read-only tmux transcript and mirrors AgentSession events", async () => {
		const calls: Array<{ args: string[]; stdin?: string }> = [];
		const runner: LocalTmuxTransportRunner = vi.fn(async (args, options) => {
			calls.push({ args: [...args], stdin: options.stdin?.toString("utf8") });
			if (args[0] === "display-message") {
				return ok("%9__BEAUPI_TMUX_FIELD__cat__BEAUPI_TMUX_FIELD__0__BEAUPI_TMUX_FIELD__0__BEAUPI_TMUX_FIELD__\n");
			}
			if (args[0] === "capture-pane") return ok("captured transcript\n");
			return ok();
		});
		const runtime = new AgentTerminalRuntime({
			sessionId: "coordinator-session",
			transport: new LocalTmuxTransport({ runner, randomId: () => "buffer-id" }),
			now: () => Date.parse("2026-01-01T00:00:00.000Z"),
		});

		const terminal = await runtime.open({
			agentId: "agent-one",
			profile: "reviewer",
			taskSummary: "Inspect one file",
			cwd: "/tmp",
		});
		expect(terminal).toMatchObject({ kind: "tmux", paneId: "%9" });
		expect(terminal.attachCommand).toContain("attach-session -r");

		const partial = fauxAssistantMessage("hello");
		runtime.recordEvent("agent-one", {
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial },
		} satisfies AgentSessionEvent);
		runtime.recordEvent("agent-one", {
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "read",
			args: { path: "README.md" },
		} satisfies AgentSessionEvent);
		runtime.recordEvent("agent-one", {
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "read",
			result: { content: [{ type: "text", text: "file contents" }] },
			isError: false,
		} satisfies AgentSessionEvent);

		await expect(runtime.capture("agent-one")).resolves.toMatchObject({
			content: "captured transcript\n",
			truncated: false,
		});
		const loadBufferCalls = calls.filter((call) => call.args[0] === "load-buffer");
		const transcriptWrites = loadBufferCalls.map((call) => call.stdin ?? "").join("");
		expect(transcriptWrites).toContain("BeauPi Agent agent-one");
		expect(transcriptWrites).toContain("hello");
		expect(transcriptWrites).toContain("[tool:start] read");
		expect(transcriptWrites).toContain("file contents");
		expect(loadBufferCalls).toHaveLength(2);
		expect(calls.some((call) => call.args[0] === "new-session")).toBe(true);

		await runtime.close("agent-one");
		expect(calls.some((call) => call.args[0] === "kill-session")).toBe(true);
	});
});
