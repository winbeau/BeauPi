import { afterEach, describe, expect, it } from "vitest";
import {
	createExtensionRuntime,
	type ExtensionFactory,
	loadExtensionFromFactory,
} from "../src/core/extensions/index.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	allToolNames,
	coreToolNames,
	createAllToolDefinitions,
	createCoreToolRegistry,
	RUNTIME_TOOL_NAMES,
	ToolRegistry,
	type ToolRegistryEntry,
	ToolRegistryError,
} from "../src/core/tools/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const created: Harness[] = [];

afterEach(() => {
	for (const harness of created.splice(0)) harness.cleanup();
});

describe("tool registry", () => {
	it("derives core tool names from the registry (no second hand-written list)", () => {
		const registry = createCoreToolRegistry();
		expect(registry.names().sort()).toEqual(coreToolNames().sort());
		// Every core registry name has a constructible definition.
		const diagnostics = registry.validate();
		expect(diagnostics).toEqual([]);
		// allToolNames = core names + runtime-owned names.
		expect([...allToolNames].sort()).toEqual([...coreToolNames(), ...RUNTIME_TOOL_NAMES].sort());
		// The registry names match createAllToolDefinitions keys exactly.
		const definitionNames = Object.keys(createAllToolDefinitions("/tmp"));
		expect(definitionNames.sort()).toEqual(coreToolNames().sort());
	});

	it("rejects duplicate names and detects definition name mismatches", () => {
		const registry = new ToolRegistry();
		const entry: ToolRegistryEntry = {
			name: "read",
			source: "core",
			createDefinition: (cwd) => createAllToolDefinitions(cwd).read,
		};
		registry.register(entry);
		expect(() => registry.register(entry)).toThrow(ToolRegistryError);

		const mismatched = new ToolRegistry();
		mismatched.register({
			name: "renamed_read",
			source: "custom",
			createDefinition: (cwd) => createAllToolDefinitions(cwd).read,
		});
		expect(mismatched.validate()).toHaveLength(1);
		expect(mismatched.validate()[0]).toContain("name mismatch");
	});

	it("exposes diagnostic manifests without authorizing anything", () => {
		const registry = createCoreToolRegistry();
		const manifests = registry.manifests();
		const bash = manifests.find((manifest) => manifest.name === "bash");
		expect(bash).toMatchObject({
			source: "core",
			sideEffect: "process",
			supportsCancellation: true,
			timeoutMetadata: { parameter: "timeout", unit: "seconds" },
		});
		expect(bash?.schema).toBeTruthy();
		const read = manifests.find((manifest) => manifest.name === "read");
		expect(read?.sideEffect).toBe("none");
	});

	it("reports duplicate custom tool names as deterministic session diagnostics", async () => {
		const harness = await createHarness();
		created.push(harness);
		const sessionManager = SessionManager.inMemory(harness.tempDir);
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const duplicate = {
			name: "custom_tool",
			label: "custom_tool",
			description: "Duplicate custom tool",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
		};
		const result = await createAgentSession({
			cwd: harness.tempDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
			sessionManager,
			settingsManager,
			customTools: [duplicate, duplicate],
			agentPool: false,
		});
		expect(result.toolRegistryDiagnostics?.some((message) => message.includes("custom_tool"))).toBe(true);
	});

	it("allows custom tools to intentionally shadow core tool names without diagnostics", async () => {
		const harness = await createHarness();
		created.push(harness);
		const sessionManager = SessionManager.inMemory(harness.tempDir);
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const result = await createAgentSession({
			cwd: harness.tempDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
			sessionManager,
			settingsManager,
			customTools: [
				{
					name: "bash",
					label: "bash",
					description: "Shadowing bash",
					parameters: { type: "object", properties: {} },
					execute: async () => ({ content: [{ type: "text" as const, text: "shadowed" }], details: {} }),
				},
			],
			agentPool: false,
		});
		expect(result.toolRegistryDiagnostics ?? []).toEqual([]);
	});
});

describe("extension manifest", () => {
	it("reads a manifest attached to the factory for load-order diagnostics", async () => {
		const factory: ExtensionFactory & { manifest?: unknown } = async (pi) => {
			pi.registerTool({
				name: "manifested_tool",
				label: "Manifested",
				description: "Tool from a manifested extension",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
			});
		};
		factory.manifest = {
			id: "manifested-extension",
			version: "1.2.3",
			priority: 5,
			capabilities: ["tools"],
			trustLevel: "default",
		};
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(factory, "/tmp", undefined as never, runtime, "<test>");
		expect(extension.manifest).toMatchObject({
			id: "manifested-extension",
			version: "1.2.3",
			priority: 5,
			capabilities: ["tools"],
		});
		expect(extension.tools.has("manifested_tool")).toBe(true);
	});

	it("ignores malformed manifests", async () => {
		const factory = (async () => {}) as ExtensionFactory & { manifest?: unknown };
		factory.manifest = { priority: "not-a-number" };
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(factory, "/tmp", undefined as never, runtime, "<test>");
		expect(extension.manifest).toBeUndefined();
	});
});

describe("config explain", () => {
	it("reports the final value and its source scope", async () => {
		const settingsManager = SettingsManager.inMemory({ retry: { enabled: true } });
		expect(settingsManager.explainSetting("retry.enabled")).toEqual({
			key: "retry.enabled",
			finalValue: true,
			source: "global",
			precedence: "project > global",
		});
		expect(settingsManager.explainSetting("retry.maxRetries")).toMatchObject({ source: "missing" });
		expect(settingsManager.explainSetting("missing.key")).toMatchObject({ source: "missing" });
	});

	it("marks project overrides and keeps the final value", async () => {
		const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 3 } });
		settingsManager.setProjectExecutionTargets([
			{ id: "local", label: "Local", scope: "project", sshAlias: "local" },
		]);
		const explanation = settingsManager.explainSetting("executionTargets");
		expect(explanation).toMatchObject({
			key: "executionTargets",
			source: "project",
			overriddenBy: "project",
		});
		expect(explanation.finalValue).toEqual([{ id: "local", label: "Local", scope: "project", sshAlias: "local" }]);
		expect(settingsManager.explainSetting("retry.maxRetries")).toMatchObject({
			finalValue: 3,
			source: "global",
		});
	});
});
