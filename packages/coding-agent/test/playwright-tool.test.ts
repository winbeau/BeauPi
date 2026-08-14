import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { Browser } from "playwright";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { isWorkspaceMutatingToolCall } from "../src/core/execution/tool-kind.ts";
import {
	attachPlaywrightRuntimeToolDetails,
	createPlaywrightRuntimeDetails,
	createPlaywrightToolDefinition,
	DefaultPlaywrightAdapter,
	getPlaywrightRuntimeToolDetails,
	PLAYWRIGHT_INPUT_VALIDATOR,
	PLAYWRIGHT_PARAMETERS,
	type PlaywrightAdapter,
	PlaywrightNetworkPolicy,
	PlaywrightRuntime,
	type ResolvedPlaywrightConfig,
	resolvePlaywrightConfig,
} from "../src/core/playwright/index.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const cleanups: Array<() => void | Promise<void>> = [];

const TINY_PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
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

class CapturingAdapter implements PlaywrightAdapter {
	private readonly delegate: DefaultPlaywrightAdapter;
	browser?: Browser;

	constructor(cwd: string) {
		this.delegate = new DefaultPlaywrightAdapter(cwd);
	}

	async launch(config: ResolvedPlaywrightConfig) {
		const result = await this.delegate.launch(config);
		this.browser = result.browser;
		return result;
	}
}

