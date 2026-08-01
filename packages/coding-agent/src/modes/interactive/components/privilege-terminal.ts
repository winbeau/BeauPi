import {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Keybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import type {
	PrivilegeCommandResultV1,
	PrivilegeInteractionRequest,
	PrivilegeTerminalControl,
} from "../../../core/privilege/index.ts";
import { theme } from "../theme/theme.ts";
import { formatKeyText } from "./keybinding-hints.ts";

export interface PrivilegeTerminalComponentOptions {
	tui: TUI;
	keybindings: KeybindingsManager;
	request: PrivilegeInteractionRequest;
	control: PrivilegeTerminalControl;
	onDone: (
		response: { status: "completed" } | { status: "cancelled" } | { status: "error"; diagnostic: string },
	) => void;
}

type ViewState = "staging" | "waiting_for_user" | "starting" | "authenticating" | "running" | "cancelling" | "error";

const POLL_MS = 75;

function wrap(value: string, width: number): string[] {
	return value.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
}

function divider(label: string, width: number): string {
	const available = Math.max(1, width);
	if (!label) return theme.fg("borderMuted", "─".repeat(available));
	const reservedBorder = Math.min(2, available);
	const labelWidth = available - reservedBorder;
	const text = labelWidth > 0 ? truncateToWidth(` ${label} `, labelWidth, "") : "";
	const fill = Math.max(0, available - visibleWidth(text));
	const left = Math.min(2, fill);
	return (
		theme.fg("borderMuted", "─".repeat(left)) +
		theme.fg("muted", text) +
		theme.fg("borderMuted", "─".repeat(fill - left))
	);
}

export class PrivilegeTerminalComponent implements Component, Focusable {
	private readonly tui: TUI;
	private readonly keybindings: KeybindingsManager;
	private readonly request: PrivilegeInteractionRequest;
	private readonly control: PrivilegeTerminalControl;
	private readonly onDone: PrivilegeTerminalComponentOptions["onDone"];
	private state: ViewState = "staging";
	private output: string;
	private scrollOffset = 0;
	private startedAt: number | undefined;
	private pollTimer: NodeJS.Timeout | undefined;
	private polling = false;
	private renderWidth = 80;
	private lastResize: { columns: number; rows: number } | undefined;
	private closed = false;
	focused = false;

	constructor(options: PrivilegeTerminalComponentOptions) {
		this.tui = options.tui;
		this.keybindings = options.keybindings;
		this.request = options.request;
		this.control = options.control;
		this.onDone = options.onDone;
		this.renderWidth = Math.max(1, options.tui.terminal.columns);
		this.output = `$ ${this.request.command}`;
		queueMicrotask(() => void this.prepare());
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (this.keybindings.matches(data, "app.privilege.cancel")) {
			void this.cancel();
			return;
		}
		if (this.state === "waiting_for_user") {
			if (this.keybindings.matches(data, "app.privilege.confirm")) void this.execute();
			return;
		}
		if (
			this.state === "staging" ||
			this.state === "starting" ||
			this.state === "cancelling" ||
			this.state === "error"
		)
			return;
		const page = this.paneRows(this.renderWidth);
		if (this.keybindings.matches(data, "app.privilege.scrollUp")) this.scrollOffset += page;
		else if (this.keybindings.matches(data, "app.privilege.scrollDown"))
			this.scrollOffset = Math.max(0, this.scrollOffset - page);
		else {
			void this.control
				.sendSensitive(Buffer.from(data, "utf8"))
				.catch(() => this.finish({ status: "error", diagnostic: "Sensitive terminal input failed" }));
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const available = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
		this.renderWidth = available;
		const target =
			this.request.target.execution === "local"
				? "Local"
				: `${this.request.target.targetId ?? "selected"} · ${this.request.target.terminalId ?? "terminal"}`;
		const title =
			this.state === "staging"
				? "Preparing"
				: this.state === "waiting_for_user"
					? "Ready — Enter to run"
					: this.state === "starting"
						? "Starting sudo"
						: this.state === "authenticating"
							? "Authenticating"
							: this.state === "cancelling"
								? "Cancelling"
								: this.state === "error"
									? "Privilege terminal error"
									: "Running as root";
		const elapsed = this.startedAt === undefined ? "" : ` · ${((Date.now() - this.startedAt) / 1000).toFixed(1)}s`;
		const outputLines = this.output
			? wrap(theme.fg("toolOutput", this.output), available)
			: [theme.fg("muted", "Preparing secure tmux terminal…")];
		const paneRows = this.paneRows(available, outputLines.length);
		const maxOffset = Math.max(0, outputLines.length - paneRows);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		const end = Math.max(0, outputLines.length - this.scrollOffset);
		const start = Math.max(0, end - paneRows);
		const visible = outputLines.slice(start, end);
		while (visible.length < paneRows) visible.push("");
		if (
			(this.state === "waiting_for_user" || this.state === "authenticating" || this.state === "running") &&
			this.focused &&
			this.scrollOffset === 0 &&
			visible.length > 0
		) {
			const cursorIndex = Math.min(outputLines.length, visible.length) - 1;
			visible[cursorIndex] =
				truncateToWidth(visible[cursorIndex] ?? "", Math.max(1, available - 1), "") +
				CURSOR_MARKER +
				theme.fg("accent", "▌");
		}
		const actions: Keybinding[] =
			this.state === "waiting_for_user"
				? ["app.privilege.confirm", "app.privilege.cancel"]
				: this.state === "authenticating" || this.state === "running"
					? ["app.privilege.cancel", "app.privilege.scrollUp", "app.privilege.scrollDown"]
					: ["app.privilege.cancel"];
		const lines = [
			divider(`sudo · ${title} · ${target}${elapsed}`, available),
			...visible,
			divider("", available),
			this.hints(actions),
		];
		return lines.map((line) => truncateToWidth(line, available, "…"));
	}

	invalidate(): void {}

	dispose(): void {
		this.stopPolling();
		if (!this.closed) void this.control.cancel().catch(() => undefined);
		this.closed = true;
	}

	private hints(actions: Keybinding[]): string {
		return theme.fg(
			"dim",
			actions
				.map((action) => {
					const key = this.keybindings
						.getKeys(action)
						.map((value) => formatKeyText(value))
						.join("/");
					const label = action.endsWith("confirm")
						? "run"
						: action.endsWith("cancel")
							? "cancel"
							: action.endsWith("Up")
								? "scroll up"
								: "scroll down";
					return `${key} ${label}`;
				})
				.join("  ·  "),
		);
	}

	private paneRows(width: number, outputLineCount?: number): number {
		const lines = outputLineCount ?? (this.output ? wrap(this.output, width).length : 1);
		const maxRows = Math.max(3, Math.min(12, Math.floor(this.tui.terminal.rows / 3)));
		return Math.max(3, Math.min(maxRows, lines));
	}

	private async syncTerminalSize(): Promise<void> {
		const columns = Math.max(1, this.renderWidth);
		const rows = this.paneRows(columns);
		if (this.lastResize?.columns === columns && this.lastResize.rows === rows) return;
		this.lastResize = { columns, rows };
		await this.control.resize(columns, rows);
	}

	private async prepare(): Promise<void> {
		if (this.state !== "staging" || this.closed) return;
		this.tui.requestRender();
		try {
			await this.control.start();
			if (this.closed) return;
			this.state = "waiting_for_user";
			await this.syncTerminalSize();
			this.startPolling();
			this.tui.requestRender();
		} catch {
			if (!this.closed) this.finish({ status: "error", diagnostic: "Privilege terminal failed to stage command" });
		}
	}

	private async execute(): Promise<void> {
		if (this.state !== "waiting_for_user" || this.closed) return;
		this.state = "starting";
		this.startedAt = Date.now();
		this.tui.requestRender();
		try {
			await this.control.execute();
			if (this.closed) return;
			if (this.state === "starting") this.state = "running";
			void this.control
				.wait()
				.then((result) => this.complete(result))
				.catch(() => this.finish({ status: "error", diagnostic: "Privilege terminal command failed" }));
		} catch {
			if (!this.closed) this.finish({ status: "error", diagnostic: "Privilege terminal failed to execute command" });
		}
	}

	private startPolling(): void {
		void this.poll();
		this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
		this.pollTimer.unref();
	}

	private async poll(): Promise<void> {
		if (this.polling || this.closed) return;
		this.polling = true;
		try {
			const frame = await this.control.capture();
			if (this.closed) return;
			this.output = frame.content;
			if (frame.state === "lost") {
				this.finish({ status: "error", diagnostic: "Privilege tmux pane was lost" });
				return;
			}
			if (frame.state === "waiting_for_user") {
				if (this.startedAt === undefined) this.state = "waiting_for_user";
			} else if (frame.state === "authenticating") {
				this.state = "authenticating";
			} else if (frame.state === "starting") {
				if (this.startedAt !== undefined) this.state = "starting";
			} else if (frame.state === "running") {
				this.state = "running";
			}
			await this.syncTerminalSize();
			this.tui.requestRender();
		} catch {
			if (!this.closed) this.finish({ status: "error", diagnostic: "Privilege terminal capture failed" });
		} finally {
			this.polling = false;
		}
	}

	private stopPolling(): void {
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = undefined;
	}

	private async cancel(): Promise<void> {
		if (this.state === "cancelling") return;
		this.state = "cancelling";
		this.tui.requestRender();
		try {
			await this.control.cancel();
		} finally {
			this.finish({ status: "cancelled" });
		}
	}

	private complete(result: PrivilegeCommandResultV1): void {
		if (this.closed) return;
		this.output = result.output;
		this.finish(result.cancelled ? { status: "cancelled" } : { status: "completed" });
	}

	private finish(response: Parameters<PrivilegeTerminalComponentOptions["onDone"]>[0]): void {
		if (this.closed) return;
		this.closed = true;
		this.stopPolling();
		this.onDone(response);
	}
}
