import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import {
	createSearchToolDefinitions,
	createWebSearchToolDefinition,
	getSearchRuntimeToolDetails,
	resolveSearchConfig,
	SafeWebClient,
	type SearchProvider,
	type SearchProviderContext,
	type SearchProviderRequest,
	type SearchProviderResponse,
	SearchRuntime,
} from "../src/core/search/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness } from "./suite/harness.ts";

class FakeProvider implements SearchProvider {
	readonly id = "fake";
	calls: SearchProviderRequest[] = [];
	response: SearchProviderResponse = { results: [] };
	error?: Error;

	async search(request: SearchProviderRequest, _context: SearchProviderContext): Promise<SearchProviderResponse> {
		this.calls.push(request);
		if (this.error) throw this.error;
		return structuredClone(this.response);
	}
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

beforeAll(() => initTheme("dark"));

async function tempDir(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "beaupi-web-tools-"));
	cleanups.push(async () => await rm(path, { recursive: true, force: true }));
	return path;
}

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(
		async () =>
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	);
	return (server.address() as AddressInfo).port;
}

function config() {
	return resolveSearchConfig(
		{
			searxng: { endpoint: "http://unused.test", maxResults: 5 },
			cache: { queryTtlMs: 10_000, fetchTtlMs: 10_000 },
			budget: {
				maxResultsPerSearch: 5,
				maxQueriesPerTask: 5,
				maxFetchesPerTask: 5,
				maxProviderAttemptsPerTask: 5,
				maxFetchBytes: 100_000,
				maxInputCharactersPerTask: 60_000,
				timeoutMs: 100,
				maxRedirects: 2,
			},
		},
		{},
	);
}

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

async function createRuntime(provider: FakeProvider, urlHost = "fetch.test") {
	const cacheDir = await tempDir();
	return new SearchRuntime({
		cacheDir,
		getConfig: config,
		provider,
		webClient: new SafeWebClient({
			lookup: async (hostname) => {
				if (hostname === urlHost) return [{ address: "127.0.0.1", family: 4 }];
				const error = new Error("not found") as NodeJS.ErrnoException;
				error.code = "ENOTFOUND";
				throw error;
			},
			allowHostnames: new Set([urlHost]),
		}),
	});
}

