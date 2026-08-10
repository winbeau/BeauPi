import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Browser, BrowserContext, Page, Request, WebSocketRoute } from "playwright";
import { processImage } from "../../utils/image-process.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";
import { withFileMutationQueue } from "../tools/file-mutation-queue.ts";
import { resolveToCwd } from "../tools/path-utils.ts";
import { DefaultPlaywrightAdapter, PlaywrightAdapterError } from "./browser-loader.ts";
import { resolvePlaywrightConfig } from "./config.ts";
import {
	attachPlaywrightRuntimeToolDetails,
	createPlaywrightRuntimeDetails,
	playwrightErrorResult,
} from "./details.ts";
import { formatPlaywrightTarget, PlaywrightLocatorError, resolveLocator, resolveUniqueLocator } from "./locator.ts";
import { type PlaywrightDnsLookup, PlaywrightNetworkPolicy, PlaywrightNetworkPolicyError } from "./network-policy.ts";
import {
	boundPlaywrightText,
	countRedirects,
	PlaywrightSerializationError,
	parsePngDimensions,
	serializePlaywrightEvaluation,
} from "./operations.ts";
import type {
	PlaywrightAction,
	PlaywrightAdapter,
	PlaywrightDiagnostic,
	PlaywrightDiagnosticCode,
	PlaywrightEventRecord,
	PlaywrightInput,
	PlaywrightPageRecord,
	PlaywrightPageSummary,
	PlaywrightRuntimeToolDetailsV1,
	PlaywrightSettings,
	PlaywrightToolDetails,
	PlaywrightViewport,
	ResolvedPlaywrightConfig,
} from "./types.ts";

const DEFAULT_VIEWPORT = { width: 1440, height: 900 } as const;
const MAX_EVENTS = 500;
const MAX_EVENT_MESSAGE = 4_096;
const MAX_URL = 8_192;
const MAX_TITLE = 1_000;
const MAX_FULL_PAGE_HEIGHT = 20_000;
const MAX_SCREENSHOT_PIXELS = 40_000_000;

export interface PlaywrightRuntimeOptions {
	cwd: string;
	getSettings?: () => PlaywrightSettings | undefined;
	getAutoResizeImages?: () => boolean;
	adapter?: PlaywrightAdapter;
	lookup?: PlaywrightDnsLookup;
}

class PlaywrightRuntimeError extends Error {
	readonly code: PlaywrightDiagnosticCode;
	readonly suggestion?: string;

	constructor(code: PlaywrightDiagnosticCode, message: string, suggestion?: string) {
		super(message);
		this.name = "PlaywrightRuntimeError";
		this.code = code;
		this.suggestion = suggestion;
	}
}

