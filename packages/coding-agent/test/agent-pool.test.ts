import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentLifecycleEvent,
	type AgentPoolConfig,
	calculateAgentConcurrencyLimit,
	DEFAULT_AGENT_PROFILE,
	DEFAULT_AGENT_PROFILES,
	MAX_AGENT_TIMEOUT_MS,
	validateAgentProfile,
} from "../src/core/agents/index.ts";
import { createExtensionRuntime, defineTool } from "../src/core/extensions/index.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import type { CreateAgentSessionOptions } from "../src/core/sdk.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { Skill } from "../src/core/skills.ts";
import { createHarness, type HarnessOptions } from "./suite/harness.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

async function createCoordinator(
	options: {
		pool?: AgentPoolConfig;
		resourceLoader?: ResourceLoader;
		customTools?: CreateAgentSessionOptions["customTools"];
		faux?: HarnessOptions["faux"];
	} = {},
) {
	const harness = await createHarness({ resourceLoader: options.resourceLoader, faux: options.faux });
	const created = await createAgentSession({
		cwd: harness.tempDir,
		model: harness.getModel(),
		modelRuntime: harness.session.modelRuntime,
		resourceLoader: options.resourceLoader ?? harness.session.resourceLoader,
		sessionManager: SessionManager.inMemory(harness.tempDir),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		customTools: options.customTools,
		agentPool: options.pool ?? {},
	});
	cleanups.push(() => created.session.dispose());
	cleanups.push(harness.cleanup);
	return { harness, session: created.session, pool: created.session.agentPool! };
}

function eventTypes(events: readonly AgentLifecycleEvent[], taskId: string): string[] {
	return events.filter((event) => event.taskId === taskId).map((event) => event.type);
}

function skill(name: string, description: string): Skill {
	return {
		name,
		description,
		filePath: `/tmp/${name}/SKILL.md`,
		baseDir: `/tmp/${name}`,
		sourceInfo: { path: `/tmp/${name}`, source: "test", scope: "temporary", origin: "top-level" },
		disableModelInvocation: false,
	};
}

function resourceLoaderWithSkills(skills: Skill[]): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills, diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