describe("M8 web tools, lifecycle, and renderer", () => {
	it("uses TypeBox validation and emits versioned, structured, secret-free details", async () => {
		const provider = new FakeProvider();
		provider.response.results = [
			{ title: "Result", url: "https://example.com", snippet: "snippet", provider: "fake", rank: 1 },
		];
		const runtime = await createRuntime(provider);
		const tool = createWebSearchToolDefinition(runtime, { budgetScopeId: "task" });
		await expect(
			tool.execute("invalid", { query: "x", maxResults: 0 } as never, undefined, undefined, {} as never),
		).rejects.toThrow("invalid parameters");
		const result = await tool.execute("valid", { query: "query", maxResults: 1 }, undefined, undefined, {} as never);
		expect(result.details.searchRuntime).toMatchObject({
			version: 1,
			operation: "search",
			ok: true,
			provider: "fake",
			untrustedExternalContent: true,
		});
		expect(result.details.searchRuntime.citations[0]).toMatchObject({ kind: "web", level: "search" });
		expect(JSON.stringify(result.details)).not.toContain("Authorization");
	});

	it("renders web_search and web_fetch in the minimal Tool shell without horizontal overflow", async () => {
		const provider = new FakeProvider();
		provider.response.results = [
			{
				title: "A very long result title that should still remain bounded by the terminal renderer",
				url: "https://example.com/a/very/long/path/to/documentation",
				snippet: "snippet",
				provider: "fake",
				rank: 1,
			},
		];
		const runtime = await createRuntime(provider);
		const definitions = createSearchToolDefinitions(runtime, { budgetScopeId: "renderer" });
		const searchTool = definitions.find((tool) => tool.name === "web_search")!;
		const searchResult = await searchTool.execute(
			"search",
			{ query: "long search query" } as never,
			undefined,
			undefined,
			{} as never,
		);
		const fetchTool = definitions.find((tool) => tool.name === "web_fetch")!;
		const failedFetch = await fetchTool.execute(
			"fetch",
			{ url: "http://127.0.0.1/" } as never,
			undefined,
			undefined,
			{} as never,
		);

		for (const [tool, args, result] of [
			[searchTool, { query: "long search query" }, searchResult],
			[fetchTool, { url: "http://127.0.0.1/" }, failedFetch],
		] as const) {
			const component = new ToolExecutionComponent(
				tool.name,
				`call-${tool.name}`,
				args,
				{},
				tool,
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{ ...result, isError: getSearchRuntimeToolDetails(result.details)?.ok === false },
				false,
			);
			for (const width of [80, 120, 160]) {
				const lines = component.render(width);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(stripAnsi(lines.join("\n"))).not.toContain("┌");
			}
		}
	});

	it("lets a faux Coordinator search, fetch the selected page, persist citations, and restore cache/budget state", async () => {
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		const server = createServer((_request, response) => {
			response
				.writeHead(200, { "content-type": "text/html" })
				.end(
					"<html><head><title>Official Docs</title></head><body><main><h1>Official Docs</h1><p>Verified page body.</p></main></body></html>",
				);
		});
		const port = await listen(server);
		const provider = new FakeProvider();
		const url = `http://fetch.test:${port}/docs`;
		provider.response.results = [
			{ title: "Official Docs", url, snippet: "discovery snippet", provider: "fake", rank: 1 },
		];
		const runtime = await createRuntime(provider);
		const manager = SessionManager.inMemory(harness.tempDir);
		const created = await createAgentSession({
			cwd: harness.tempDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
			searchRuntime: runtime,
		});
		cleanups.push(() => created.session.dispose());
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("web_search", { query: "official docs", maxResults: 1 }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("web_fetch", { url }), { stopReason: "toolUse" }),
			fauxAssistantMessage("research complete"),
		]);

		await created.session.prompt("research the official docs");
		const toolResults = created.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(2);
		expect(toolResults[0]?.role === "toolResult" && toolResults[0].details).toMatchObject({
			searchRuntime: { operation: "search", citations: [expect.objectContaining({ level: "search" })] },
		});
		expect(toolResults[1]?.role === "toolResult" && toolResults[1].details).toMatchObject({
			searchRuntime: { operation: "fetch", citations: [expect.objectContaining({ level: "content" })] },
		});
		expect(created.session.taskLedger.getSnapshot().network).toHaveLength(2);
		expect(created.session.systemPrompt).toContain("do not retry with curl, wget, Python, Node, Bash");
		expect(provider.calls).toHaveLength(1);

		created.session.dispose();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("web_search", { query: "official docs", maxResults: 1 }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("resumed"),
		]);
		const resumed = await createAgentSession({
			cwd: harness.tempDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
			searchRuntime: runtime,
		});
		cleanups.push(() => resumed.session.dispose());
		await resumed.session.prompt("repeat the same discovery after resume");
		const latestNetwork = resumed.session.taskLedger.getSnapshot().network.at(-1);
		expect(latestNetwork?.cacheHit).toBe(true);
		expect(latestNetwork?.budget.used.queries).toBe(2);
		expect(provider.calls).toHaveLength(1);
	});

	it("marks structured search failures in the existing Task Ledger and honors registry deny lists", async () => {
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		const provider = new FakeProvider();
		provider.error = new Error("provider exploded");
		const runtime = await createRuntime(provider);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("web_search", { query: "failure" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("stopped"),
		]);
		const created = await createAgentSession({
			cwd: harness.tempDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
			sessionManager: SessionManager.inMemory(harness.tempDir),
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
			searchRuntime: runtime,
			excludeTools: ["web_fetch"],
		});
		cleanups.push(() => created.session.dispose());
		expect(created.session.getToolDefinition("web_search")).toBeDefined();
		expect(created.session.getToolDefinition("web_fetch")).toBeUndefined();
		await created.session.prompt("search and stop on failure");
		const snapshot = created.session.taskLedger.getSnapshot();
		expect(snapshot.failures.at(-1)?.toolName).toBe("web_search");
		expect(snapshot.network.at(-1)).toMatchObject({ status: "failed", cacheHit: false });
	});

	it("shares one cache and structured web citations with a controlled researcher child agent", async () => {
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		const provider = new FakeProvider();
		provider.response.results = [
			{ title: "Shared", url: "https://example.com/shared", snippet: "shared", provider: "fake", rank: 1 },
		];
		const runtime = await createRuntime(provider);
		const manager = SessionManager.inMemory(harness.tempDir);
		const created = await createAgentSession({
			cwd: harness.tempDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
			searchRuntime: runtime,
			agentPool: {
				profiles: [
					{
						id: "researcher",
						systemPrompt: "controlled researcher",
						toolAllowlist: ["web_search", "web_fetch"],
						allowFileModifications: false,
					},
				],
				defaultProfile: "researcher",
			},
		});
		cleanups.push(() => created.session.dispose());
		await runtime.search({ query: "shared query" }, { budgetScopeId: manager.getSessionId() });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("web_search", { query: "shared query" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("child research summary"),
		]);
		const result = await created.session.agentPool!.delegateTask({
			task: "research shared query",
			profile: "researcher",
		});
		expect(result.status).toBe("completed");
		expect(result.citations).toEqual([
			expect.objectContaining({ kind: "web", level: "search", url: "https://example.com/shared" }),
		]);
		expect(result.references).toContain("https://example.com/shared");
		expect(provider.calls).toHaveLength(1);
	});
});
