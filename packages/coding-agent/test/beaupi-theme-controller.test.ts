import type { RgbColor, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { setTheme, stopThemeWatcher, type TerminalTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { InteractiveThemeController } from "../src/modes/interactive/theme/theme-controller.ts";

interface FakeThemeUi {
	readonly ui: TUI;
	readonly invalidate: ReturnType<typeof vi.fn>;
	readonly requestRender: ReturnType<typeof vi.fn>;
	readonly setNotifications: ReturnType<typeof vi.fn>;
	getColorSchemeListener(): ((theme: TerminalTheme) => void) | undefined;
}

function createThemeUi(initialTheme: TerminalTheme): FakeThemeUi {
	let colorSchemeListener: ((theme: TerminalTheme) => void) | undefined;
	const invalidate = vi.fn();
	const requestRender = vi.fn();
	const setNotifications = vi.fn();
	const ui = {
		invalidate,
		requestRender,
		setTerminalColorSchemeNotifications: setNotifications,
		onTerminalColorSchemeChange(listener: (theme: TerminalTheme) => void) {
			colorSchemeListener = listener;
			return () => {
				colorSchemeListener = undefined;
			};
		},
		async queryTerminalColorScheme(): Promise<TerminalTheme> {
			return initialTheme;
		},
		async queryTerminalBackgroundColor(): Promise<RgbColor | undefined> {
			return initialTheme === "light" ? { r: 250, g: 250, b: 250 } : { r: 8, g: 8, b: 8 };
		},
	} as unknown as TUI;
	return {
		ui,
		invalidate,
		requestRender,
		setNotifications,
		getColorSchemeListener: () => colorSchemeListener,
	};
}

describe("InteractiveThemeController with BeauPi themes", () => {
	afterEach(() => {
		stopThemeWatcher();
		setTheme("dark", false);
	});

	it("switches explicitly between BeauPi dark and light themes", () => {
		const fakeUi = createThemeUi("dark");
		const changed = vi.fn();
		const showError = vi.fn();
		const controller = new InteractiveThemeController(
			fakeUi.ui,
			SettingsManager.inMemory({ theme: "dark" }),
			showError,
			changed,
		);

		expect(controller.setThemeName("beaupi-dark")).toEqual({ success: true });
		expect(theme.name).toBe("beaupi-dark");
		expect(controller.setThemeName("beaupi-light")).toEqual({ success: true });
		expect(theme.name).toBe("beaupi-light");
		expect(fakeUi.invalidate).toHaveBeenCalledTimes(2);
		expect(changed).toHaveBeenCalledTimes(2);
		expect(showError).not.toHaveBeenCalled();
	});

	it("follows automatic terminal light and dark notifications", async () => {
		const fakeUi = createThemeUi("dark");
		const changed = vi.fn();
		const controller = new InteractiveThemeController(
			fakeUi.ui,
			SettingsManager.inMemory({ theme: "beaupi-light/beaupi-dark" }),
			vi.fn(),
			changed,
		);

		await controller.applyFromSettings();
		expect(theme.name).toBe("beaupi-dark");
		expect(fakeUi.setNotifications).toHaveBeenCalledWith(true);

		fakeUi.getColorSchemeListener()?.("light");
		expect(theme.name).toBe("beaupi-light");
		expect(changed).toHaveBeenCalledTimes(2);
	});

	it("previews BeauPi themes through the existing hot invalidation path", () => {
		const fakeUi = createThemeUi("dark");
		const controller = new InteractiveThemeController(
			fakeUi.ui,
			SettingsManager.inMemory({ theme: "dark" }),
			vi.fn(),
			vi.fn(),
		);

		controller.preview("beaupi-dark");
		expect(theme.name).toBe("beaupi-dark");
		expect(fakeUi.invalidate).toHaveBeenCalled();
		expect(fakeUi.requestRender).toHaveBeenCalled();
	});
});