describe("in-process Agent Pool and delegate_task", () => {
	it("limits built-in profiles only by an eight-minute wall clock", () => {
		expect(DEFAULT_AGENT_PROFILE).toMatchObject({
			id: "reviewer",
			timeoutMs: MAX_AGENT_TIMEOUT_MS,
		});
		for (const profile of DEFAULT_AGENT_PROFILES) {
			expect(profile.timeoutMs).toBe(MAX_AGENT_TIMEOUT_MS);
			expect(profile.maxTokens).toBeUndefined();
			expect(profile.maxTurns).toBeUndefined();
		}
	});

	it("caps pool concurrency at one third of available CPUs with a minimum of one", async () => {
		expect(calculateAgentConcurrencyLimit(1)).toBe(1);
		expect(calculateAgentConcurrencyLimit(5)).toBe(1);
		expect(calculateAgentConcurrencyLimit(6)).toBe(2);
		expect(calculateAgentConcurrencyLimit(11)).toBe(3);
		expect(calculateAgentConcurrencyLimit(12)).toBe(4);
		expect(calculateAgentConcurrencyLimit(Number.NaN)).toBe(1);

		const { pool } = await createCoordinator({ pool: { maxConcurrency: 99 } });
		expect(pool.concurrencyLimit).toBe(calculateAgentConcurrencyLimit());
	});

	it("enforces the eight-minute cap for custom profiles and direct requests", async () => {
		expect(() =>
			validateAgentProfile({
				id: "too-long",
				systemPrompt: "test",
				timeoutMs: MAX_AGENT_TIMEOUT_MS + 1,
			}),
		).toThrow(`timeoutMs cannot exceed ${MAX_AGENT_TIMEOUT_MS}`);

		const { harness, pool } = await createCoordinator();
		harness.setResponses([fauxAssistantMessage("bounded")]);
		const result = await pool.delegateTask({
			task: "Clamp timeout",
			budget: { timeoutMs: MAX_AGENT_TIMEOUT_MS + 1 },
		});
		expect(result.status).toBe("completed");
		expect(result.budget.timeoutMs).toBe(MAX_AGENT_TIMEOUT_MS);
	});

	it("runs a selected profile and returns only structured data", async () => {
		const { harness, session, pool } = await createCoordinator({
			pool: {
				profiles: [
					{
						id: "researcher",
						systemPrompt: "RESEARCHER PROFILE",
						toolAllowlist: ["read"],
						skillAllowlist: { allow: [] },
					},
				],
				defaultProfile: "researcher",
			},
		});
		harness.setResponses([fauxAssistantMessage("child summary")]);
		const events: AgentLifecycleEvent[] = [];
		pool.subscribe((event) => events.push(event));

		const result = await pool.delegateTask({ task: "Inspect the repository", profile: "researcher" });

		expect(result.status).toBe("completed");
		expect(result.profile).toBe("researcher");
		expect(result.summary).toBe("child summary");
		expect(result.budget.timeoutMs).toBe(MAX_AGENT_TIMEOUT_MS);
		expect(result).not.toHaveProperty("messages");
		expect(session.messages).toEqual([]);
		expect(eventTypes(events, result.taskId)).toEqual(
			expect.arrayContaining(["started", "running", "progress", "completed"]),
		);
		expect(eventTypes(events, result.taskId).filter((type) => type === "started")).toHaveLength(1);
		expect(eventTypes(events, result.taskId).filter((type) => type === "completed")).toHaveLength(1);
	});

	it("does not attach default turn or token limits to unknown-profile failures", async () => {
		const { pool } = await createCoordinator();
		const result = await pool.delegateTask({ task: "Review files", profile: "missing-profile" });

		expect(result.status).toBe("failed");
		expect(result.error?.code).toBe("profile_not_found");
		expect(result.budget.maxTurns).toBeUndefined();
		expect(result.budget.maxTokens).toBeUndefined();
		expect(result.budget.timeoutMs).toBe(MAX_AGENT_TIMEOUT_MS);
	});

	it("filters tools, Skills, file modification boundaries, and recursive delegation", async () => {
		let seenTools: string[] = [];
		let seenSystemPrompt = "";
		const loader = resourceLoaderWithSkills([
			skill("allowed-skill", "Allowed instructions"),
			skill("blocked-skill", "Blocked instructions"),
		]);
		const { harness, pool } = await createCoordinator({
			resourceLoader: loader,
			pool: {
				profiles: [
					{
						id: "controlled",
						systemPrompt: "CONTROLLED PROFILE",
						toolAllowlist: [
							"read",
							"edit",
							"write",
							"delegate_task",
							"ask_user_question",
							"privileged_exec",
							"custom_allowed",
						],
						skillAllowlist: { allow: ["allowed-skill"] },
						allowFileModifications: false,
					},
				],
				defaultProfile: "controlled",
			},
			customTools: [
				defineTool({
					name: "custom_allowed",
					label: "Allowed",
					description: "A test tool",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				}),
			],
		});
		harness.setResponses([
			(context) => {
				seenTools = context.tools?.map((tool) => tool.name) ?? [];
				seenSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("filtered");
			},
		]);

		const result = await pool.delegateTask({ task: "Check boundaries", profile: "controlled" });

		expect(result.status).toBe("completed");
		expect(seenTools).toContain("read");
		expect(seenTools).toContain("custom_allowed");
		expect(seenTools).not.toContain("edit");
		expect(seenTools).not.toContain("write");
		expect(seenTools).not.toContain("delegate_task");
		expect(seenTools).not.toContain("ask_user_question");
		expect(seenTools).not.toContain("privileged_exec");
		expect(seenSystemPrompt).toContain("CONTROLLED PROFILE");
		expect(seenSystemPrompt).toContain("<clarification_request>");
		expect(seenSystemPrompt).toContain("allowed-skill");
		expect(seenSystemPrompt).not.toContain("blocked-skill");
	});

	it("skips automatic document contract resolution for controlled child prompts", async () => {
		const { harness, pool } = await createCoordinator();
		writeFileSync(join(harness.tempDir, "AGENTS.md"), "# Child contract\n\n- CHILD_AUTO_CONTRACT_MARKER\n");
		harness.setResponses([
			(context) => {
				expect(context.systemPrompt).not.toContain("CHILD_AUTO_CONTRACT_MARKER");
				return fauxAssistantMessage("scoped child summary");
			},
		]);

		const result = await pool.delegateTask({ task: "Read package.json only" });
		expect(result.status).toBe("completed");
		expect(result.references).not.toContain(join(harness.tempDir, "AGENTS.md"));
	});

	it("returns machine-readable clarification requests without exposing the interactive question tool", async () => {
		const { harness, pool } = await createCoordinator({
			pool: {
				profiles: [
					{
						id: "clarifier",
						systemPrompt: "Clarify when required",
						toolAllowlist: ["ask_user_question"],
					},
				],
				defaultProfile: "clarifier",
			},
		});
		harness.setResponses([
			(context) => {
				expect(context.tools?.map((tool) => tool.name)).not.toContain("ask_user_question");
				return fauxAssistantMessage(
					'<clarification_request>{"version":1,"questions":[{"question":"Which target?","options":["A","B"]}]}</clarification_request>',
				);
			},
		]);

		const result = await pool.delegateTask({ task: "Do an ambiguous task" });
		expect(result.clarificationRequest).toEqual({
			version: 1,
			questions: [{ question: "Which target?", options: ["A", "B"] }],
		});
	});

	it("allows controlled child sensitive operations without Policy confirmation", async () => {
		const { harness, pool } = await createCoordinator({
			pool: {
				profiles: [
					{
						id: "policy-child",
						systemPrompt: "Use structured Policy results",
						toolAllowlist: ["write"],
						allowFileModifications: true,
					},
				],
				defaultProfile: "policy-child",
			},
		});
		const sensitivePath = join(harness.tempDir, ".env");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: sensitivePath, content: "allowed" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Sensitive write completed."),
		]);

		const result = await pool.delegateTask({ task: "Write the sensitive file" });
		expect(result).not.toHaveProperty("policyRequest");
		expect(result.diagnostics).not.toContain("Tool write failed");
		expect(existsSync(sensitivePath)).toBe(true);
	});

	it("enforces turn and token budgets with structured errors", async () => {
		let requestedMaxTokens: number | undefined;
		const { harness, pool } = await createCoordinator({
			pool: {
				profiles: [
					{
						id: "bounded",
						systemPrompt: "bounded",
						toolAllowlist: ["read"],
						maxTokens: 3,
						maxTurns: 5,
					},
					{
						id: "turn-limited",
						systemPrompt: "turn limited",
						toolAllowlist: ["read"],
						maxTokens: 128,
						maxTurns: 1,
					},
				],
				defaultProfile: "bounded",
			},
		});
		harness.setResponses([
			(_context, options) => {
				requestedMaxTokens = options?.maxTokens;
				return fauxAssistantMessage(fauxToolCall("read", { path: "missing" }), { stopReason: "toolUse" });
			},
		]);

		const result = await pool.delegateTask({ task: "Use the bounded budget", profile: "bounded" });

		expect(requestedMaxTokens).toBe(3);
		expect(result.status).toBe("failed");
		expect(result.error?.code).toBe("budget_exhausted");
		expect(result.budget.maxTokens).toBe(3);

		let turnLimitedRequests = 0;
		harness.setResponses([
			() => {
				turnLimitedRequests++;
				return fauxAssistantMessage(fauxToolCall("read", { path: "missing" }), { stopReason: "toolUse" });
			},
			() => {
				turnLimitedRequests++;
				return fauxAssistantMessage("unexpected extra turn");
			},
		]);
		const turnLimited = await pool.delegateTask({ task: "Use the turn budget", profile: "turn-limited" });
		expect(turnLimited.status).toBe("failed");
		expect(turnLimited.error?.code).toBe("budget_exhausted");
		expect(turnLimited.budget.maxTurns).toBe(1);
		expect(turnLimited.budget.turnsUsed).toBe(1);
		expect(turnLimitedRequests).toBe(1);
		expect(turnLimited.lastActivity).toMatchObject({
			turn: 1,
			toolName: "read",
			targetPath: "missing",
			outcome: "failed",
		});
	});

	it("propagates provider and ordinary Tool failures structurally", async () => {
		const { harness, pool } = await createCoordinator({
			pool: {
				profiles: [{ ...DEFAULT_TEST_PROFILE(), id: "failure" }],
				defaultProfile: "failure",
			},
		});
		const events: AgentLifecycleEvent[] = [];
		pool.subscribe((event) => events.push(event));
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" })]);
		const providerFailure = await pool.delegateTask({ task: "Provider failure", profile: "failure" });
		expect(providerFailure.status).toBe("failed");
		expect(providerFailure.error).toEqual({ code: "provider_error", message: "provider exploded" });
		expect(eventTypes(events, providerFailure.taskId).filter((type) => type === "failed")).toHaveLength(1);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "missing" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("recovered"),
		]);
		const toolFailure = await pool.delegateTask({ task: "Tool failure", profile: "failure" });
		expect(toolFailure.status).toBe("completed");
		expect(toolFailure.diagnostics).toContain("Tool read failed");
	});

	it("supports timeout and user cancellation while terminating the child operation", async () => {
		const { harness, pool } = await createCoordinator({
			pool: {
				profiles: [
					{ ...DEFAULT_TEST_PROFILE(), id: "short", timeoutMs: 5 },
					{ ...DEFAULT_TEST_PROFILE(), id: "cancel", timeoutMs: 1000 },
				],
				defaultProfile: "short",
			},
		});
		const events: AgentLifecycleEvent[] = [];
		pool.subscribe((event) => events.push(event));
		harness.setResponses([
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 25));
				return fauxAssistantMessage("late");
			},
		]);
		const timedOut = await pool.delegateTask({ task: "Timeout", profile: "short" });
		expect(timedOut.status).toBe("timed_out");
		expect(timedOut.error?.code).toBe("timed_out");
		expect(timedOut.summary).toContain("Last activity: Turn 1 started.");
		expect(eventTypes(events, timedOut.taskId).filter((type) => type === "timed_out")).toHaveLength(1);

		const controller = new AbortController();
		harness.setResponses([
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 25));
				return fauxAssistantMessage("cancelled");
			},
		]);
		const cancelledPromise = pool.delegateTask({ task: "Cancel", profile: "cancel" }, controller.signal);
		controller.abort();
		const cancelled = await cancelledPromise;
		expect(cancelled.status).toBe("cancelled");
		expect(eventTypes(events, cancelled.taskId).filter((type) => type === "cancelled")).toHaveLength(1);
	});

	it("returns streamed assistant text when a child times out mid-response", async () => {
		const { harness, pool } = await createCoordinator({
			faux: { tokensPerSecond: 10, tokenSize: { min: 1, max: 1 } },
			pool: {
				profiles: [{ ...DEFAULT_TEST_PROFILE(), id: "partial-timeout", timeoutMs: 500 }],
				defaultProfile: "partial-timeout",
			},
		});
		harness.setResponses([
			fauxAssistantMessage("Partial analysis should survive the timeout instead of being discarded."),
		]);

		const result = await pool.delegateTask({ task: "Return partial output" });

		expect(result.status).toBe("timed_out");
		expect(result.error?.code).toBe("timed_out");
		expect(result.summary).toContain("Partial");
		expect(result.summary).not.toContain("No summary returned");
		expect(result.usage.outputTokens).toBeGreaterThan(0);
	});

	it("limits pool concurrency and keeps the Coordinator transcript isolated", async () => {
		const { harness, session, pool } = await createCoordinator({ pool: { maxConcurrency: 1 } });
		harness.setResponses([
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 15));
				return fauxAssistantMessage("one");
			},
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 15));
				return fauxAssistantMessage("two");
			},
		]);
		const results = await Promise.all([pool.delegateTask({ task: "first" }), pool.delegateTask({ task: "second" })]);

		expect(results.every((result) => result.status === "completed")).toBe(true);
		expect(pool.maxObservedConcurrency).toBe(1);
		expect(session.messages).toEqual([]);
	});

	it("executes delegate_task through the Coordinator AgentSession without importing child history", async () => {
		const { harness, session } = await createCoordinator();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("delegate_task", { task: "Inspect one file" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("child structured summary"),
			fauxAssistantMessage("coordinator completed"),
		]);

		await session.prompt("delegate this task");

		const toolResult = session.messages.find((message) => message.role === "toolResult");
		expect(toolResult?.role).toBe("toolResult");
		if (toolResult?.role === "toolResult") {
			expect(toolResult.toolName).toBe("delegate_task");
			expect(toolResult.details).toMatchObject({ status: "completed", summary: "child structured summary" });
			expect(toolResult.details).not.toHaveProperty("messages");
		}
		expect(session.getLastAssistantText()).toBe("coordinator completed");
		const assistantMessages = session.messages.filter((message) => message.role === "assistant");
		expect(assistantMessages).toHaveLength(2);
	});

	it("exposes coordinator-only tools in the Coordinator registry", async () => {
		let coordinatorTools: string[] = [];
		const { harness, session } = await createCoordinator();
		harness.setResponses([
			(context) => {
				coordinatorTools = context.tools?.map((tool) => tool.name) ?? [];
				return fauxAssistantMessage("coordinator");
			},
		]);
		await session.prompt("inspect tools");
		expect(coordinatorTools).toContain("delegate_task");
		expect(coordinatorTools).toContain("privileged_exec");
		expect(session.getToolDefinition("delegate_task")).toBeDefined();
		expect(session.getToolDefinition("privileged_exec")).toBeDefined();
	});
});

function DEFAULT_TEST_PROFILE() {
	return {
		id: "default-test",
		systemPrompt: "test profile",
		toolAllowlist: ["read"],
		maxTokens: 128,
		maxTurns: 4,
		allowFileModifications: false,
	} as const;
}
