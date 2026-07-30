import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { QuestionAnswer, QuestionInteractionRequest } from "../src/core/question.ts";
import { QuestionSelectorComponent } from "../src/modes/interactive/components/question-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function fakeTui(rows = 32): TUI {
	return {
		terminal: { rows },
		requestRender: vi.fn(),
		stop: vi.fn(),
		start: vi.fn(),
	} as unknown as TUI;
}

function request(multiSelect = false): QuestionInteractionRequest {
	return {
		requestId: "question-request",
		questions: [
			{
				question: "Which UI library should we use for the 终端界面 🧭?",
				header: "Library",
				options: [
					{
						label: "React with a very long descriptive label for narrow terminal wrapping",
						description: "Use the existing component model and keep the implementation familiar.",
						preview: "# React\n\n```ts\nconst library = 'react';\n```\n\n<strong>raw html</strong>",
					},
					{ label: "Vue", description: "Use Vue and its composition API." },
				],
				multiSelect,
			},
			{
				question: "Which packages are in scope?",
				header: "Scope",
				options: [
					{ label: "Coding agent", description: "Only the coding-agent package." },
					{ label: "TUI", description: "Include the reusable TUI package." },
				],
				multiSelect: true,
			},
		],
	};
}

function createSelector(
	options: {
		request?: QuestionInteractionRequest;
		keybindings?: KeybindingsManager;
		onSubmit?: (answers: QuestionAnswer[]) => void;
		onCancel?: () => void;
		rows?: number;
		tui?: TUI;
	} = {},
): QuestionSelectorComponent {
	return new QuestionSelectorComponent({
		tui: options.tui ?? fakeTui(options.rows),
		keybindings: options.keybindings ?? new KeybindingsManager(),
		request: options.request ?? request(),
		externalEditorCommand: "true",
		onSubmit: options.onSubmit ?? (() => {}),
		onCancel: options.onCancel ?? (() => {}),
	});
}

describe("QuestionSelectorComponent", () => {
	beforeAll(() => initTheme("dark"));

	it("renders ANSI-safe narrow, CJK, Markdown preview, and wide split layouts without overflow", () => {
		for (const themeName of ["dark", "light"] as const) {
			initTheme(themeName);
			const selector = createSelector({ rows: 20 });
			for (const width of [40, 80, 120, 160]) {
				const lines = selector.render(width);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
				expect(lines.length).toBeLessThanOrEqual(20);
				const rendered = stripAnsi(lines.join("\n"));
				expect(rendered).toContain("Library");
				if (width < 88) expect(rendered.replace(/\s/g, "")).toContain("终端界面🧭");
				else {
					expect(rendered).toContain("终端");
					expect(rendered).toContain("界面 🧭?");
				}
				expect(rendered).toContain("Preview");
				if (width >= 88) {
					expect(rendered).toContain("const library");
					expect(rendered).toContain("<strong>raw html</strong>");
				} else expect(rendered.includes("const library") || rendered.includes("more lines")).toBe(true);
			}
		}
	});

	it("requires preview confirmation, supports review, revisit, multi-select, notes, and submit", () => {
		const onSubmit = vi.fn();
		const selector = createSelector({ onSubmit });
		selector.focused = true;

		selector.handleInput("\r");
		expect(stripAnsi(selector.render(80).join("\n"))).toContain("Preview ready");
		selector.handleInput("\r");
		expect(selector.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
		expect(selector.render(160).every((line) => visibleWidth(line) <= 160)).toBe(true);
		expect(stripAnsi(selector.render(80).join("\n"))).toContain("Which packages are in scope?");

		selector.handleInput(" ");
		selector.handleInput("\x1b[B");
		selector.handleInput(" ");
		selector.handleInput("n");
		for (const character of "both packages") selector.handleInput(character);
		selector.handleInput("\r");
		selector.handleInput("\r");

		const review = stripAnsi(selector.render(80).join("\n"));
		expect(review).toContain("Review your answers");
		expect(review).toContain("Coding agent, TUI");
		expect(review).toContain("Notes: both packages");

		selector.handleInput("\x1b[Z");
		expect(stripAnsi(selector.render(80).join("\n"))).toContain("Which packages are in scope?");
		selector.handleInput("\t");
		selector.handleInput("\r");
		expect(onSubmit).toHaveBeenCalledWith([
			{
				header: "Library",
				selectedLabels: ["React with a very long descriptive label for narrow terminal wrapping"],
			},
			{
				header: "Scope",
				selectedLabels: ["Coding agent", "TUI"],
				notes: "both packages",
			},
		]);
	});

	it("submits a single preview question only after explicit confirmation", () => {
		const onSubmit = vi.fn();
		const singleRequest: QuestionInteractionRequest = {
			requestId: "single-preview",
			questions: [request().questions[0]],
		};
		const selector = createSelector({ request: singleRequest, onSubmit });
		selector.handleInput("\r");
		expect(onSubmit).not.toHaveBeenCalled();
		const previewReady = stripAnsi(selector.render(80).join("\n"));
		expect(previewReady).toContain("Preview ready");
		expect(previewReady).toContain("confirm preview");
		selector.handleInput("\r");
		expect(onSubmit).toHaveBeenCalledOnce();
	});

	it("supports built-in Other input and overall cancellation", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const singleRequest: QuestionInteractionRequest = {
			requestId: "single",
			questions: [request().questions[0]],
		};
		const selector = createSelector({ request: singleRequest, onSubmit, onCancel });
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");
		for (const character of "Solid") selector.handleInput(character);
		selector.handleInput("\r");
		expect(onSubmit).toHaveBeenCalledWith([{ header: "Library", selectedLabels: [], customAnswer: "Solid" }]);

		const cancelled = createSelector({ request: singleRequest, onCancel });
		cancelled.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it("opens the existing external editor from Other input and restores the TUI", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const tui = fakeTui();
		const singleRequest: QuestionInteractionRequest = {
			requestId: "external-editor",
			questions: [request().questions[0]],
		};
		const selector = createSelector({ request: singleRequest, tui });
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");
		selector.handleInput("draft");
		selector.handleInput("\x07");
		try {
			await vi.waitFor(() => expect(tui.start).toHaveBeenCalledOnce());
			expect(tui.stop).toHaveBeenCalledOnce();
		} finally {
			stdout.mockRestore();
		}
	});

	it("uses configurable question navigation keybindings", () => {
		const keybindings = new KeybindingsManager({
			"app.question.next": "ctrl+k",
			"app.question.previous": "ctrl+j",
		});
		const selector = createSelector({ keybindings });
		selector.handleInput("\x0b");
		expect(stripAnsi(selector.render(80).join("\n"))).toContain("Which packages are in scope?");
		selector.handleInput("\x0a");
		expect(stripAnsi(selector.render(80).join("\n"))).toContain("Which UI library");
	});
});
