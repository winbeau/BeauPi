import type { Usage } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const RUN_USAGE: Usage = {
	input: 8_976,
	output: 400,
	cacheRead: 537_088,
	cacheWrite: 0,
	totalTokens: 546_464,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createSession(): AgentSession {
	return {
		state: {
			model: {
				id: "gpt-5.6-sol",
				provider: "openai",
				contextWindow: 272_000,
				reasoning: true,
			},
			thinkingLevel: "medium",
		},
		sessionManager: {
			getEntries: () => [],
			getSessionName: () => "",
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ tokens: 112_000, contextWindow: 272_000, percent: 41.2 }),
		modelRuntime: { isUsingOAuth: () => false },
		taskLedger: {
			getSnapshot: () => ({
				taskId: "task",
				phase: "discover",
				startedAt: undefined,
				updatedAt: undefined,
				revision: 0,
				workspaceRevision: 0,
				commands: [],
				filesRead: [],
				fileModifications: [],
				filesModified: [],
				failures: [],
				verification: { status: "none" },
				todos: [],
			}),
		},
	} as unknown as AgentSession;
}

function createFooterData(statuses = new Map<string, string>()): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
}

describe("Footer recent run stats", () => {
	beforeEach(() => {
		initTheme("beaupi-dark", false);
	});

	it("renders recent run, workspace, and session state in at most three lines", () => {
		const footer = new FooterComponent(createSession(), createFooterData());
		footer.startRecentRun(0);
		footer.noteRecentRunOutput(1_000);
		footer.addRecentRunUsage(RUN_USAGE);
		footer.finishRecentRun("completed", 11_000);

		const lines = footer.render(160).map(stripAnsi);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("40.0 tok/s");
		expect(lines[0]).toContain("400 out");
		expect(lines[0]).toContain("11.0s");
		expect(lines[1]).toContain("/tmp/project (main)");
		expect(lines[2]).toContain("112k/272k 41.2% (auto)");
		expect(lines[2]).toContain("gpt-5.6-sol · medium");
	});

	it("degrades fields without wrapping or adding a fourth extension status line", () => {
		const statuses = new Map([
			["workflow", "workflow:review"],
			["background", "bg:2"],
		]);
		const footer = new FooterComponent(createSession(), createFooterData(statuses));
		footer.startRecentRun(0);
		footer.noteRecentRunOutput(100);
		footer.addRecentRunUsage(RUN_USAGE);
		footer.finishRecentRun("failed", 20_000);

		for (const width of [40, 60, 80, 120, 160]) {
			const lines = footer.render(width);
			expect(lines.length).toBeLessThanOrEqual(3);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
