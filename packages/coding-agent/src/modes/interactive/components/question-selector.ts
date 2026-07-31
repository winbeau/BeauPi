import {
	type Component,
	Editor,
	type Focusable,
	Markdown,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import {
	QUESTION_LIMITS,
	type QuestionAnswer,
	type QuestionInteractionRequest,
	type UserQuestion,
} from "../../../core/question.ts";
import { editInExternalEditor } from "../external-editor.ts";
import { getEditorTheme, getMarkdownTheme, theme } from "../theme/theme.ts";
import { formatKeyText } from "./keybinding-hints.ts";

interface QuestionState {
	focusedOption: number;
	selectedLabels: Set<string>;
	customAnswer: string;
	notes: string;
	previewArmed: boolean;
}

type EditTarget = "other" | "notes";

export interface QuestionSelectorOptions {
	tui: TUI;
	keybindings: KeybindingsManager;
	request: QuestionInteractionRequest;
	externalEditorCommand: string;
	onSubmit: (answers: QuestionAnswer[]) => void;
	onCancel: () => void;
}

function padAnsi(value: string, width: number): string {
	const fitted = truncateToWidth(value, Math.max(0, width), "…");
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function wrapStyled(value: string, width: number, maxLines?: number): string[] {
	const lines = value
		.split("\n")
		.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)))
		.map((line) => truncateToWidth(line, Math.max(0, width), ""));
	if (maxLines === undefined || lines.length <= maxLines) return lines;
	const visible = lines.slice(0, maxLines);
	visible[maxLines - 1] = truncateToWidth(`${visible[maxLines - 1]}…`, width, "…");
	return visible;
}

function plainAnswer(question: UserQuestion, state: QuestionState): QuestionAnswer | undefined {
	const customAnswer = state.customAnswer.trim();
	const notes = state.notes.trim();
	const choiceCount = state.selectedLabels.size + (customAnswer ? 1 : 0);
	if (question.multiSelect ? choiceCount < 1 : choiceCount !== 1) return undefined;
	return {
		header: question.header,
		selectedLabels: [...state.selectedLabels],
		...(customAnswer ? { customAnswer } : {}),
		...(notes ? { notes } : {}),
	};
}

export class QuestionSelectorComponent implements Component, Focusable {
	private readonly tui: TUI;
	private readonly keybindings: KeybindingsManager;
	private readonly request: QuestionInteractionRequest;
	private readonly externalEditorCommand: string;
	private readonly onSubmit: (answers: QuestionAnswer[]) => void;
	private readonly onCancel: () => void;
	private readonly states: QuestionState[];
	private currentQuestion = 0;
	private review = false;
	private editTarget: EditTarget | undefined;
	private readonly editor: Editor;
	private statusMessage: string | undefined;
	private previewCache = new Map<string, Markdown>();
	private _focused = false;

	constructor(options: QuestionSelectorOptions) {
		this.tui = options.tui;
		this.keybindings = options.keybindings;
		this.request = options.request;
		this.externalEditorCommand = options.externalEditorCommand;
		this.onSubmit = options.onSubmit;
		this.onCancel = options.onCancel;
		this.states = options.request.questions.map(() => ({
			focusedOption: 0,
			selectedLabels: new Set<string>(),
			customAnswer: "",
			notes: "",
			previewArmed: false,
		}));
		this.editor = new Editor(this.tui, getEditorTheme(), { paddingX: 1 });
		this.editor.onChange = (value) => this.updateEditValue(value);
		this.editor.onSubmit = (value) => this.finishEditing(value);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value && this.editTarget !== undefined;
	}

	invalidate(): void {
		this.editor.invalidate();
		for (const markdown of this.previewCache.values()) markdown.invalidate();
	}

	handleInput(data: string): void {
		if (this.editTarget) {
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.updateEditValue(this.editor.getText());
				this.editTarget = undefined;
				this.editor.focused = false;
				this.tui.requestRender();
				return;
			}
			if (this.keybindings.matches(data, "app.editor.external")) {
				void this.openExternalEditor();
				return;
			}
			this.editor.handleInput(data);
			return;
		}

