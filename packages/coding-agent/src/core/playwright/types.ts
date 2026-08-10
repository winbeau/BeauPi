import type { Browser, BrowserContext, Locator, Page } from "playwright";

export const PLAYWRIGHT_RUNTIME_DETAILS_KEY = "playwrightRuntime";
export const PLAYWRIGHT_RUNTIME_DETAILS_VERSION = 1;

export type PlaywrightAction = "navigate" | "snapshot" | "act" | "screenshot" | "evaluate" | "events" | "pages";

export type PlaywrightDiagnosticCode =
	| "browser_unavailable"
	| "browser_launch"
	| "invalid_url"
	| "blocked_target"
	| "page_not_found"
	| "locator_not_found"
	| "locator_ambiguous"
	| "navigation"
	| "timeout"
	| "serialization"
	| "image_processing"
	| "cancelled"
	| "browser_disconnected"
	| "internal";

export interface PlaywrightDiagnostic {
	code: PlaywrightDiagnosticCode;
	message: string;
	suggestion?: string;
}

export interface PlaywrightViewport {
	width: number;
	height: number;
	deviceScaleFactor?: number;
}

export type PlaywrightTarget =
	| { by: "role"; role: string; name?: string; exact?: boolean; nth?: number }
	| { by: "text" | "label" | "placeholder" | "testId"; value: string; exact?: boolean; nth?: number }
	| { by: "css"; value: string; nth?: number };

export interface PlaywrightNavigateInput {
	action: "navigate";
	url: string;
	pageId?: string;
	waitUntil?: "commit" | "domcontentloaded" | "load";
	timeoutMs?: number;
	viewport?: PlaywrightViewport;
}

export interface PlaywrightSnapshotInput {
	action: "snapshot";
	pageId?: string;
	target?: PlaywrightTarget;
	depth?: number;
	boxes?: boolean;
	maxCharacters?: number;
	timeoutMs?: number;
}

export type PlaywrightActInput =
	| {
			action: "act";
			kind: "click";
			target: PlaywrightTarget;
			pageId?: string;
			button?: "left" | "right" | "middle";
			modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
			timeoutMs?: number;
	  }
	| {
			action: "act";
			kind: "fill" | "type";
			target: PlaywrightTarget;
			value: string;
			pageId?: string;
			timeoutMs?: number;
	  }
	| {
			action: "act";
			kind: "press";
			target: PlaywrightTarget;
			key: string;
			pageId?: string;
			timeoutMs?: number;
	  }
	| {
			action: "act";
			kind: "select";
			target: PlaywrightTarget;
			values: string[];
			pageId?: string;
			timeoutMs?: number;
	  }
	| {
			action: "act";
			kind: "check" | "uncheck" | "hover";
			target: PlaywrightTarget;
			pageId?: string;
			timeoutMs?: number;
	  }
	| {
			action: "act";
			kind: "waitFor";
			target: PlaywrightTarget;
			state: "attached" | "detached" | "visible" | "hidden";
			pageId?: string;
			timeoutMs?: number;
	  };

export type PlaywrightScreenshotInput =
	| {
			action: "screenshot";
			pageId?: string;
			target: PlaywrightTarget;
			fullPage?: never;
			viewport?: PlaywrightViewport;
			savePath?: string;
			timeoutMs?: number;
	  }
	| {
			action: "screenshot";
			pageId?: string;
			target?: never;
			fullPage?: boolean;
			viewport?: PlaywrightViewport;
			savePath?: string;
			timeoutMs?: number;
	  };

export interface PlaywrightEvaluateInput {
	action: "evaluate";
	pageId?: string;
	expression: string;
	argument?: unknown;
	maxCharacters?: number;
	timeoutMs?: number;
}

export type PlaywrightConsoleLevel = "debug" | "info" | "log" | "warning" | "error";

export interface PlaywrightEventsInput {
	action: "events";
	pageId?: string;
	cursor?: number;
	levels?: PlaywrightConsoleLevel[];
	limit?: number;
}

export type PlaywrightPagesInput =
	| { action: "pages"; operation: "list" }
	| { action: "pages"; operation: "new"; viewport?: PlaywrightViewport }
	| { action: "pages"; operation: "close"; pageId?: string }
	| { action: "pages"; operation: "reset" };

export type PlaywrightInput =
	| PlaywrightNavigateInput
	| PlaywrightSnapshotInput
	| PlaywrightActInput
	| PlaywrightScreenshotInput
	| PlaywrightEvaluateInput
	| PlaywrightEventsInput
	| PlaywrightPagesInput;

export type PlaywrightEventKind =
	| "console"
	| "pageerror"
	| "requestfailed"
	| "dialog_dismissed"
	| "download_blocked"
	| "popup"
	| "page_closed"
	| "page_crashed"
	| "browser_disconnected"
	| "request_blocked";

export interface PlaywrightEventRecord {
	sequence: number;
	timestamp: string;
	pageId?: string;
	kind: PlaywrightEventKind;
	message: string;
	url?: string;
	level?: PlaywrightConsoleLevel;
}

export interface PlaywrightPageSummary {
	pageId: string;
	active: boolean;
	url: string;
	title?: string;
	closed: boolean;
}

export interface PlaywrightRuntimeToolDetailsV1 {
	version: typeof PLAYWRIGHT_RUNTIME_DETAILS_VERSION;
	operation: PlaywrightAction;
	ok: boolean;
	pageId?: string;
	url?: string;
	title?: string;
	durationMs: number;
	eventCursor?: number;
	navigation?: {
		status?: number;
		redirects: number;
	};
	snapshot?: {
		truncated: boolean;
		outputCharacters: number;
		fullOutputPath?: string;
	};
	evaluation?: {
		truncated: boolean;
		outputCharacters: number;
		fullOutputPath?: string;
	};
	events?: {
		count: number;
		nextCursor: number;
		truncated: boolean;
	};
	pages?: PlaywrightPageSummary[];
	screenshot?: {
		mimeType: "image/png";
		width: number;
		height: number;
		sha256: string;
		fullPage: boolean;
		savedPath?: string;
	};
	diagnostic?: PlaywrightDiagnostic;
}

export interface PlaywrightToolDetails extends Record<string, unknown> {
	playwrightRuntime: PlaywrightRuntimeToolDetailsV1;
}

export interface PlaywrightSettings {
	executablePath?: string;
	channel?: "chrome" | "msedge";
	headless?: boolean;
	actionTimeoutMs?: number;
	navigationTimeoutMs?: number;
	allowPrivateNetwork?: boolean;
}

export interface ResolvedPlaywrightConfig {
	executablePath?: string;
	channel?: "chrome" | "msedge";
	headless: boolean;
	actionTimeoutMs: number;
	navigationTimeoutMs: number;
	allowPrivateNetwork: boolean;
}

export interface PlaywrightLaunchResult {
	browser: Browser;
	source: "executable" | "managed" | "chrome" | "msedge";
}

export interface PlaywrightAdapter {
	launch(config: ResolvedPlaywrightConfig): Promise<PlaywrightLaunchResult>;
}

export interface PlaywrightPageRecord {
	pageId: string;
	page: Page;
	createdAt: number;
}

export interface PlaywrightContextState {
	browser: Browser;
	context: BrowserContext;
}

export type PlaywrightLocator = Locator;
