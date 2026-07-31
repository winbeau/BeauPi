import { describe, expect, it } from "vitest";
import { localTmuxSessionId, parseTerminalCommandCapture, remoteTerminalStartup } from "../src/core/remote/adapter.ts";

describe("local tmux SSH adapter protocol", () => {
	it("names local tmux sessions deterministically per Agent session and target", () => {
		const first = localTmuxSessionId("session-a", "target-a", "terminal");
		expect(first).toBe(localTmuxSessionId("session-a", "target-a", "terminal"));
		expect(first).not.toBe(localTmuxSessionId("session-b", "target-a", "terminal"));
		expect(first).not.toBe(localTmuxSessionId("session-a", "target-b", "terminal"));
		expect(first).toContain("terminal");
	});

	it("starts SSH in the pane and never requires remote tmux", () => {
		const startup = remoteTerminalStartup(
			{ sessionId: "terminal", cwd: "/workspace", columns: 80, rows: 24 },
			"__BEAUPI_READY__",
		);
		expect(startup).toContain("cd -- '/workspace'");
		expect(startup).toContain("__BEAUPI_READY__");
		expect(startup).toContain(`exec "\${SHELL:-/bin/sh}" -l`);
		expect(startup).not.toContain("tmux");
	});

	it("parses only the marker-delimited terminal output and exit code", () => {
		const parsed = parseTerminalCommandCapture(
			"shell echo __BEAUPI_BEGIN_token__\n__BEAUPI_BEGIN_token__\nerror line\n__BEAUPI_END_token__:7\n$ ",
			"__BEAUPI_BEGIN_token__",
			"__BEAUPI_END_token__",
		);
		expect(parsed).toEqual({ found: true, output: "error line", exitCode: 7 });
	});
});
