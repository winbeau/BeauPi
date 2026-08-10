import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { BrowserType } from "playwright";
import { resolvePath } from "../../utils/paths.ts";
import type {
	PlaywrightAdapter,
	PlaywrightDiagnosticCode,
	PlaywrightLaunchResult,
	ResolvedPlaywrightConfig,
} from "./types.ts";

interface PlaywrightLibrary {
	chromium: BrowserType;
}

export class PlaywrightAdapterError extends Error {
	readonly code: PlaywrightDiagnosticCode;
	readonly suggestion?: string;

	constructor(code: PlaywrightDiagnosticCode, message: string, suggestion?: string) {
		super(message);
		this.name = "PlaywrightAdapterError";
		this.code = code;
		this.suggestion = suggestion;
	}
}

const moduleRequire = createRequire(import.meta.url);
const executableRequire = createRequire(join(dirname(process.execPath), "package.json"));
let cachedLibrary: PlaywrightLibrary | undefined;

export function loadPlaywrightLibrary(): PlaywrightLibrary {
	if (cachedLibrary) return cachedLibrary;
	const errors: string[] = [];
	for (const requirePlaywright of [moduleRequire, executableRequire]) {
		try {
			cachedLibrary = requirePlaywright("playwright") as PlaywrightLibrary;
			return cachedLibrary;
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	throw new PlaywrightAdapterError(
		"browser_unavailable",
		`The Playwright library could not be loaded: ${[...new Set(errors)].join(" | ")}`,
		"Reinstall BeauPi dependencies with lifecycle scripts disabled, then provide an installed Chromium or Chrome executable.",
	);
}

function messageFor(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class DefaultPlaywrightAdapter implements PlaywrightAdapter {
	private readonly cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	async launch(config: ResolvedPlaywrightConfig): Promise<PlaywrightLaunchResult> {
		const { chromium } = loadPlaywrightLibrary();
		const common = { headless: config.headless } as const;
		if (config.executablePath) {
			const executablePath = resolvePath(config.executablePath, this.cwd);
			if (!existsSync(executablePath)) {
				throw new PlaywrightAdapterError(
					"browser_unavailable",
					`Configured browser executable does not exist: ${executablePath}`,
					"Set playwright.executablePath to an installed Chromium/Chrome executable or remove it to use browser discovery.",
				);
			}
			try {
				return {
					browser: await chromium.launch({ ...common, executablePath }),
					source: "executable",
				};
			} catch (error) {
				throw new PlaywrightAdapterError(
					"browser_launch",
					`Failed to launch ${executablePath}: ${messageFor(error)}`,
				);
			}
		}

		if (config.channel) {
			try {
				return {
					browser: await chromium.launch({ ...common, channel: config.channel }),
					source: config.channel,
				};
			} catch (error) {
				throw new PlaywrightAdapterError(
					"browser_unavailable",
					`Configured browser channel ${config.channel} is unavailable: ${messageFor(error)}`,
					`Install ${config.channel === "chrome" ? "Google Chrome" : "Microsoft Edge"} or configure playwright.executablePath.`,
				);
			}
		}

		const errors: string[] = [];
		const managedExecutable = chromium.executablePath();
		if (managedExecutable && existsSync(managedExecutable)) {
			try {
				return {
					browser: await chromium.launch({ ...common, executablePath: managedExecutable }),
					source: "managed",
				};
			} catch (error) {
				errors.push(`managed: ${messageFor(error)}`);
			}
		}

		for (const channel of ["chrome", "msedge"] as const) {
			try {
				return { browser: await chromium.launch({ ...common, channel }), source: channel };
			} catch (error) {
				errors.push(`${channel}: ${messageFor(error)}`);
			}
		}
		throw new PlaywrightAdapterError(
			"browser_unavailable",
			`No usable Chromium browser was found. ${errors.join(" | ")}`,
			"Install Google Chrome or run `npx playwright install chromium` explicitly, then retry once.",
		);
	}
}
