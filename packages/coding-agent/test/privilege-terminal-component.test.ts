import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type {
	PrivilegeCommandResultV1,
	PrivilegeInteractionRequest,
	PrivilegeInteractionResponse,
	PrivilegeTerminalControl,
} from "../src/core/privilege/index.ts";
import { PrivilegeTerminalComponent } from "../src/modes/interactive/components/privilege-terminal.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function fakeTui(columns = 80, rows = 32): TUI {
	return {
		terminal: { columns, rows },
		requestRender: vi.fn(),
		stop: vi.fn(),
		start: vi.fn(),
	} as unknown as TUI;
}

function request(): PrivilegeInteractionRequest {
	return {
		requestId: "privilege-request",
		sourceTool: "terminal_bash",
		route: "terminal_bash",
		command: "sudo install -m 0644 ./source /usr/local/share/example",
		target: { execution: "terminal", targetId: "server", terminalId: "term", monitorId: "mon" },
		cwd: "/workspace",
		auditPath: "/home/user/.pi/audit/privileged/2026-01-01.jsonl",
		createdAt: new Date(0).toISOString(),
	};
}

function controls() {
	let resolveWait: (result: PrivilegeCommandResultV1) => void = () => {};
	const promise = new Promise<PrivilegeCommandResultV1>((resolve) => {
		resolveWait = resolve;
	});
	const control: PrivilegeTerminalControl = {
		start: vi.fn(async () => {}),
		sendSensitive: vi.fn(async () => {}),
		capture: vi.fn(async () => ({ content: "Password: ", state: "authenticating" as const })),
		resize: vi.fn(async () => {}),
		cancel: vi.fn(async () => {}),
		wait: vi.fn(() => promise),
	};
	return { control, resolveWait };
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

describe("PrivilegeTerminalComponent", () => {
	beforeAll(() => initTheme("dark"));

	it("renders the read-only per-request review without horizontal overflow", () => {
		for (const width of [40, 80, 120, 160]) {
			const fixture = controls();
			const component = new PrivilegeTerminalComponent({
				tui: fakeTui(width),
				keybindings: new KeybindingsManager(),
				request: request(),
				control: fixture.control,
				onDone: vi.fn(),
			});
			const rendered = component.render(width);
			expect(stripAnsi(rendered.join("\n"))).toContain("Permission required");
			expect(stripAnsi(rendered.join("\n"))).toContain("every sudo comm");
			expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});

	it("does not start before the configured confirm key and never renders sensitive input", async () => {
		const tui = fakeTui();
		const fixture = controls();
		const done = vi.fn<(response: PrivilegeInteractionResponse) => void>();
		const keybindings = new KeybindingsManager({ "app.privilege.confirm": "ctrl+y" });
		const component = new PrivilegeTerminalComponent({
			tui,
			keybindings,
			request: request(),
			control: fixture.control,
			onDone: done,
		});

		component.handleInput("\r");
		await flush();
		expect(fixture.control.start).not.toHaveBeenCalled();
		component.handleInput("\u0019");
		await flush();
		expect(fixture.control.start).toHaveBeenCalledTimes(1);
		expect(fixture.control.resize).toHaveBeenCalledWith(80, 26);

		const secret = "M13-tui-secret-fixture";
		component.handleInput(secret);
		await flush();
		expect(fixture.control.sendSensitive).toHaveBeenCalledWith(Buffer.from(secret));
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain(secret);

		fixture.resolveWait({ output: "done\n", exitCode: 0, startedAt: 1, completedAt: 2 });
		await flush();
		expect(done).toHaveBeenCalledWith({ status: "completed" });
		expect(JSON.stringify(done.mock.calls)).not.toContain(secret);
	});

	it("cancels on dispose after start without retaining typed bytes", async () => {
		const fixture = controls();
		const component = new PrivilegeTerminalComponent({
			tui: fakeTui(),
			keybindings: new KeybindingsManager(),
			request: request(),
			control: fixture.control,
			onDone: vi.fn(),
		});
		component.handleInput("\r");
		await flush();
		component.dispose();
		await flush();
		expect(fixture.control.cancel).toHaveBeenCalledTimes(1);
		fixture.resolveWait({ output: "", exitCode: null, cancelled: true, startedAt: 1, completedAt: 2 });
	});
});
