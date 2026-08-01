import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import type { MonitorRecord } from "../src/core/monitor/index.ts";
import type { PolicyAdvisory } from "../src/core/policy/index.ts";
import type { TaskPhase, TaskVerificationStatus } from "../src/core/state/task-ledger.ts";
import type { DynamicTaskPlanV1 } from "../src/core/tasks/types.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	branchUsage?: AssistantUsage;
	compactionUsage?: AssistantUsage;
	toolUsage?: AssistantUsage;
	taskPhase?: TaskPhase;
	filesModified?: string[];
	verificationStatus?: TaskVerificationStatus;
	monitors?: MonitorRecord[];
	selectedTargetId?: string;
	policyAdvisories?: PolicyAdvisory[];
	dynamicTasks?: DynamicTaskPlanV1;
}): AgentSession {
	const usage = options.usage;
	const entries: Array<Record<string, unknown>> = [];

	if (usage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage,
			},
		});
	}

	if (options.branchUsage !== undefined) {
		entries.push({
			type: "branch_summary",
			usage: options.branchUsage,
		});
	}

	if (options.compactionUsage !== undefined) {
		entries.push({
			type: "compaction",
			usage: options.compactionUsage,
		});
	}

	if (options.toolUsage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				usage: options.toolUsage,
			},
		});
	}

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ tokens: 24_600, contextWindow: 200_000, percent: 12.3 }),
		modelRuntime: {
			isUsingOAuth: () => false,
		},
		remoteRuntime: {
			selectedTarget: options.selectedTargetId
				? { id: options.selectedTargetId, scope: "session", sshAlias: "h100-server" }
				: undefined,
		},
		policyRuntime: {
			getAdvisories: () => options.policyAdvisories ?? [],
		},
		monitorRuntime: {
			getSummary: () => ({
				total: options.monitors?.length ?? 0,
				starting: 0,
				running: options.monitors?.filter((record) => record.status === "running").length ?? 0,
				healthy: options.monitors?.filter((record) => record.status === "healthy").length ?? 0,
				stalled: options.monitors?.filter((record) => record.status === "stalled").length ?? 0,
				completed: options.monitors?.filter((record) => record.status === "completed").length ?? 0,
				failed: options.monitors?.filter((record) => record.status === "failed").length ?? 0,
				cancelled: options.monitors?.filter((record) => record.status === "cancelled").length ?? 0,
				lost: options.monitors?.filter((record) => record.status === "lost").length ?? 0,
			}),
		},
		taskLedger: {
			getSnapshot: () => ({
				taskId: "task",
				phase: options.taskPhase ?? "discover",
				startedAt: options.taskPhase ? 1 : undefined,
				updatedAt: options.taskPhase ? 1 : undefined,
				revision: 0,
				workspaceRevision: options.filesModified?.length ?? 0,
				commands: [],
				filesRead: [],
				fileModifications: [],
				filesModified: options.filesModified ?? [],
				failures: [],
				verification: { status: options.verificationStatus ?? "none" },
				dynamicTasks: options.dynamicTasks,
				todos: [],
			}),
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("includes summary and tool result usage in the total cost", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.5 },
			},
			branchUsage: {
				input: 20,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.25 },
			},
			compactionUsage: {
				input: 5,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.125 },
			},
			toolUsage: {
				input: 15,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.375 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("$1.250");
	});

	it("shows current context tokens, context window, and percentage", () => {
		const footer = new FooterComponent(createSession({ sessionName: "" }), createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("25k/200k 12.3% (auto)");
	});

	it("shows the latest cache hit rate when cache usage is present", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 0.001 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("CH25.0%");
	});

	it("shows TaskLedger phase, modified files, and verification status without adding a line", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				taskPhase: "verify",
				filesModified: ["src/a.ts", "src/b.ts"],
				verificationStatus: "passed",
			}),
			createFooterData(1),
		);

		const lines = footer.render(120).map(stripAnsi);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("/tmp/project (main) · verify · 2 files · verify passed");
	});

	it("shows Dynamic Task progress and attention without adding a Footer line", () => {
		const dynamicTasks: DynamicTaskPlanV1 = {
			version: 1,
			planId: "plan-footer",
			revision: 4,
			goal: "Footer projection",
			createdAt: 1,
			updatedAt: 4,
			factSequence: 0,
			facts: [],
			tasks: [
				{
					id: "done",
					title: "Done",
					status: "completed",
					dependsOn: [],
					matchHints: [],
					evidence: [],
					blockedBy: [],
					createdAt: 1,
					updatedAt: 2,
					completedAt: 2,
				},
				{
					id: "blocked",
					title: "Blocked",
					status: "blocked",
					dependsOn: [],
					matchHints: [],
					evidence: [],
					blockedBy: ["dependency"],
					createdAt: 1,
					updatedAt: 4,
				},
			],
		};
		for (const themeName of ["beaupi-dark", "beaupi-light"]) {
			initTheme(themeName, false);
			const footer = new FooterComponent(createSession({ sessionName: "", dynamicTasks }), createFooterData(1));
			for (const width of [40, 80, 120, 160]) {
				const lines = footer.render(width);
				expect(lines.length).toBeLessThanOrEqual(3);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				if (width >= 80) expect(stripAnsi(lines[0] ?? "")).toContain("tasks 1/2 · 1 blocked");
			}
		}
	});

	it("shows Monitor running and attention counts without overflowing", () => {
		const monitors: MonitorRecord[] = [
			{
				version: 1,
				id: "mon-footer",
				sessionId: "session",
				target: { kind: "process", pid: 42 },
				kind: "process",
				name: "build",
				taskSummary: "Build",
				createdAt: 1,
				startedAt: 1,
				durationMs: 10,
				lastActivityAt: 1,
				status: "stalled",
				logCursor: 0,
				activityLog: [],
				diagnostics: [],
			},
		];
		const session = createSession({ sessionName: "", monitors });
		const footer = new FooterComponent(session, createFooterData(1));
		for (const width of [80, 120, 160]) {
			const lines = footer.render(width).map(stripAnsi);
			expect(lines[0]).toContain("mon 0 run · 1 attention");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("shows a selected SSH target without overflowing at responsive widths", () => {
		const footer = new FooterComponent(
			createSession({ sessionName: "", selectedTargetId: "h100-server" }),
			createFooterData(1),
		);
		for (const width of [80, 120, 160]) {
			const lines = footer.render(width).map(stripAnsi);
			expect(lines[0]).toContain("ssh:h100-server");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("shows Policy only as a non-blocking Footer advisory", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				policyAdvisories: [
					{
						version: 1,
						kind: "dedicated_tool_available",
						message: "Dedicated Tool available: web_fetch.",
						createdAt: "2026-07-30T00:00:00.000Z",
					},
					{
						version: 1,
						kind: "network_fallback",
						message: "Network fallback follows a failed dedicated Search operation.",
						createdAt: "2026-07-30T00:00:01.000Z",
					},
				],
			}),
			createFooterData(1),
		);

		for (const width of [40, 80, 120, 160]) {
			const lines = footer.render(width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			if (width >= 120) {
				expect(stripAnsi(lines[0])).toContain(
					"policy: Network fallback follows a failed dedicated Search operation. (+1)",
				);
			}
		}
	});

	it("marks Kimi Coding costs as subscription estimates", () => {
		const session = createSession({
			sessionName: "",
			provider: "kimi-coding",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120)[1])).toContain("$1.234 (sub)");
	});
});
