import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

function createRuntime() {
	const setQuestionInteractionHandler = vi.fn();
	const setPolicyInteractionHandler = vi.fn();
	const setPrivilegeInteractionHandler = vi.fn();
	const session = {
		setQuestionInteractionHandler,
		setPolicyInteractionHandler,
		setPrivilegeInteractionHandler,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		sessionManager: { getHeader: () => undefined },
		state: { messages: [] },
	};
	const runtime = {
		session,
		setRebindSession: vi.fn(),
		dispose: vi.fn(async () => {}),
	} as unknown as AgentSessionRuntime;
	return { runtime, setQuestionInteractionHandler, setPolicyInteractionHandler, setPrivilegeInteractionHandler };
}

describe("ask_user_question print and JSON mode boundary", () => {
	it.each(["text", "json"] as const)("clears interaction handlers in %s mode", async (mode) => {
		const { runtime, setQuestionInteractionHandler, setPolicyInteractionHandler, setPrivilegeInteractionHandler } =
			createRuntime();
		await expect(runPrintMode(runtime, { mode })).resolves.toBe(0);
		expect(setQuestionInteractionHandler).toHaveBeenCalledWith(undefined);
		expect(setPolicyInteractionHandler).toHaveBeenCalledWith(undefined);
		expect(setPrivilegeInteractionHandler).toHaveBeenCalledWith(undefined);
	});
});
