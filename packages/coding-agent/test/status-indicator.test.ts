import { fauxAssistantMessage, fauxThinking } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getThinkingStatusMessage,
	IdleStatus,
	RetryStatusIndicator,
	resolveWorkingStatusMessage,
} from "../src/modes/interactive/components/status-indicator.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("status indicators", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps idle status at the same height as status indicators", () => {
		const idleStatus = new IdleStatus();

		const lines = idleStatus.render(20);
		expect(lines).toHaveLength(2);
		expect(lines).toEqual([" ".repeat(20), " ".repeat(20)]);
	});

	it("uses the latest thinking summary as a concise working message", () => {
		const message = fauxAssistantMessage([
			fauxThinking("**Planning reusable component architecture**\n\n**Designing dynamic tool grouping logic**"),
		]);

		expect(getThinkingStatusMessage(message)).toBe("Designing dynamic tool grouping logic…");
	});

	it("normalizes markdown and existing ellipses without exposing multiple lines", () => {
		const message = fauxAssistantMessage([fauxThinking("details\n\n> - **Implementing timed group rendering…**")]);

		expect(getThinkingStatusMessage(message)).toBe("Implementing timed group rendering…");
		expect(getThinkingStatusMessage(fauxAssistantMessage("answer"))).toBeUndefined();
	});

	it("keeps extension working messages above dynamic thinking summaries", () => {
		expect(resolveWorkingStatusMessage("Thinking…", "Extension status", "Planning changes…")).toBe(
			"Extension status",
		);
		expect(resolveWorkingStatusMessage("Thinking…", undefined, "Planning changes…")).toBe("Planning changes…");
		expect(resolveWorkingStatusMessage("Thinking…")).toBe("Thinking…");
	});

	it("disposes retry countdown updates", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const indicator = new RetryStatusIndicator(tui, 1, 3, 1000);
		const callsBeforeDispose = requestRender.mock.calls.length;

		indicator.dispose();
		vi.advanceTimersByTime(2000);

		expect(requestRender).toHaveBeenCalledTimes(callsBeforeDispose);
	});
});