		if (this.keybindings.matches(data, "tui.select.cancel") || this.keybindings.matches(data, "app.interrupt")) {
			this.onCancel();
			return;
		}
		if (this.keybindings.matches(data, "app.question.previous")) {
			this.moveQuestion(-1);
			return;
		}
		if (this.keybindings.matches(data, "app.question.next")) {
			this.moveQuestion(1);
			return;
		}
		if (this.review) {
			if (this.keybindings.matches(data, "app.question.submit")) this.submitReview();
			return;
		}
		if (this.keybindings.matches(data, "app.question.notes")) {
			this.startEditing("notes");
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveOption(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveOption(1);
			return;
		}
		if (this.keybindings.matches(data, "app.question.toggle")) {
			this.toggleFocusedOption(false);
			return;
		}
		if (this.keybindings.matches(data, "app.question.submit")) this.toggleFocusedOption(true);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const lines: string[] = [this.renderNavigation(safeWidth), ""];
		if (this.review) lines.push(...this.renderReview(safeWidth));
		else lines.push(...this.renderQuestion(safeWidth));
		if (this.statusMessage) lines.push("", theme.fg("warning", truncateToWidth(this.statusMessage, safeWidth, "…")));
		lines.push("", this.renderHints(safeWidth));
		return lines.map((line) => truncateToWidth(line, safeWidth, ""));
	}

	private current(): { question: UserQuestion; state: QuestionState } {
		return { question: this.request.questions[this.currentQuestion]!, state: this.states[this.currentQuestion]! };
	}

	private optionCount(question: UserQuestion): number {
		return question.options.length + 1;
	}

	private moveOption(delta: number): void {
		const { question, state } = this.current();
		state.focusedOption = (state.focusedOption + delta + this.optionCount(question)) % this.optionCount(question);
		state.previewArmed = false;
		this.statusMessage = undefined;
		this.tui.requestRender();
	}

	private moveQuestion(delta: number): void {
		const lastIndex = this.request.questions.length;
		let index = this.review ? lastIndex : this.currentQuestion;
		index = Math.max(0, Math.min(lastIndex, index + delta));
		this.review = index === lastIndex;
		if (!this.review) this.currentQuestion = index;
		this.statusMessage = undefined;
		this.tui.requestRender();
	}

	private advance(): void {
		if (this.request.questions.length === 1 && !this.request.questions[0]!.multiSelect) {
			const answer = plainAnswer(this.request.questions[0]!, this.states[0]!);
			if (answer) {
				this.onSubmit([answer]);
				return;
			}
		}
		if (this.currentQuestion < this.request.questions.length - 1) this.currentQuestion++;
		else this.review = true;
		this.statusMessage = undefined;
		this.tui.requestRender();
	}

	private toggleFocusedOption(confirm: boolean): void {
		const { question, state } = this.current();
		const option = question.options[state.focusedOption];
		if (!option) {
			if (confirm && question.multiSelect && state.customAnswer.trim()) this.advance();
			else this.startEditing("other");
			return;
		}
		if (question.multiSelect) {
			if (confirm) {
				this.advance();
				return;
			}
			if (state.selectedLabels.has(option.label)) state.selectedLabels.delete(option.label);
			else state.selectedLabels.add(option.label);
			state.previewArmed = false;
			this.tui.requestRender();
			return;
		}
		state.customAnswer = "";
		state.selectedLabels.clear();
		state.selectedLabels.add(option.label);
		if (confirm && option.preview && !state.previewArmed) {
			state.previewArmed = true;
			this.statusMessage = "Preview ready. Confirm again to continue.";
			this.tui.requestRender();
			return;
		}
		state.previewArmed = false;
		if (confirm) this.advance();
		else this.tui.requestRender();
	}

	private startEditing(target: EditTarget): void {
		const state = this.current().state;
		this.editTarget = target;
		this.editor.setText(target === "other" ? state.customAnswer : state.notes);
		this.editor.focused = this._focused;
		this.statusMessage = undefined;
		this.tui.requestRender();
	}

	private updateEditValue(value: string): void {
		const state = this.current().state;
		if (this.editTarget === "other") {
			state.customAnswer = [...value].slice(0, QUESTION_LIMITS.maxCustomAnswerLength).join("");
		}
		if (this.editTarget === "notes") state.notes = [...value].slice(0, QUESTION_LIMITS.maxNotesLength).join("");
	}

	private finishEditing(value: string): void {
		const target = this.editTarget;
		this.updateEditValue(value);
		this.editTarget = undefined;
		this.editor.focused = false;
		if (target === "other") {
			const { question, state } = this.current();
			state.customAnswer = state.customAnswer.trim();
			if (state.customAnswer && !question.multiSelect) {
				state.selectedLabels.clear();
				this.advance();
				return;
			}
		}
		this.tui.requestRender();
	}

	private async openExternalEditor(): Promise<void> {
		this.tui.stop();
		try {
			const result = await editInExternalEditor({
				command: this.externalEditorCommand,
				content: this.editor.getText(),
			});
			if (result.status === "complete") {
				this.editor.setText(result.content);
				this.updateEditValue(result.content);
			}
		} finally {
			this.tui.start();
			this.tui.requestRender({ force: true });
		}
	}

