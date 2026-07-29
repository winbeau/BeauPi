import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

type PackageManagerInternals = {
	runNpmCommand(args: string[], options?: { cwd?: string }): Promise<void>;
	runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
	runCommandCapture(
		command: string,
		args: string[],
		options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
	): Promise<string>;
};

describe("DefaultPackageManager safe Skill staging", () => {
	let tempDir: string;
	let manager: DefaultPackageManager;

	beforeEach(() => {
		tempDir = join(tmpdir(), `beaupi-package-stage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		manager = new DefaultPackageManager({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
		});
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("installs npm staging with lifecycle scripts disabled", async () => {
		const internals = manager as unknown as PackageManagerInternals;
		const runNpmCommand = vi.spyOn(internals, "runNpmCommand").mockImplementation(async (args) => {
			expect(args).toContain("--ignore-scripts");
			const prefixIndex = args.indexOf("--prefix");
			const installRoot = args[prefixIndex + 1];
			expect(installRoot).toBeDefined();
			const packagePath = join(installRoot!, "node_modules", "fixture-skill");
			mkdirSync(packagePath, { recursive: true });
			writeFileSync(join(packagePath, "package.json"), JSON.stringify({ name: "fixture-skill", version: "1.0.0" }));
			writeFileSync(join(packagePath, "SKILL.md"), "---\nname: fixture\ndescription: fixture\n---\nBody\n");
		});

		const result = await manager.stagePackageSource("npm:fixture-skill@1.0.0", join(tempDir, "stage"));

		expect(runNpmCommand).toHaveBeenCalledTimes(1);
		expect(result.type).toBe("npm");
		expect(result.pinnedRef).toBe("1.0.0");
		expect(existsSync(join(result.path, "SKILL.md"))).toBe(true);
	});

	it("clones Git into staging without checkout hooks or dependency installation", async () => {
		const internals = manager as unknown as PackageManagerInternals;
		const commands: string[][] = [];
		vi.spyOn(internals, "runCommand").mockImplementation(async (command, args, options) => {
			commands.push([command, ...args]);
			if (command === "git" && args[0] === "clone") {
				const checkoutPath = args[args.length - 1];
				mkdirSync(join(checkoutPath!, "skills", "review"), { recursive: true });
				writeFileSync(join(checkoutPath!, "skills", "review", "SKILL.md"), "Body\n");
			}
			if (options?.cwd && args[0] === "-c") {
				writeFileSync(join(options.cwd, "checked-out.marker"), "checked out without hooks\n");
			}
		});
		vi.spyOn(internals, "runCommandCapture").mockResolvedValue("abc123\n");

		const result = await manager.stagePackageSource("git:github.com/user/repo@main", join(tempDir, "stage"));

		expect(result.type).toBe("git");
		expect(result.pinnedRef).toBe("abc123");
		expect(commands[0]).toEqual([
			"git",
			"clone",
			"--no-checkout",
			"--no-recurse-submodules",
			"https://github.com/user/repo",
			join(tempDir, "stage", "git"),
		]);
		expect(commands.some((command) => command.includes("core.hooksPath=/dev/null"))).toBe(true);
		expect(commands.some((command) => command.includes("npm"))).toBe(false);
	});
});