function clipped(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 15))}... [truncated]`;
}

function combineSignals(signal: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
	return signal ? AbortSignal.any([signal, internal]) : internal;
}

function isJsonValue(value: unknown, depth = 0): boolean {
	if (depth > 20) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
	if (typeof value !== "object") return false;
	return Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, depth + 1));
}

async function raceWithAbortAndTimeout<T>(
	promise: Promise<T>,
	options: { signal: AbortSignal; timeoutMs: number },
): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	return new Promise<T>((resolve, reject) => {
		const cleanup = (): void => {
			if (timeout) clearTimeout(timeout);
			options.signal.removeEventListener("abort", onAbort);
		};
		const onAbort = (): void => {
			cleanup();
			reject(new PlaywrightRuntimeError("cancelled", "The Playwright operation was cancelled."));
		};
		if (options.signal.aborted) {
			onAbort();
			return;
		}
		options.signal.addEventListener("abort", onAbort, { once: true });
		timeout = setTimeout(() => {
			cleanup();
			reject(new PlaywrightRuntimeError("timeout", `The Playwright operation exceeded ${options.timeoutMs}ms.`));
		}, options.timeoutMs);
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
	});
}

function pageDetails(pageId: string, page: Page): Pick<PlaywrightRuntimeToolDetailsV1, "pageId" | "url"> {
	return { pageId, url: clipped(page.url(), MAX_URL) };
}

export class PlaywrightRuntime {
	private readonly cwd: string;
	private readonly getSettings: () => PlaywrightSettings | undefined;
	private readonly getAutoResizeImages: () => boolean;
	private readonly adapter: PlaywrightAdapter;
	private readonly lookup?: PlaywrightDnsLookup;
	private browser?: Browser;
	private context?: BrowserContext;
	private networkPolicy?: PlaywrightNetworkPolicy;
	private contextDeviceScaleFactor = 1;
	private readonly pages = new Map<string, PlaywrightPageRecord>();
	private readonly pageIds = new WeakMap<Page, string>();
	private activePageId?: string;
	private nextPageNumber = 2;
	private requestedPageId?: string;
	private events: PlaywrightEventRecord[] = [];
	private eventSequence = 0;
	private disposed = false;
	private tail: Promise<void> = Promise.resolve();
	private activeAbort?: AbortController;

	constructor(options: PlaywrightRuntimeOptions) {
		this.cwd = options.cwd;
		this.getSettings = options.getSettings ?? (() => undefined);
		this.getAutoResizeImages = options.getAutoResizeImages ?? (() => true);
		this.adapter = options.adapter ?? new DefaultPlaywrightAdapter(options.cwd);
		this.lookup = options.lookup;
	}

	isDisposed(): boolean {
		return this.disposed;
	}

	execute(input: PlaywrightInput, signal?: AbortSignal): Promise<AgentToolResult<PlaywrightToolDetails>> {
		const run = this.tail.then(() => this.executeUnlocked(input, signal));
		this.tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async reset(): Promise<void> {
		if (this.disposed) return;
		this.activeAbort?.abort();
		const run = this.tail.then(async () => {
			await this.closeResources(true);
			this.clearSessionState();
		});
		this.tail = run.then(
			() => undefined,
			() => undefined,
		);
		await run;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.activeAbort?.abort();
		await this.tail.catch(() => {});
		await this.closeResources(true);
		this.clearSessionState();
	}

	private config(): ResolvedPlaywrightConfig {
		return resolvePlaywrightConfig(this.getSettings());
	}

	private async executeUnlocked(
		input: PlaywrightInput,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<PlaywrightToolDetails>> {
		const startedAt = Date.now();
		if (this.disposed) {
			return playwrightErrorResult(input.action, startedAt, {
				code: "browser_disconnected",
				message: "This Playwright runtime has been disposed.",
			});
		}
		const internalAbort = new AbortController();
		this.activeAbort = internalAbort;
		const combinedSignal = combineSignals(signal, internalAbort.signal);
		try {
			switch (input.action) {
				case "navigate":
					return await this.navigate(input, startedAt, combinedSignal);
				case "snapshot":
					return await this.snapshot(input, startedAt, combinedSignal);
				case "act":
					return await this.act(input, startedAt, combinedSignal);
				case "screenshot":
					return await this.screenshot(input, startedAt, combinedSignal);
				case "evaluate":
					return await this.evaluate(input, startedAt, combinedSignal);
				case "events":
					return await this.readEvents(input, startedAt);
				case "pages":
					return await this.managePages(input, startedAt, combinedSignal);
			}
			throw new PlaywrightRuntimeError("internal", "Unknown Playwright action.");
		} catch (error) {
			const diagnostic = this.diagnosticFor(error, input.action, signal, combinedSignal);
			return playwrightErrorResult(input.action, startedAt, diagnostic, {
				pageId: "pageId" in input ? input.pageId : undefined,
			});
		} finally {
			if (this.activeAbort === internalAbort) this.activeAbort = undefined;
		}
	}

	private diagnosticFor(
		error: unknown,
		action: PlaywrightAction,
		externalSignal: AbortSignal | undefined,
		combinedSignal: AbortSignal,
	): PlaywrightDiagnostic {
		if (externalSignal?.aborted || combinedSignal.aborted) {
			return { code: "cancelled", message: "The Playwright operation was cancelled." };
		}
		if (
			error instanceof PlaywrightRuntimeError ||
			error instanceof PlaywrightAdapterError ||
			error instanceof PlaywrightNetworkPolicyError ||
			error instanceof PlaywrightLocatorError
		) {
			return {
				code: error.code,
				message: clipped(error.message, MAX_EVENT_MESSAGE),
				suggestion: "suggestion" in error && typeof error.suggestion === "string" ? error.suggestion : undefined,
			};
		}
		if (error instanceof PlaywrightSerializationError) {
			return { code: "serialization", message: clipped(error.message, MAX_EVENT_MESSAGE) };
		}
		const message = error instanceof Error ? error.message : String(error);
		const lower = message.toLowerCase();
		if (error instanceof Error && error.name === "TimeoutError") {
			return { code: "timeout", message: clipped(message, MAX_EVENT_MESSAGE) };
		}
		if (
			lower.includes("browser has been closed") ||
			lower.includes("target page, context or browser has been closed")
		) {
			return { code: "browser_disconnected", message: clipped(message, MAX_EVENT_MESSAGE) };
		}
		return {
			code: action === "navigate" ? "navigation" : "internal",
			message: clipped(message, MAX_EVENT_MESSAGE),
		};
	}

	private success(
		operation: PlaywrightAction,
		startedAt: number,
		content: Array<TextContent | ImageContent>,
		fields: Omit<PlaywrightRuntimeToolDetailsV1, "version" | "operation" | "ok" | "durationMs">,
	): AgentToolResult<PlaywrightToolDetails> {
		const details = createPlaywrightRuntimeDetails(operation, startedAt, { ...fields, ok: true });
		return { content, details: attachPlaywrightRuntimeToolDetails(undefined, details) };
	}

	private async ensureContext(viewport?: PlaywrightViewport): Promise<BrowserContext> {
		if (this.context && this.browser?.isConnected()) {
			await this.ensureDeviceScaleFactor(viewport);
			if (this.context) return this.context;
		}
		const config = this.config();
		let browser = this.browser?.isConnected() ? this.browser : undefined;
		if (!browser) {
			const launch = await this.adapter.launch(config);
			browser = launch.browser;
			this.browser = browser;
			browser.on("disconnected", () => {
				if (this.browser !== browser) return;
				this.pushEvent({ kind: "browser_disconnected", message: "The Chromium browser disconnected." });
				this.browser = undefined;
				this.context = undefined;
				this.pages.clear();
				this.activePageId = undefined;
			});
		}
		this.contextDeviceScaleFactor = viewport?.deviceScaleFactor ?? 1;
		this.networkPolicy = new PlaywrightNetworkPolicy({
			allowPrivateNetwork: config.allowPrivateNetwork,
			lookup: this.lookup,
		});
		const context = await browser.newContext({
			acceptDownloads: false,
			viewport: {
				width: viewport?.width ?? DEFAULT_VIEWPORT.width,
				height: viewport?.height ?? DEFAULT_VIEWPORT.height,
			},
			deviceScaleFactor: this.contextDeviceScaleFactor,
			serviceWorkers: "block",
		});
		context.setDefaultTimeout(config.actionTimeoutMs);
		context.setDefaultNavigationTimeout(config.navigationTimeoutMs);
		await context.route("**/*", async (route) => {
			try {
				await this.networkPolicy?.validate(route.request().url(), "request");
				await route.continue();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.pushEvent({
					kind: "request_blocked",
					pageId: this.pageIdForRequest(route.request()),
					message,
					url: route.request().url(),
				});
				await route.abort("blockedbyclient").catch(() => {});
			}
		});
		await context.routeWebSocket("**/*", async (webSocketRoute: WebSocketRoute) => {
			try {
				await this.networkPolicy?.validate(webSocketRoute.url(), "request");
				webSocketRoute.connectToServer();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.pushEvent({ kind: "request_blocked", message, url: webSocketRoute.url() });
				await webSocketRoute.close({ code: 1008, reason: "Blocked by Playwright network policy" }).catch(() => {});
			}
		});
		context.on("page", (page) => this.registerPage(page, this.requestedPageId));
		context.on("requestfailed", (request) => {
			this.pushEvent({
				kind: "requestfailed",
				pageId: this.pageIdForRequest(request),
				message: `${request.method()} ${request.failure()?.errorText ?? "request failed"}`,
				url: request.url(),
			});
		});
		this.context = context;
		await this.createPage("main", viewport);
		return context;
	}

	private async ensureDeviceScaleFactor(viewport?: PlaywrightViewport): Promise<void> {
		const requested = viewport?.deviceScaleFactor;
		if (requested === undefined || requested === this.contextDeviceScaleFactor) return;
		const stateful = [...this.pages.values()].some((record) => record.page.url() !== "about:blank");
		if (stateful) {
			throw new PlaywrightRuntimeError(
				"internal",
				"deviceScaleFactor is fixed for the current browser context. Run pages.reset before changing it.",
			);
		}
		await this.closeResources(false);
		this.context = undefined;
		this.pages.clear();
		this.activePageId = undefined;
	}

	private async createPage(pageId: string, viewport?: PlaywrightViewport): Promise<Page> {
		const context = this.context ?? (await this.ensureContext(viewport));
		this.requestedPageId = pageId;
		try {
			const page = await context.newPage();
			if (!this.pageIds.has(page)) this.registerPage(page, pageId);
			if (viewport) await page.setViewportSize({ width: viewport.width, height: viewport.height });
			this.activePageId = this.pageIds.get(page) ?? pageId;
			return page;
		} finally {
			this.requestedPageId = undefined;
		}
	}

	private registerPage(page: Page, requestedId?: string): void {
		if (this.pageIds.has(page)) return;
		let pageId = requestedId;
		if (!pageId || this.pages.has(pageId)) {
			pageId = this.pages.size === 0 && !this.pages.has("main") ? "main" : this.allocatePageId();
		}
		this.pageIds.set(page, pageId);
		this.pages.set(pageId, { pageId, page, createdAt: Date.now() });
		this.activePageId = pageId;
		if (pageId !== "main") this.pushEvent({ kind: "popup", pageId, message: `Registered browser page ${pageId}.` });
		page.on("console", (message) => {
			const level = message.type();
			this.pushEvent({
				kind: "console",
				pageId,
				level:
					level === "debug" || level === "info" || level === "log" || level === "warning" || level === "error"
						? level
						: "log",
				message: message.text(),
				url: message.location().url || page.url(),
			});
		});
		page.on("pageerror", (error) => {
			this.pushEvent({ kind: "pageerror", pageId, level: "error", message: error.message, url: page.url() });
		});
		page.on("dialog", (dialog) => {
			this.pushEvent({
				kind: "dialog_dismissed",
				pageId,
				message: `${dialog.type()}: ${dialog.message()}`,
				url: page.url(),
			});
			void dialog.dismiss().catch(() => {});
		});
		page.on("download", (download) => {
			this.pushEvent({
				kind: "download_blocked",
				pageId,
				message: `Blocked download ${download.suggestedFilename()}`,
				url: download.url(),
			});
			void download.cancel().catch(() => {});
		});
		page.on("crash", () => {
			this.pushEvent({ kind: "page_crashed", pageId, message: `Page ${pageId} crashed.`, url: page.url() });
			this.removePage(pageId);
		});
		page.on("close", () => {
			this.pushEvent({ kind: "page_closed", pageId, message: `Page ${pageId} closed.`, url: page.url() });
			this.removePage(pageId);
		});
	}

	private allocatePageId(): string {
		while (this.pages.has(`page-${this.nextPageNumber}`)) this.nextPageNumber++;
		return `page-${this.nextPageNumber++}`;
	}

	private removePage(pageId: string): void {
		this.pages.delete(pageId);
		if (this.activePageId !== pageId) return;
		this.activePageId = [...this.pages.values()].sort((a, b) => a.createdAt - b.createdAt)[0]?.pageId;
	}

	private async getPage(pageId?: string, viewport?: PlaywrightViewport): Promise<{ pageId: string; page: Page }> {
		await this.ensureContext(viewport);
		const selectedId = pageId ?? this.activePageId ?? "main";
		let record = this.pages.get(selectedId);
		if (!record && !pageId) {
			const page = await this.createPage("main", viewport);
			record = this.pages.get(this.pageIds.get(page) ?? "main");
		}
		if (!record || record.page.isClosed()) {
			throw new PlaywrightRuntimeError("page_not_found", `Browser page ${selectedId} does not exist.`);
		}
		this.activePageId = record.pageId;
		if (viewport) await record.page.setViewportSize({ width: viewport.width, height: viewport.height });
		return { pageId: record.pageId, page: record.page };
	}

	private pageIdForRequest(request: Request): string | undefined {
		try {
			return this.pageIds.get(request.frame().page());
		} catch {
			return undefined;
		}
	}

	private pushEvent(event: Omit<PlaywrightEventRecord, "sequence" | "timestamp">): void {
		const record: PlaywrightEventRecord = {
			...event,
			sequence: ++this.eventSequence,
			timestamp: new Date().toISOString(),
			message: clipped(event.message, MAX_EVENT_MESSAGE),
			url: event.url ? clipped(event.url, MAX_URL) : undefined,
		};
		this.events.push(record);
		if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
	}

	private eventCountSince(cursor: number, pageId?: string): number {
		return this.events.filter((event) => event.sequence > cursor && (!pageId || event.pageId === pageId)).length;
	}

	private assertScreenshotBudget(width: number, height: number, label: string, devicePixels = false): void {
		const scale = devicePixels ? 1 : this.contextDeviceScaleFactor;
		const physicalWidth = Math.ceil(width * scale);
		const physicalHeight = Math.ceil(height * scale);
		if (physicalHeight > MAX_FULL_PAGE_HEIGHT || physicalWidth * physicalHeight > MAX_SCREENSHOT_PIXELS) {
			throw new PlaywrightRuntimeError(
				"image_processing",
				`${label} dimensions ${physicalWidth}x${physicalHeight} exceed the ${MAX_FULL_PAGE_HEIGHT}px height or ${MAX_SCREENSHOT_PIXELS} pixel budget.`,
				"Capture a smaller viewport or structured target.",
			);
		}
	}

	private async navigate(
		input: Extract<PlaywrightInput, { action: "navigate" }>,
		startedAt: number,
		signal: AbortSignal,
	): Promise<AgentToolResult<PlaywrightToolDetails>> {
		const config = this.config();
		const policy =
			this.networkPolicy ??
			new PlaywrightNetworkPolicy({ allowPrivateNetwork: config.allowPrivateNetwork, lookup: this.lookup });
		await policy.validate(input.url, "navigation");
		const { pageId, page } = await this.getPage(input.pageId, input.viewport);
		const cursor = this.eventSequence;
		const response = await page.goto(input.url, {
			waitUntil: input.waitUntil ?? "domcontentloaded",
			timeout: input.timeoutMs ?? config.navigationTimeoutMs,
			signal,
		});
		const title = clipped(await page.title(), MAX_TITLE);
		const finalUrl = clipped(page.url(), MAX_URL);
		const status = response?.status();
		const redirects = response ? countRedirects(response.request()) : 0;
		const eventCount = this.eventCountSince(cursor, pageId);
		return this.success(
			"navigate",
			startedAt,
			[
				{
					type: "text",
					text: `${title || "Untitled page"}${status === undefined ? "" : ` · HTTP ${status}`} · ${finalUrl}${eventCount ? ` · ${eventCount} new event${eventCount === 1 ? "" : "s"}` : ""}`,
				},
			],
			{
				pageId,
				url: finalUrl,
				title,
				eventCursor: this.eventSequence,
				navigation: { status, redirects },
			},
		);
	}

	private async snapshot(
		input: Extract<PlaywrightInput, { action: "snapshot" }>,
		startedAt: number,
		signal: AbortSignal,
	): Promise<AgentToolResult<PlaywrightToolDetails>> {
		const config = this.config();
		const { pageId, page } = await this.getPage(input.pageId);
		const timeout = input.timeoutMs ?? config.actionTimeoutMs;
		const snapshot = input.target
			? await (await resolveUniqueLocator(page, input.target, { timeoutMs: timeout, signal })).ariaSnapshot({
					mode: "ai",
					depth: input.depth ?? 12,
					boxes: input.boxes ?? false,
					timeout,
					signal,
				})
			: await page.ariaSnapshot({
					mode: "ai",
					depth: input.depth ?? 12,
					boxes: input.boxes ?? false,
					timeout,
					signal,
				});
		const bounded = await boundPlaywrightText(snapshot, {
			maxCharacters: input.maxCharacters ?? 50 * 1024,
			prefix: `snapshot-${pageId}`,
		});
		const title = clipped(await page.title(), MAX_TITLE);
		const header = `Page: ${pageId}\nURL: ${clipped(page.url(), MAX_URL)}\nTitle: ${title}\nSnapshot boundary: untrusted rendered page content\n\n`;
		return this.success("snapshot", startedAt, [{ type: "text", text: `${header}${bounded.text}` }], {
			...pageDetails(pageId, page),
			title,
			eventCursor: this.eventSequence,
			snapshot: {
				truncated: bounded.truncated,
				outputCharacters: bounded.outputCharacters,
				fullOutputPath: bounded.fullOutputPath,
			},
		});
	}

	private async act(
		input: Extract<PlaywrightInput, { action: "act" }>,
		startedAt: number,
		signal: AbortSignal,
	): Promise<AgentToolResult<PlaywrightToolDetails>> {
		const config = this.config();
		const timeout = input.timeoutMs ?? config.actionTimeoutMs;
		const { pageId, page } = await this.getPage(input.pageId);
		const beforeUrl = page.url();
		const cursor = this.eventSequence;
		if (input.kind === "waitFor") {
			const locator = resolveLocator(page, input.target);
			if (input.state === "attached" || input.state === "visible") {
				await resolveUniqueLocator(page, input.target, { timeoutMs: timeout, signal });
			}
			await locator.waitFor({ state: input.state, timeout, signal });
		} else {
			const locator = await resolveUniqueLocator(page, input.target, { timeoutMs: timeout, signal });
			switch (input.kind) {
				case "click":
					await locator.click({ button: input.button, modifiers: input.modifiers, timeout, signal });
					break;
				case "fill":
					await locator.fill(input.value, { timeout, signal });
					break;
				case "type":
					await locator.pressSequentially(input.value, { timeout, signal });
					break;
				case "press":
					await locator.press(input.key, { timeout, signal });
					break;
				case "select":
					await locator.selectOption(input.values, { timeout, signal });
					break;
				case "check":
					await locator.check({ timeout, signal });
					break;
				case "uncheck":
					await locator.uncheck({ timeout, signal });
					break;
				case "hover":
					await locator.hover({ timeout, signal });
					break;
			}
		}
		const title = clipped(await page.title(), MAX_TITLE);
		const url = clipped(page.url(), MAX_URL);
		const events = this.eventCountSince(cursor, pageId);
		return this.success(
			"act",
			startedAt,
			[
				{
					type: "text",
					text: `${input.kind} ${formatPlaywrightTarget(input.target)} · ${beforeUrl === url ? "URL unchanged" : `URL ${url}`}${events ? ` · ${events} new event${events === 1 ? "" : "s"}` : ""}`,
				},
			],
			{ pageId, url, title, eventCursor: this.eventSequence },
		);
	}

	private async screenshot(
		input: Extract<PlaywrightInput, { action: "screenshot" }>,
		startedAt: number,
		signal: AbortSignal,
	): Promise<AgentToolResult<PlaywrightToolDetails>> {
		const config = this.config();
		const timeout = input.timeoutMs ?? config.actionTimeoutMs;
		const { pageId, page } = await this.getPage(input.pageId, input.viewport);
		if (input.fullPage && input.target) {
			throw new PlaywrightRuntimeError("internal", "A target screenshot cannot also use fullPage=true.");
		}
		if (input.fullPage) {
			const dimensions = await raceWithAbortAndTimeout(
				page.evaluate<{ width: number; height: number }>(
					"({ width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0), height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0) })",
				),
				{ signal, timeoutMs: timeout },
			);
			this.assertScreenshotBudget(dimensions.width, dimensions.height, "Full-page screenshot");
		}
		let bytes: Buffer;
		if (input.target) {
			const locator = await resolveUniqueLocator(page, input.target, { timeoutMs: timeout, signal });
			const box = await locator.boundingBox();
			if (!box) throw new PlaywrightLocatorError("locator_not_found", "The screenshot target is not visible.");
			this.assertScreenshotBudget(box.width, box.height, "Screenshot target");
			bytes = await locator.screenshot({ type: "png", animations: "disabled", timeout, signal });
		} else {
			if (!input.fullPage) {
				const size = page.viewportSize();
				if (size) this.assertScreenshotBudget(size.width, size.height, "Viewport screenshot");
			}
			bytes = await page.screenshot({
				type: "png",
				fullPage: input.fullPage ?? false,
				animations: "disabled",
				timeout,
				signal,
			});
		}
		const dimensions = parsePngDimensions(bytes);
		if (!dimensions)
			throw new PlaywrightRuntimeError("image_processing", "The captured PNG dimensions were invalid.");
		this.assertScreenshotBudget(dimensions.width, dimensions.height, "Captured screenshot", true);
		let savedPath: string | undefined;
		if (input.savePath) {
			savedPath = resolveToCwd(input.savePath, this.cwd);
			await withFileMutationQueue(savedPath, async () => {
				if (signal.aborted) throw new PlaywrightRuntimeError("cancelled", "Screenshot save was cancelled.");
				await mkdir(dirname(savedPath!), { recursive: true });
				await writeFile(savedPath!, bytes);
			});
		}
		const processed = await processImage(bytes, "image/png", { autoResizeImages: this.getAutoResizeImages() });
		if (!processed.ok) throw new PlaywrightRuntimeError("image_processing", processed.message);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const title = clipped(await page.title(), MAX_TITLE);
		const url = clipped(page.url(), MAX_URL);
		const saveNote = savedPath ? ` · saved ${formatPathRelativeToCwdOrAbsolute(savedPath, this.cwd)}` : "";
		return this.success(
			"screenshot",
			startedAt,
			[
				{
					type: "text",
					text: `Screenshot captured: page=${pageId}, ${dimensions.width}x${dimensions.height}, url=${url}${saveNote}${processed.hints.length ? `\n${processed.hints.join("\n")}` : ""}`,
				},
				{ type: "image", data: processed.data, mimeType: processed.mimeType },
			],
			{
				pageId,
				url,
				title,
				eventCursor: this.eventSequence,
				screenshot: {
					mimeType: "image/png",
					width: dimensions.width,
					height: dimensions.height,
					sha256,
					fullPage: input.fullPage ?? false,
					savedPath,
				},
			},
		);
	}

	private async evaluate(
		input: Extract<PlaywrightInput, { action: "evaluate" }>,
		startedAt: number,
		signal: AbortSignal,
	): Promise<AgentToolResult<PlaywrightToolDetails>> {
		if (input.argument !== undefined && !isJsonValue(input.argument)) {
			throw new PlaywrightSerializationError("evaluate.argument must be a JSON value.");
		}
		const config = this.config();
		const timeout = input.timeoutMs ?? config.actionTimeoutMs;
		const { pageId, page } = await this.getPage(input.pageId);
		let value: unknown;
		try {
			value = await raceWithAbortAndTimeout(page.evaluate(input.expression, input.argument), {
				signal,
				timeoutMs: timeout,
			});
		} catch (error) {
			if (error instanceof PlaywrightRuntimeError && (error.code === "timeout" || error.code === "cancelled")) {
				await page.close().catch(() => {});
			}
			throw error;
		}
		const serialized = serializePlaywrightEvaluation(value);
		const bounded = await boundPlaywrightText(serialized, {
			maxCharacters: input.maxCharacters ?? 50 * 1024,
			prefix: `evaluate-${pageId}`,
		});
		const title = clipped(await page.title(), MAX_TITLE);
		return this.success("evaluate", startedAt, [{ type: "text", text: bounded.text }], {
			...pageDetails(pageId, page),
			title,
			eventCursor: this.eventSequence,
			evaluation: {
				truncated: bounded.truncated,
				outputCharacters: bounded.outputCharacters,
				fullOutputPath: bounded.fullOutputPath,
			},
		});
	}

	private async readEvents(
		input: Extract<PlaywrightInput, { action: "events" }>,
		startedAt: number,
	): Promise<AgentToolResult<PlaywrightToolDetails>> {
		if (input.pageId && !this.pages.has(input.pageId)) {
			throw new PlaywrightRuntimeError("page_not_found", `Browser page ${input.pageId} does not exist.`);
		}
		const cursor = input.cursor ?? 0;
		const levels = new Set(input.levels ?? ["warning", "error"]);
		const matching = this.events.filter(
			(event) =>
				event.sequence > cursor &&
				(!input.pageId || event.pageId === input.pageId) &&
				(event.kind !== "console" || (event.level !== undefined && levels.has(event.level))),
		);
		const limit = input.limit ?? 100;
		const selected = matching.slice(-limit);
		const text = selected.length
			? selected
					.map(
						(event) =>
							`${event.sequence} ${event.kind}${event.level ? `/${event.level}` : ""}${event.pageId ? ` [${event.pageId}]` : ""}: ${event.message}${event.url ? ` · ${event.url}` : ""}`,
					)
					.join("\n")
			: "No new Playwright events.";
		return this.success("events", startedAt, [{ type: "text", text }], {
			pageId: input.pageId,
			eventCursor: this.eventSequence,
			events: {
				count: selected.length,
				nextCursor: this.eventSequence,
				truncated: matching.length > selected.length,
			},
		});
	}

	private async managePages(
		input: Extract<PlaywrightInput, { action: "pages" }>,
		startedAt: number,
		signal: AbortSignal,
	): Promise<AgentToolResult<PlaywrightToolDetails>> {
		if (input.operation === "reset") {
			await this.closeResources(false);
			this.pages.clear();
			this.activePageId = undefined;
			this.events = [];
			this.eventSequence = 0;
			await this.ensureContext();
		} else if (input.operation === "new") {
			await this.ensureContext(input.viewport);
			await this.createPage(this.allocatePageId(), input.viewport);
		} else if (input.operation === "close") {
			const { pageId, page } = await this.getPage(input.pageId);
			await page.close({ runBeforeUnload: false });
			if (this.pages.size === 0) await this.createPage("main");
			this.activePageId ??= pageId === "main" ? "main" : [...this.pages.keys()][0];
		} else {
			await this.ensureContext();
		}
		if (signal.aborted) throw new PlaywrightRuntimeError("cancelled", "The pages operation was cancelled.");
		const pages = await this.pageSummaries();
		const text = pages
			.map((page) => `${page.active ? "*" : " "} ${page.pageId} · ${page.title || "Untitled"} · ${page.url}`)
			.join("\n");
		return this.success("pages", startedAt, [{ type: "text", text: text || "No browser pages." }], {
			pageId: this.activePageId,
			eventCursor: this.eventSequence,
			pages,
		});
	}

	private async pageSummaries(): Promise<PlaywrightPageSummary[]> {
		const summaries: PlaywrightPageSummary[] = [];
		for (const record of [...this.pages.values()].sort((a, b) => a.createdAt - b.createdAt)) {
			let title: string | undefined;
			if (!record.page.isClosed()) title = clipped(await record.page.title().catch(() => ""), MAX_TITLE);
			summaries.push({
				pageId: record.pageId,
				active: record.pageId === this.activePageId,
				url: clipped(record.page.url(), MAX_URL),
				title,
				closed: record.page.isClosed(),
			});
		}
		return summaries;
	}

	private async closeResources(closeBrowser: boolean): Promise<void> {
		const context = this.context;
		this.context = undefined;
		if (context) await context.close().catch(() => {});
		this.pages.clear();
		this.activePageId = undefined;
		if (closeBrowser) {
			const browser = this.browser;
			this.browser = undefined;
			if (browser) await browser.close().catch(() => {});
		}
	}

	private clearSessionState(): void {
		this.pages.clear();
		this.activePageId = undefined;
		this.nextPageNumber = 2;
		this.requestedPageId = undefined;
		this.events = [];
		this.eventSequence = 0;
		this.networkPolicy = undefined;
		this.contextDeviceScaleFactor = 1;
	}
}
