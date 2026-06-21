import {
	type RgbColor,
	resetCapabilitiesCache,
	setCapabilities,
	type TerminalColorScheme,
	type TUI,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	DEFAULT_AUTOMATIC_THEME_SETTING,
	detectTerminalBackgroundFromEnv,
	detectTerminalBackgroundTheme,
	getCurrentThemeName,
	getEffectiveAutoThemeSetting,
	getThemeByName,
	getThemeForRgbColor,
	parseAutoThemeSetting,
	resolveThemeSetting,
	stopThemeWatcher,
} from "../src/modes/interactive/theme/theme.ts";
import { InteractiveThemeController } from "../src/modes/interactive/theme/theme-controller.ts";

afterEach(() => {
	resetCapabilitiesCache();
	stopThemeWatcher();
});

class ThemeControllerTestUi {
	private readonly colorSchemeListeners = new Set<(scheme: TerminalColorScheme) => void>();
	readonly notificationStates: boolean[] = [];
	invalidateCount = 0;
	renderCount = 0;
	colorScheme: TerminalColorScheme;

	constructor(colorScheme: TerminalColorScheme) {
		this.colorScheme = colorScheme;
	}

	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void {
		this.colorSchemeListeners.add(listener);
		return () => this.colorSchemeListeners.delete(listener);
	}

	setTerminalColorSchemeNotifications(enabled: boolean): void {
		this.notificationStates.push(enabled);
	}

	async queryTerminalColorScheme(): Promise<TerminalColorScheme | undefined> {
		return this.colorScheme;
	}

	async queryTerminalBackgroundColor(): Promise<RgbColor | undefined> {
		return undefined;
	}

	invalidate(): void {
		this.invalidateCount += 1;
	}

	requestRender(): void {
		this.renderCount += 1;
	}

	emitColorScheme(scheme: TerminalColorScheme): void {
		for (const listener of this.colorSchemeListeners) {
			listener(scheme);
		}
	}

	asTui(): TUI {
		return this as unknown as TUI;
	}
}

describe("detectTerminalBackgroundFromEnv", () => {
	it("uses the COLORFGBG background color index", () => {
		expect(detectTerminalBackgroundFromEnv({ env: { COLORFGBG: "0;15" } })).toMatchObject({
			theme: "light",
			source: "COLORFGBG",
			confidence: "high",
		});
		expect(detectTerminalBackgroundFromEnv({ env: { COLORFGBG: "15;0" } })).toMatchObject({
			theme: "dark",
			source: "COLORFGBG",
			confidence: "high",
		});
	});

	it("uses the last COLORFGBG field as the background", () => {
		expect(detectTerminalBackgroundFromEnv({ env: { COLORFGBG: "0;7;15" } }).theme).toBe("light");
	});

	it("defaults to dark without terminal background hints", () => {
		expect(detectTerminalBackgroundFromEnv({ env: {} })).toMatchObject({
			theme: "dark",
			source: "fallback",
			confidence: "low",
		});
	});
});

describe("detectTerminalBackgroundTheme", () => {
	it("uses the queried terminal background before environment hints", async () => {
		let queriedTimeoutMs: number | undefined;
		const detection = await detectTerminalBackgroundTheme({
			env: { COLORFGBG: "15;0" },
			timeoutMs: 250,
			ui: {
				async queryTerminalBackgroundColor({ timeoutMs }: { timeoutMs: number }): Promise<RgbColor | undefined> {
					queriedTimeoutMs = timeoutMs;
					return { r: 250, g: 250, b: 250 };
				},
			},
		});

		expect(queriedTimeoutMs).toBe(250);
		expect(detection).toMatchObject({
			theme: "light",
			source: "terminal background",
			confidence: "high",
		});
	});

	it("falls back to environment hints when the terminal query returns no color", async () => {
		const detection = await detectTerminalBackgroundTheme({
			env: { COLORFGBG: "15;0" },
			timeoutMs: 250,
			ui: {
				async queryTerminalBackgroundColor(): Promise<RgbColor | undefined> {
					return undefined;
				},
			},
		});

		expect(detection).toMatchObject({
			theme: "dark",
			source: "COLORFGBG",
			confidence: "high",
		});
	});

	it("falls back to environment hints when the terminal query fails", async () => {
		const detection = await detectTerminalBackgroundTheme({
			env: { COLORFGBG: "0;15" },
			timeoutMs: 250,
			ui: {
				async queryTerminalBackgroundColor(): Promise<RgbColor | undefined> {
					throw new Error("terminal write failed");
				},
			},
		});

		expect(detection).toMatchObject({
			theme: "light",
			source: "COLORFGBG",
			confidence: "high",
		});
	});
});

describe("theme color mode", () => {
	it("uses terminal capabilities", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const ansi256Theme = getThemeByName("dark");
		if (!ansi256Theme) throw new Error("dark theme not found");
		expect(ansi256Theme.getColorMode()).toBe("256color");
		expect(ansi256Theme.getFgAnsi("accent")).toMatch(/^\x1b\[38;5;\d+m$/);

		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const truecolorTheme = getThemeByName("dark");
		if (!truecolorTheme) throw new Error("dark theme not found");
		expect(truecolorTheme.getColorMode()).toBe("truecolor");
		expect(truecolorTheme.getFgAnsi("accent")).toMatch(/^\x1b\[38;2;\d+;\d+;\d+m$/);
	});
});

describe("theme detection from RGB", () => {
	it("classifies RGB colors by luminance", () => {
		expect(getThemeForRgbColor({ r: 8, g: 8, b: 8 })).toBe("dark");
		expect(getThemeForRgbColor({ r: 250, g: 250, b: 250 })).toBe("light");
	});
});

describe("theme setting helpers", () => {
	it("parses and resolves automatic theme settings", () => {
		expect(DEFAULT_AUTOMATIC_THEME_SETTING).toBe("light/dark");
		expect(parseAutoThemeSetting("light/dark")).toEqual({ lightTheme: "light", darkTheme: "dark" });
		expect(getEffectiveAutoThemeSetting(undefined)).toEqual({ lightTheme: "light", darkTheme: "dark" });
		expect(resolveThemeSetting("dark", "light")).toBe("dark");
		expect(resolveThemeSetting("light/dark", "light")).toBe("light");
		expect(resolveThemeSetting("light/dark", "dark")).toBe("dark");
		expect(resolveThemeSetting("light/dark/extra", "dark")).toBeUndefined();
	});
});

describe("InteractiveThemeController", () => {
	it("uses automatic light/dark sync when the theme setting is unset", async () => {
		const ui = new ThemeControllerTestUi("dark");
		const settingsManager = SettingsManager.inMemory({});
		const errors: string[] = [];
		const controller = new InteractiveThemeController(
			ui.asTui(),
			settingsManager,
			(message) => errors.push(message),
			() => undefined,
		);

		await controller.applyFromSettings();

		expect(ui.notificationStates).toEqual([true]);
		expect(settingsManager.getThemeSetting()).toBeUndefined();
		expect(getCurrentThemeName()).toBe("dark");

		ui.emitColorScheme("light");

		expect(controller.getTerminalTheme()).toBe("light");
		expect(getCurrentThemeName()).toBe("light");
		expect(settingsManager.getThemeSetting()).toBeUndefined();
		expect(errors).toEqual([]);
	});
});
