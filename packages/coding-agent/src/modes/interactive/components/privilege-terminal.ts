import { type Component, type Focusable, type TUI, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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

type ViewState = "review" | "starting" | "authenticating" | "running" | "cancelling" | "error";

function wrap(value: string, width: number): string[] {
	return value.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
}

export class PrivilegeTerminalComponent implements Component, Focusable {
	private readonly tui: TUI;
	private readonly keybindings: KeybindingsManager;
	private readonly request: PrivilegeInteractionRequest;
	private readonly control: PrivilegeTerminalControl;
	private readonly onDone: PrivilegeTerminalComponentOptions["onDone"];
	private state: ViewState = "review";
	private output = "";
	private scrollOffset = 0;
	private startedAt: number | undefined;
	private pollTimer: NodeJS.Timeout | undefined;
	private closed = false;
	focused = false;

	constructor(options: PrivilegeTerminalComponentOptions) {
		this.tui = options.tui;
		this.keybindings = options.keybindings;
		this.request = options.request;
		this.control = options.control;
		this.onDone = options.onDone;
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (this.state === "review") {
			if (this.keybindings.matches(data, "app.privilege.confirm")) void this.start();
			else if (this.keybindings.matches(data, "app.privilege.cancel")) this.finish({ status: "cancelled" });
			return;
		}
		if (this.keybindings.matches(data, "app.privilege.cancel")) {
			void this.cancel();
			return;
		}
		if (this.state === "starting" || this.state === "cancelling" || this.state === "error") return;
		const page = Math.max(1, Math.floor(this.tui.terminal.rows / 3));
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
		const target =
			this.request.target.execution === "local"
				? "Local"
				: `${this.request.target.targetId ?? "selected"} · ${this.request.target.terminalId ?? "terminal"}`;
		const title =
			this.state === "review"
				? "Permission required"
				: this.state === "authenticating"
					? "Authenticating"
					: this.state === "cancelling"
						? "Cancelling"
						: this.state === "error"
							? "Privilege terminal error"
							: "Running as root";
		const lines = [theme.bold(theme.fg(this.state === "error" ? "error" : "warning", title))];
		if (this.state === "review") {
			lines.push(
				theme.fg("muted", `Source: ${this.request.sourceTool} · every sudo command requires confirmation`),
				theme.fg("muted", `Target: ${target}`),
				theme.fg("muted", `cwd: ${this.request.cwd}`),
				"",
				theme.bold("Command (read-only)"),
				...wrap(theme.fg("toolOutput", this.request.command), available),
				"",
				theme.fg("muted", `Audit: ${this.request.auditPath}`),
				theme.fg("success", "Authentication input is private and is not recorded."),
				"",
				this.hints(["app.privilege.confirm", "app.privilege.cancel"]),
			);
		} else {
			const elapsed = this.startedAt === undefined ? 0 : (Date.now() - this.startedAt) / 1000;
			lines.push(theme.fg("muted", `Target: ${target} · ${elapsed.toFixed(1)}s`), "");
			const outputLines = this.output ? wrap(theme.fg("toolOutput", this.output), available) : [];
			const height = Math.max(3, this.tui.terminal.rows - 8);
			const end = Math.max(0, outputLines.length - this.scrollOffset);
			const start = Math.max(0, end - height);
			lines.push(
				...(outputLines.length
					? outputLines.slice(start, end)
					: [theme.fg("muted", "Waiting for terminal output…")]),
			);
			lines.push("", this.hints(["app.privilege.cancel", "app.privilege.scrollUp", "app.privilege.scrollDown"]));
		}
		return lines.map((line) => truncateToWidth(line, available, "…"));
	}

	invalidate(): void {}

	dispose(): void {
		this.stopPolling();
		if (!this.closed && this.state !== "review") void this.control.cancel().catch(() => undefined);
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

	private async start(): Promise<void> {
		if (this.state !== "review" || this.closed) return;
		this.state = "starting";
		this.startedAt = Date.now();
		this.tui.requestRender();
		try {
			await this.control.start();
			await this.control.resize(this.tui.terminal.columns, Math.max(3, this.tui.terminal.rows - 6));
			this.state = "running";
			this.startPolling();
			this.complete(await this.control.wait());
		} catch {
			this.finish({ status: "error", diagnostic: "Privilege terminal failed to start" });
		}
	}

	private startPolling(): void {
		let polling = false;
		this.pollTimer = setInterval(() => {
			if (polling || this.closed) return;
			polling = true;
			void this.control
				.capture()
				.then((frame) => {
					this.output = frame.content;
					if (frame.state === "authenticating") this.state = "authenticating";
					else if (frame.state === "running") this.state = "running";
					this.tui.requestRender();
				})
				.catch(() => this.finish({ status: "error", diagnostic: "Privilege terminal capture failed" }))
				.finally(() => {
					polling = false;
				});
		}, 75);
		this.pollTimer.unref();
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