beforeAll(() => initTheme("dark"));

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("native Playwright tool contract", () => {
	it("serializes the provider-facing function schema as a top-level object", () => {
		const runtime = new PlaywrightRuntime({ cwd: process.cwd() });
		cleanups.push(async () => await runtime.dispose());
		const definition = createPlaywrightToolDefinition(runtime);
		const schema = JSON.parse(JSON.stringify(definition.parameters)) as {
			type?: unknown;
			anyOf?: unknown[];
		};

		expect(PLAYWRIGHT_PARAMETERS).toBe(definition.parameters);
		expect(schema.type).toBe("object");
		expect(schema.anyOf).toHaveLength(16);
	});

	it("accepts the strict action union and rejects missing or extra fields", () => {
		expect(PLAYWRIGHT_INPUT_VALIDATOR.Check({ action: "navigate", url: "https://example.com" })).toBe(true);
		expect(
			PLAYWRIGHT_INPUT_VALIDATOR.Check({
				action: "act",
				kind: "click",
				target: { by: "role", role: "button", name: "Save" },
			}),
		).toBe(true);
		expect(PLAYWRIGHT_INPUT_VALIDATOR.Check({ action: "act", kind: "click" })).toBe(false);
		expect(
			PLAYWRIGHT_INPUT_VALIDATOR.Check({ action: "navigate", url: "https://example.com", unexpected: true }),
		).toBe(false);
		expect(
			PLAYWRIGHT_INPUT_VALIDATOR.Check({ action: "screenshot", fullPage: true, target: { by: "text", value: "x" } }),
		).toBe(false);
	});

	it("resolves bounded settings and rejects ambiguous browser selection", () => {
		expect(resolvePlaywrightConfig(undefined)).toMatchObject({
			headless: true,
			actionTimeoutMs: 15_000,
			navigationTimeoutMs: 30_000,
			allowPrivateNetwork: false,
		});
		expect(resolvePlaywrightConfig({ actionTimeoutMs: 1, navigationTimeoutMs: 999_999 })).toMatchObject({
			actionTimeoutMs: 100,
			navigationTimeoutMs: 120_000,
		});
		expect(() => resolvePlaywrightConfig({ executablePath: "/chrome", channel: "chrome" })).toThrow(
			"mutually exclusive",
		);
	});

	it("allows public and loopback targets while blocking unsafe browser destinations", async () => {
		const policy = new PlaywrightNetworkPolicy({
			allowPrivateNetwork: false,
			lookup: async (hostname) => {
				if (hostname === "public.test") return [{ address: "93.184.216.34", family: 4 }];
				if (hostname === "private.test") return [{ address: "192.168.1.10", family: 4 }];
				if (hostname === "metadata.test") return [{ address: "169.254.169.254", family: 4 }];
				throw new Error(`unexpected host ${hostname}`);
			},
		});

		await expect(policy.validate("https://public.test/path")).resolves.toMatchObject({ privateNetwork: false });
		await expect(policy.validate("http://127.0.0.1:3000/")).resolves.toMatchObject({ loopback: true });
		await expect(policy.validate("http://localhost:3000/")).resolves.toMatchObject({ loopback: true });
		await expect(policy.validate("http://private.test/")).rejects.toThrow("private LAN");
		await expect(policy.validate("http://metadata.test/")).rejects.toThrow("reserved");
		await expect(policy.validate("http://user:pass@public.test/")).rejects.toThrow("credentials");
		await expect(policy.validate("file:///tmp/test.html")).rejects.toThrow("protocol");
		await expect(policy.validate("http://metadata.google.internal/")).rejects.toThrow("metadata");
	});

	it("renders Playwright calls and results in the minimal Tool shell without horizontal overflow", () => {
		const runtime = new PlaywrightRuntime({ cwd: process.cwd() });
		cleanups.push(async () => await runtime.dispose());
		const definition = createPlaywrightToolDefinition(runtime);
		const tui = { requestRender: () => {} } as unknown as TUI;
		const component = new ToolExecutionComponent(
			"playwright",
			"playwright-render",
			{ action: "screenshot", fullPage: true },
			{ showImages: false },
			definition,
			tui,
			process.cwd(),
		);
		const details = createPlaywrightRuntimeDetails("screenshot", Date.now(), {
			ok: true,
			pageId: "main",
			url: "https://example.com/a/very/long/path/that/must/not/overflow/the/terminal",
			screenshot: {
				mimeType: "image/png",
				width: 1440,
				height: 900,
				sha256: "abc",
				fullPage: true,
			},
		});
		component.updateResult(
			{
				content: [{ type: "text", text: "Screenshot captured" }],
				details: attachPlaywrightRuntimeToolDetails(undefined, details),
				isError: false,
			},
			false,
		);
		for (const width of [80, 120, 160]) {
			for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("treats a workspace screenshot as the only Playwright write fact", () => {
		expect(isWorkspaceMutatingToolCall("playwright", { action: "snapshot" })).toBe(false);
		expect(
			isWorkspaceMutatingToolCall("playwright", {
				action: "act",
				kind: "click",
				target: { by: "text", value: "Save" },
			}),
		).toBe(false);
		expect(isWorkspaceMutatingToolCall("playwright", { action: "navigate", url: "https://example.com" })).toBe(false);
		expect(isWorkspaceMutatingToolCall("playwright", { action: "screenshot", savePath: "artifacts/page.png" })).toBe(
			true,
		);
		expect(isWorkspaceMutatingToolCall("playwright", { action: "screenshot" })).toBe(false);
	});
});

const managedBrowserAvailable = (() => {
	try {
		const require = createRequire(import.meta.url);
		const playwright = require("playwright") as { chromium: { executablePath(): string } };
		return existsSync(playwright.chromium.executablePath());
	} catch {
		return false;
	}
})();

describe.runIf(managedBrowserAvailable)("native Playwright real Chromium smoke", () => {
	it("navigates localhost, interacts, captures PNG ImageContent, and closes Chromium", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "beaupi-playwright-real-"));
		cleanups.push(async () => await rm(cwd, { recursive: true, force: true }));
		const server = createServer((_request, response) => {
			response
				.writeHead(200, { "content-type": "text/html" })
				.end(
					"<!doctype html><html><head><title>Playwright Smoke</title></head><body><h1>Ready</h1><button aria-label=\"Save\">Save</button><p id=\"status\">Idle</p><script>document.querySelector('button').addEventListener('click',()=>{document.querySelector('#status').textContent='Saved';console.error('smoke event')})</script></body></html>",
				);
		});
		const port = await listen(server);
		const adapter = new CapturingAdapter(cwd);
		const runtime = new PlaywrightRuntime({ cwd, adapter, getAutoResizeImages: () => false });
		cleanups.push(async () => await runtime.dispose());

		const navigation = await runtime.execute({ action: "navigate", url: `http://127.0.0.1:${port}/` });
		expect(getPlaywrightRuntimeToolDetails(navigation.details)).toMatchObject({
			operation: "navigate",
			ok: true,
			title: "Playwright Smoke",
		});

		const snapshot = await runtime.execute({ action: "snapshot" });
		expect(text(snapshot)).toContain("Snapshot boundary: untrusted rendered page content");
		expect(text(snapshot)).toContain("Ready");

		const action = await runtime.execute({
			action: "act",
			kind: "click",
			target: { by: "role", role: "button", name: "Save" },
		});
		expect(getPlaywrightRuntimeToolDetails(action.details)?.ok).toBe(true);

		const events = await runtime.execute({ action: "events", cursor: 0, levels: ["error"] });
		expect(text(events)).toContain("smoke event");

		const screenshot = await runtime.execute({ action: "screenshot", savePath: "artifacts/page.png" });
		const screenshotDetails = getPlaywrightRuntimeToolDetails(screenshot.details);
		expect(screenshotDetails).toMatchObject({
			operation: "screenshot",
			ok: true,
			screenshot: { mimeType: "image/png", savedPath: join(cwd, "artifacts/page.png") },
		});
		const image = screenshot.content.find(
			(part): part is { type: "image"; data: string; mimeType: string } => part.type === "image",
		);
		expect(image?.mimeType).toBe("image/png");
		expect(Buffer.from(image?.data ?? "", "base64").subarray(0, 8)).toEqual(TINY_PNG_SIGNATURE);
		expect((await readFile(join(cwd, "artifacts/page.png"))).subarray(0, 8)).toEqual(TINY_PNG_SIGNATURE);
		expect(JSON.stringify(screenshot.details)).not.toContain(image?.data ?? "missing-image");

		await runtime.execute({ action: "evaluate", expression: "document.body.style.minHeight = '21000px'" });
		const oversized = await runtime.execute({ action: "screenshot", fullPage: true });
		expect(getPlaywrightRuntimeToolDetails(oversized.details)).toMatchObject({
			ok: false,
			diagnostic: { code: "image_processing" },
		});

		await runtime.dispose();
		expect(adapter.browser?.isConnected()).toBe(false);
	});
});