	private submitReview(): void {
		const answers: QuestionAnswer[] = [];
		for (let index = 0; index < this.request.questions.length; index++) {
			const answer = plainAnswer(this.request.questions[index]!, this.states[index]!);
			if (!answer) {
				this.currentQuestion = index;
				this.review = false;
				this.statusMessage = `Answer required for ${this.request.questions[index]!.header}.`;
				this.tui.requestRender();
				return;
			}
			answers.push(answer);
		}
		this.onSubmit(answers);
	}

	private renderNavigation(width: number): string {
		if (this.request.questions.length === 1) {
			const answered = plainAnswer(this.request.questions[0]!, this.states[0]!) !== undefined;
			return truncateToWidth(
				theme.bold(
					theme.fg(
						this.review ? "muted" : "accent",
						`${this.request.questions[0]!.header}  ${answered ? "✓" : "□"}`,
					),
				),
				width,
				"…",
			);
		}
		const items = this.request.questions.map((question, index) => {
			const answered = plainAnswer(question, this.states[index]!) !== undefined;
			const active = !this.review && index === this.currentQuestion;
			const text = `${answered ? "✓" : "□"} ${question.header}`;
			return active ? theme.bold(theme.fg("accent", text)) : theme.fg(answered ? "success" : "muted", text);
		});
		const submit = this.review ? theme.bold(theme.fg("accent", "✓ Submit")) : theme.fg("muted", "✓ Submit");
		const full = `←  ${[...items, submit].join("  ")}  →`;
		if (visibleWidth(full) <= width) return full;
		const activeHeader = this.review ? "Submit" : this.request.questions[this.currentQuestion]!.header;
		const compact = `←  ${this.review ? "✓" : "□"} ${activeHeader}  ${this.currentQuestion + 1}/${this.request.questions.length}  →`;
		return truncateToWidth(theme.bold(theme.fg("accent", compact)), width, "…");
	}

	private renderQuestion(width: number): string[] {
		const { question, state } = this.current();
		const preview = question.options[state.focusedOption]?.preview;
		const widePreview = preview && width >= 88;
		if (widePreview) {
			const gap = 3;
			const leftWidth = Math.min(44, Math.max(32, Math.floor((width - gap) * 0.38)));
			const rightWidth = Math.max(1, width - gap - leftWidth);
			const left = this.renderQuestionBody(question, state, leftWidth);
			const right = this.renderPreview(preview, rightWidth);
			const height = Math.max(left.length, right.length);
			const lines: string[] = [];
			for (let index = 0; index < height; index++) {
				lines.push(
					`${padAnsi(left[index] ?? "", leftWidth)}${" ".repeat(gap)}${padAnsi(right[index] ?? "", rightWidth)}`,
				);
			}
			return lines;
		}
		const lines = this.renderQuestionBody(question, state, width);
		if (preview) {
			const previewBudget = Math.max(3, this.tui.terminal.rows - lines.length - 7);
			lines.push("", ...this.renderPreview(preview, width, previewBudget));
		}
		return lines;
	}

	private renderQuestionBody(question: UserQuestion, state: QuestionState, width: number): string[] {
		const lines = wrapStyled(theme.bold(question.question), width);
		lines.push("");
		const compactVertical = this.tui.terminal.rows <= 24;
		for (let index = 0; index < this.optionCount(question); index++) {
			const option = question.options[index];
			const focused = index === state.focusedOption;
			const selected = option ? state.selectedLabels.has(option.label) : state.customAnswer.trim().length > 0;
			const marker = question.multiSelect ? (selected ? "☑" : "☐") : selected ? "●" : "○";
			const label = option?.label ?? "Other";
			const prefix = `${focused ? "›" : " "} ${marker} ${index + 1}. `;
			const labelWidth = Math.max(1, width - visibleWidth(prefix));
			const labelLines = wrapStyled(label, labelWidth, compactVertical && !focused ? 1 : 2);
			lines.push(
				truncateToWidth(
					`${theme.fg(focused ? "accent" : selected ? "success" : "muted", prefix)}${focused ? theme.bold(labelLines[0] ?? "") : (labelLines[0] ?? "")}`,
					width,
					"",
				),
			);
			for (const continuation of labelLines.slice(1))
				lines.push(`${" ".repeat(visibleWidth(prefix))}${continuation}`);
			const description = option?.description ?? "Type a custom answer.";
			const descriptionIndent = " ".repeat(Math.min(width, visibleWidth(prefix)));
			const descriptionWidth = Math.max(1, width - visibleWidth(descriptionIndent));
			const descriptionLimit = focused ? 2 : this.tui.terminal.rows <= 20 ? 0 : compactVertical ? 1 : 2;
			if (descriptionLimit > 0) {
				for (const descriptionLine of wrapStyled(
					theme.fg("dim", description),
					descriptionWidth,
					descriptionLimit,
				)) {
					lines.push(`${descriptionIndent}${descriptionLine}`);
				}
			}
			if (!option && state.customAnswer.trim()) {
				for (const customLine of wrapStyled(
					theme.fg("muted", `Answer: ${state.customAnswer.trim()}`),
					descriptionWidth,
					2,
				)) {
					lines.push(`${descriptionIndent}${customLine}`);
				}
			}
		}
		if (state.notes.trim())
			lines.push("", ...wrapStyled(theme.fg("muted", `Notes: ${state.notes.trim()}`), width, 2));
		if (this.editTarget) {
			const title = this.editTarget === "other" ? "Other answer" : "Notes";
			lines.push("", theme.bold(theme.fg("accent", title)), ...this.editor.render(width));
		}
		return lines;
	}

