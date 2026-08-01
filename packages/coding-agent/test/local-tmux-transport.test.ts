import { describe, expect, it, vi } from "vitest";
import { LocalTmuxTransport, type LocalTmuxTransportRunner } from "../src/core/terminal/local-tmux-transport.ts";

function ok() {
	return { stdout: "", stderr: "", exitCode: 0, startedAt: 1, completedAt: 2 };
}

describe("LocalTmuxTransport sensitive input", () => {
	it("passes bytes only through load-buffer stdin and always deletes the named buffer", async () => {
		const secret = Buffer.from("M13-sensitive-token\r", "utf8");
		const calls: Array<{ args: string[]; stdin?: Buffer }> = [];
		const runner: LocalTmuxTransportRunner = vi.fn(async (args, options) => {
			calls.push({ args: [...args], stdin: options.stdin ? Buffer.from(options.stdin) : undefined });
			return ok();
		});
		const transport = new LocalTmuxTransport({ runner, randomId: () => "buffer-id" });

		await transport.sendSensitive("%7", secret);

		expect(calls.map((call) => call.args[0])).toEqual(["load-buffer", "paste-buffer", "delete-buffer"]);
		expect(calls[0]).toEqual({ args: ["load-buffer", "-b", "buffer-id", "-"], stdin: secret });
		expect(calls[1]?.args).toEqual(["paste-buffer", "-d", "-r", "-b", "buffer-id", "-t", "%7"]);
		expect(calls[2]?.args).toEqual(["delete-buffer", "-b", "buffer-id"]);
		for (const call of calls) expect(call.args.join(" ")).not.toContain(secret.toString("utf8").trim());
	});

	it("deletes the buffer when paste fails without including input in the error", async () => {
		const secret = Buffer.from("M13-paste-failure-secret", "utf8");
		const calls: string[][] = [];
		const runner: LocalTmuxTransportRunner = vi.fn(async (args) => {
			calls.push([...args]);
			if (args[0] === "paste-buffer") return { ...ok(), stderr: "paste failed", exitCode: 1 };
			return ok();
		});
		const transport = new LocalTmuxTransport({ runner, randomId: () => "buffer-id" });

		await expect(transport.sendSensitive("%7", secret)).rejects.toThrow("paste-buffer");

		expect(calls.at(-1)).toEqual(["delete-buffer", "-b", "buffer-id"]);
		try {
			await transport.sendSensitive("%7", secret);
		} catch (error) {
			expect(error instanceof Error ? error.message : String(error)).not.toContain(secret.toString("utf8"));
		}
	});

	it("captures styled history and the visible pane separately", async () => {
		const runner: LocalTmuxTransportRunner = vi.fn(async () => ok());
		const transport = new LocalTmuxTransport({ runner });

		await transport.captureStyled("%7");
		await transport.captureScreen("%7");

		expect(runner).toHaveBeenNthCalledWith(1, ["capture-pane", "-p", "-e", "-J", "-S", "-", "-t", "%7"], {});
		expect(runner).toHaveBeenNthCalledWith(2, ["capture-pane", "-p", "-t", "%7"], {});
	});

	it("parses pane status with cursor position under the C locale", async () => {
		const runner: LocalTmuxTransportRunner = vi.fn(async () => ({
			...ok(),
			stdout: "%13__BEAUPI_TMUX_FIELD__bash__BEAUPI_TMUX_FIELD__4__BEAUPI_TMUX_FIELD__0__BEAUPI_TMUX_FIELD__\n",
		}));
		const transport = new LocalTmuxTransport({ runner });

		await expect(transport.status("session")).resolves.toEqual({
			exists: true,
			paneId: "%13",
			currentCommand: "bash",
			cursorY: 4,
			dead: false,
			exitCode: undefined,
		});
	});

	it("rejects NUL without invoking tmux", async () => {
		const runner = vi.fn<LocalTmuxTransportRunner>(async () => ok());
		const transport = new LocalTmuxTransport({ runner });

		await expect(transport.sendSensitive("%7", Buffer.from([0]))).rejects.toThrow("NUL");
		expect(runner).not.toHaveBeenCalled();
	});
});
