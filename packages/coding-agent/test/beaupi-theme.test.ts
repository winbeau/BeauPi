import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { type BeauPiToolState, toolStateSymbol } from "../src/modes/interactive/components/beaupi-style.ts";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getResolvedThemeColors,
	getThemeByName,
	isLightTheme,
	loadThemeFromPath,
	onThemeChange,
	setRegisteredThemes,
	setTheme,
	stopThemeWatcher,
	Theme,
	type ThemeColor,
	theme,
} from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type ThemeFile = {
	name: string;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
};

const BEAUPI_THEMES = ["beaupi-dark", "beaupi-light"] as const;
const CRITICAL_STATES = [
	"queued",
	"running",
	"success",
	"warning",
	"error",
	"cancelled",
	"permission-waiting",
] as const satisfies readonly BeauPiToolState[];

describe("BeauPi built-in themes", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "beaupi-theme-"));
		const agentDir = join(tempRoot, "agent");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		mkdirSync(join(agentDir, "themes"), { recursive: true });
		setRegisteredThemes([]);
	});

	afterEach(() => {
		stopThemeWatcher();
		onThemeChange(() => {});
		setRegisteredThemes([]);
		setTheme("dark", false);
		resetCapabilitiesCache();
		vi.unstubAllEnvs();
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("discovers BeauPi themes alongside the original built-ins", () => {
		const names = getAvailableThemes();
		expect(names).toEqual(expect.arrayContaining(["dark", "light", ...BEAUPI_THEMES]));
		for (const name of BEAUPI_THEMES) {
			expect(getAvailableThemesWithPaths()).toContainEqual({
				name,
				path: expect.stringContaining(`${name}.json`),
			});
		}
	});

	it("loads and explicitly selects both BeauPi themes without changing dark or light", () => {
		for (const name of ["dark", "light", ...BEAUPI_THEMES]) {
			const loaded = getThemeByName(name);
			expect(loaded?.name).toBe(name);
			expect(setTheme(name, false)).toEqual({ success: true });
			expect(theme.name).toBe(name);
		}
	});

	it("classifies BeauPi light export colors as light and resolves all diff backgrounds", () => {
		expect(isLightTheme("beaupi-light")).toBe(true);
		expect(isLightTheme("beaupi-dark")).toBe(false);
		for (const name of BEAUPI_THEMES) {
			const colors = getResolvedThemeColors(name);
			expect(colors.toolDiffAddedBg).toMatch(/^#[0-9a-f]{6}$/i);
			expect(colors.toolDiffRemovedBg).toMatch(/^#[0-9a-f]{6}$/i);
			expect(colors.toolDiffAddedEmphasisBg).toMatch(/^#[0-9a-f]{6}$/i);
			expect(colors.toolDiffRemovedEmphasisBg).toMatch(/^#[0-9a-f]{6}$/i);
		}
	});

	it("uses truecolor when available", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		for (const name of BEAUPI_THEMES) {
			const loaded = getThemeByName(name);
			if (!loaded) throw new Error(`Theme not found: ${name}`);
			expect(loaded.getColorMode()).toBe("truecolor");
			expect(loaded.getFgAnsi("accent")).toMatch(/^\x1b\[38;2;\d+;\d+;\d+m$/);
			expect(loaded.getBgAnsi("toolDiffAddedBg")).toMatch(/^\x1b\[48;2;\d+;\d+;\d+m$/);
		}
	});

	it("keeps critical states and structured diff backgrounds distinct in 256-color mode", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		for (const name of BEAUPI_THEMES) {
			const loaded = getThemeByName(name);
			if (!loaded) throw new Error(`Theme not found: ${name}`);
			expect(loaded.getColorMode()).toBe("256color");
			expect(
				new Set([
					loaded.getFgAnsi("accent"),
					loaded.getFgAnsi("success"),
					loaded.getFgAnsi("warning"),
					loaded.getFgAnsi("error"),
					loaded.getFgAnsi("muted"),
				]).size,
			).toBe(5);
			expect(
				new Set([
					loaded.getBgAnsi("toolDiffAddedBg"),
					loaded.getBgAnsi("toolDiffRemovedBg"),
					loaded.getBgAnsi("toolDiffAddedEmphasisBg"),
					loaded.getBgAnsi("toolDiffRemovedEmphasisBg"),
				]).size,
			).toBe(4);
			const styledStates = CRITICAL_STATES.map((state) => toolStateSymbol(state, loaded));
			expect(new Set(styledStates).size).toBe(CRITICAL_STATES.length);
			expect(stripAnsi(toolStateSymbol("success", loaded))).toBe("●");
			expect(stripAnsi(toolStateSymbol("error", loaded))).toBe("●");
		}
	});

	it("keeps the in-memory extension Theme constructor compatible", () => {
		const foregrounds = new Proxy({} as Record<ThemeColor, string | number>, {
			get: () => "",
		});
		const extensionTheme = new Theme(
			foregrounds,
			{
				selectedBg: "#222222",
				userMessageBg: "#222222",
				customMessageBg: "#222222",
				toolPendingBg: "#222222",
				toolSuccessBg: "#113311",
				toolErrorBg: "#331111",
			},
			"truecolor",
		);

		expect(extensionTheme.getBgAnsi("toolDiffAddedBg")).toBe(extensionTheme.getBgAnsi("toolSuccessBg"));
		expect(extensionTheme.getBgAnsi("toolDiffRemovedBg")).toBe(extensionTheme.getBgAnsi("toolErrorBg"));
	});

	it("loads legacy third-party themes without structured diff background tokens", () => {
		const legacyTheme = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
		) as ThemeFile;
		legacyTheme.name = "legacy-third-party";
		delete legacyTheme.colors.toolDiffAddedBg;
		delete legacyTheme.colors.toolDiffRemovedBg;
		delete legacyTheme.colors.toolDiffAddedEmphasisBg;
		delete legacyTheme.colors.toolDiffRemovedEmphasisBg;
		const themePath = join(tempRoot, "legacy-third-party.json");
		writeFileSync(themePath, JSON.stringify(legacyTheme));

		const loaded = loadThemeFromPath(themePath, "truecolor");
		expect(loaded.getBgAnsi("toolDiffAddedBg")).toBe(loaded.getBgAnsi("toolSuccessBg"));
		expect(loaded.getBgAnsi("toolDiffRemovedBg")).toBe(loaded.getBgAnsi("toolErrorBg"));
		expect(loaded.getBgAnsi("toolDiffAddedEmphasisBg")).toBe(loaded.getBgAnsi("toolDiffAddedBg"));
		expect(loaded.getBgAnsi("toolDiffRemovedEmphasisBg")).toBe(loaded.getBgAnsi("toolDiffRemovedBg"));
	});

	it("hot reloads a custom theme and triggers invalidation callbacks", async () => {
		const customTheme = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
		) as ThemeFile;
		customTheme.name = "hot-reload-theme";
		const themePath = join(process.env[ENV_AGENT_DIR]!, "themes", "hot-reload-theme.json");
		writeFileSync(themePath, JSON.stringify(customTheme));
		const changed = vi.fn();
		onThemeChange(changed);
		expect(setTheme("hot-reload-theme", true)).toEqual({ success: true });
		const previousAccent = theme.getFgAnsi("accent");

		customTheme.vars = { ...customTheme.vars, accent: "#ff5f87" };
		writeFileSync(themePath, JSON.stringify(customTheme));

		await vi.waitFor(() => {
			expect(theme.getFgAnsi("accent")).not.toBe(previousAccent);
			expect(changed).toHaveBeenCalled();
		});
	});
});