	private renderPreview(preview: string, width: number, lineBudget?: number): string[] {
		let markdown = this.previewCache.get(preview);
		if (!markdown) {
			markdown = new Markdown(preview, 0, 0, getMarkdownTheme());
			this.previewCache.set(preview, markdown);
		}
		const rendered = markdown.render(Math.max(1, width));
		const maxLines = Math.max(3, Math.min(18, lineBudget ?? this.tui.terminal.rows - 12));
		const heading = theme.bold(theme.fg("accent", "Preview"));
		if (rendered.length <= maxLines) return [heading, ...rendered];
		const visible = rendered.slice(0, maxLines - 1);
		visible.push(theme.fg("muted", `… ${rendered.length - visible.length} more lines`));
		return [heading, ...visible];
	}

	private renderReview(width: number): string[] {
		const lines = [theme.bold("Review your answers"), ""];
		for (let index = 0; index < this.request.questions.length; index++) {
			const question = this.request.questions[index]!;
			const answer = plainAnswer(question, this.states[index]!);
			lines.push(theme.bold(`${index + 1}. ${question.header}`));
			if (!answer) {
				lines.push(theme.fg("warning", "   Not answered"));
				continue;
			}
			const values = [...answer.selectedLabels, ...(answer.customAnswer ? [`Other: ${answer.customAnswer}`] : [])];
			lines.push(...wrapStyled(theme.fg("success", `   ${values.join(", ")}`), width, 3));
			if (answer.notes) lines.push(...wrapStyled(theme.fg("muted", `   Notes: ${answer.notes}`), width, 2));
		}
		return lines;
	}

	private keyLabel(action: Parameters<KeybindingsManager["getKeys"]>[0]): string {
		return this.keybindings
			.getKeys(action)
			.map((key) => formatKeyText(key))
			.join("/");
	}

	private renderHints(width: number): string {
		const hints: string[] = [];
		if (this.editTarget) {
			hints.push(`${this.keyLabel("tui.input.submit")} submit`);
			hints.push(`${this.keyLabel("app.editor.external")} external editor`);
			hints.push(`${this.keyLabel("tui.select.cancel")} back`);
		} else if (this.review) {
			hints.push(`${this.keyLabel("app.question.submit")} submit`);
			hints.push(`${this.keyLabel("app.question.previous")} back`);
			hints.push(`${this.keyLabel("tui.select.cancel")} cancel`);
		} else {
			const { question, state } = this.current();
			const otherFocused = state.focusedOption === question.options.length;
			if (otherFocused) {
				const keys =
					question.multiSelect && state.customAnswer.trim()
						? this.keyLabel("app.question.toggle")
						: question.multiSelect
							? `${this.keyLabel("app.question.submit")}/${this.keyLabel("app.question.toggle")}`
							: this.keyLabel("app.question.submit");
				hints.push(`${keys} edit Other`);
			} else if (state.previewArmed) hints.push(`${this.keyLabel("app.question.submit")} confirm preview`);
			else {
				hints.push(
					`${this.keyLabel(question.multiSelect ? "app.question.toggle" : "app.question.submit")} ${question.multiSelect ? "toggle" : "select"}`,
				);
			}
			if (question.multiSelect && (!otherFocused || state.customAnswer.trim())) {
				hints.push(`${this.keyLabel("app.question.submit")} next`);
			}
			hints.push(`${this.keyLabel("tui.select.up")}/${this.keyLabel("tui.select.down")} navigate`);
			hints.push(`${this.keyLabel("app.question.notes")} notes`);
			if (this.request.questions.length > 1) hints.push(`${this.keyLabel("app.question.next")} next question`);
			hints.push(`${this.keyLabel("tui.select.cancel")} cancel`);
		}
		return theme.fg("dim", truncateToWidth(hints.join("  ·  "), width, "…"));
	}
}
