import {
	type Component,
	type Focusable,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { PolicyConfirmRequest } from "../../../core/policy/index.ts";
import { theme } from "../theme/theme.ts";
import { formatKeyText } from "./keybinding-hints.ts";

export interface PolicyConfirmSelectorOptions {
	tui: TUI;
	keybindings: KeybindingsManager;
	request: PolicyConfirmRequest;
	onAllowOnce: () => void;
	onReject: () => void;
	onCancel: () => void;
}

function wrap(value: string, width: number, maximum: number): string[] {
	const lines = value
		.split("\n")
		.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)))
		.map((line) => truncateToWidth(line, Math.max(0, width), ""));
	if (lines.length <= maximum) return lines;
	const visible = lines.slice(0, maximum);
	visible[maximum - 1] = truncateToWidth(`${visible[maximum - 1]}…`, width, "…");
	return visible;
}

export class PolicyConfirmSelectorComponent implements Component, Focusable {
	private readonly tui: TUI;
	private readonly keybindings: KeybindingsManager;
	private readonly request: PolicyConfirmRequest;
	private readonly onAllowOnce: () => void;
	private readonly onReject: () => void;
	private readonly onCancel: () => void;
	private selected = 0;
	private _focused = false;

	constructor(options: PolicyConfirmSelectorOptions) {
		this.tui = options.tui;
		this.keybindings = options.keybindings;
		this.request = options.request;
		this.onAllowOnce = options.onAllowOnce;
		this.onReject = options.onReject;
		this.onCancel = options.onCancel;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel") || this.keybindings.matches(data, "app.interrupt")) {
			this.onCancel();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.down")) {
			this.selected = this.selected === 0 ? 1 : 0;
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "app.question.submit")) {
			if (this.selected === 0) this.onAllowOnce();
			else this.onReject();
		}
	}

	render(width: number): string[] {
		const availableWidth = Math.max(1, Math.floor(width));
		const lines = [
			theme.bold(theme.fg("warning", "Policy confirmation")),
			...wrap(this.request.operation.summary, availableWidth, 2),
			"",
			...wrap(this.request.reason, availableWidth, 4).map((line) => theme.fg("toolOutput", line)),
		];
		if (this.request.suggestion) {
			lines.push("", ...wrap(this.request.suggestion, availableWidth, 3).map((line) => theme.fg("muted", line)));
		}
		lines.push("");
		for (const [index, label] of ["Allow once", "Reject"].entries()) {
			const focused = index === this.selected;
			const prefix = focused ? "› " : "  ";
			lines.push(
				truncateToWidth(
					`${theme.fg(focused ? "accent" : "muted", prefix)}${focused ? theme.bold(label) : label}`,
					availableWidth,
					"",
				),
			);
		}
		const submit = this.keybindings
			.getKeys("app.question.submit")
			.map((key) => formatKeyText(key))
			.join("/");
		const cancel = this.keybindings
			.getKeys("tui.select.cancel")
			.map((key) => formatKeyText(key))
			.join("/");
		const navigate = [...this.keybindings.getKeys("tui.select.up"), ...this.keybindings.getKeys("tui.select.down")]
			.map((key) => formatKeyText(key))
			.join("/");
		const hints = `${submit} select · ${navigate} navigate · ${cancel} cancel`;
		lines.push("", theme.fg("dim", truncateToWidth(hints, availableWidth, "…")));
		return lines.map((line) =>
			visibleWidth(line) <= availableWidth ? line : truncateToWidth(line, availableWidth, ""),
		);
	}

	invalidate(): void {}
}
