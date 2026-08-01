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
	let executed = false;
	const promise = new Promise<PrivilegeCommandResultV1>((resolve) => {
		resolveWait = resolve;
	});
	const execute = vi.fn(async () => {
		executed = true;
	});
	const capture = vi.fn<PrivilegeTerminalControl["capture"]>(async () =>
		executed
			? { content: "Password: ", state: "authenticating" }
			: { content: `$ ${request().command}`, state: "waiting_for_user" },
	);
	const control: PrivilegeTerminalControl = {
		start: vi.fn(async () => {}),
		execute,
		sendSensitive: vi.fn(async () => {}),
		capture,
		resize: vi.fn(async () => {}),
		cancel: vi.fn(async () => {}),
		wait: vi.fn(() => promise),
	};
	return { control, capture, execute, resolveWait };
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

describe("PrivilegeTerminalComponent", () => {
	beforeAll(() => initTheme("dark"));

	it("renders the staged command inside two dividers on the first frame", () => {
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
			const plain = rendered.map(stripAnsi);
			expect(plain.filter((line) => line.includes("─"))).toHaveLength(2);
			expect(plain.join("\n")).toContain("sudo install");
			expect(plain.join("\n")).not.toContain("Permission required");
			expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
			component.dispose();
		}
	});

	it("stages automatically but executes only with the configured run key", async () => {
		const fixture = controls();
		const done = vi.fn<(response: PrivilegeInteractionResponse) => void>();
		const component = new PrivilegeTerminalComponent({
			tui: fakeTui(),
			keybindings: new KeybindingsManager({ "app.privilege.confirm": "ctrl+y" }),
			request: request(),
			control: fixture.control,
			onDone: done,
		});

		await flush();
		await flush();
		expect(fixture.control.start).toHaveBeenCalledTimes(1);
		expect(fixture.execute).not.toHaveBeenCalled();
		component.handleInput("\r");
		await flush();
		expect(fixture.execute).not.toHaveBeenCalled();
		component.handleInput("\u0019");
		await flush();
		expect(fixture.execute).toHaveBeenCalledTimes(1);
		expect(fixture.control.wait).toHaveBeenCalledTimes(1);

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

	it("resizes the staged pane with captured command output", async () => {
		const fixture = controls();
		fixture.capture.mockResolvedValue({
			content: "$ sudo command\nline 2\nline 3\nline 4\nline 5\nline 6",
			state: "waiting_for_user",
		});
		const component = new PrivilegeTerminalComponent({
			tui: fakeTui(80, 30),
			keybindings: new KeybindingsManager(),
			request: request(),
			control: fixture.control,
			onDone: vi.fn(),
		});

		await flush();
		await flush();
		const rendered = component.render(80);
		const plain = rendered.map(stripAnsi);

		expect(plain[0]).toContain("sudo · Ready");
		expect(fixture.control.resize).toHaveBeenLastCalledWith(80, 6);
		expect(rendered.every((line) => visibleWidth(line) <= 80)).toBe(true);
		component.dispose();
	});

	it("cancels a staged command with Escape without executing it", async () => {
		const fixture = controls();
		const done = vi.fn<(response: PrivilegeInteractionResponse) => void>();
		const component = new PrivilegeTerminalComponent({
			tui: fakeTui(),
			keybindings: new KeybindingsManager(),
			request: request(),
			control: fixture.control,
			onDone: done,
		});

		await flush();
		component.handleInput("\u001b");
		await flush();

		expect(fixture.execute).not.toHaveBeenCalled();
		expect(fixture.control.cancel).toHaveBeenCalledTimes(1);
		expect(done).toHaveBeenCalledWith({ status: "cancelled" });
	});

	it("detaches after authentication while the command keeps waiting", async () => {
		const fixture = controls();
		let executedFrames = 0;
		fixture.capture.mockImplementation(async () => {
			if (fixture.execute.mock.calls.length === 0) {
				return { content: `$ ${request().command}`, state: "waiting_for_user" };
			}
			return executedFrames++ === 0
				? { content: "Password: ", state: "authenticating" }
				: { content: "Password: ", state: "running" };
		});
		const done = vi.fn<(response: PrivilegeInteractionResponse) => void>();
		const component = new PrivilegeTerminalComponent({
			tui: fakeTui(),
			keybindings: new KeybindingsManager(),
			request: request(),
			control: fixture.control,
			onDone: done,
		});

		await flush();
		component.handleInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 90));
		component.handleInput("secret\r");
		await new Promise((resolve) => setTimeout(resolve, 250));

		expect(fixture.control.sendSensitive).toHaveBeenCalledWith(Buffer.from("secret\r"));
		expect(done).toHaveBeenCalledWith({ status: "completed" });
		fixture.resolveWait({ output: "done\n", exitCode: 0, startedAt: 1, completedAt: 2 });
		await flush();
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("cancels on dispose after staging", async () => {
		const fixture = controls();
		const component = new PrivilegeTerminalComponent({
			tui: fakeTui(),
			keybindings: new KeybindingsManager(),
			request: request(),
			control: fixture.control,
			onDone: vi.fn(),
		});
		await flush();
		component.dispose();
		await flush();
		expect(fixture.execute).not.toHaveBeenCalled();
		expect(fixture.control.cancel).toHaveBeenCalledTimes(1);
	});
});
