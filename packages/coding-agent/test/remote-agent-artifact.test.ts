import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	INSTALL_SCRIPT,
	MemoryRemoteAgentArtifactProvider,
	manifestForBytes,
	PROBE_SCRIPT,
	sha256Bytes,
	validateRemoteAgentArtifact,
} from "../src/core/remote-agent/index.ts";

async function runProbe(home: string, digest: string): Promise<Record<string, unknown>> {
	const child = spawn(process.execPath, ["-e", PROBE_SCRIPT, digest], {
		env: { ...process.env, HOME: home },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout: Buffer[] = [];
	child.stdout.on("data", (data: Buffer) => stdout.push(Buffer.from(data)));
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	if (exitCode !== 0) throw new Error(`probe exited ${exitCode}`);
	return JSON.parse(Buffer.concat(stdout).toString("utf8")) as Record<string, unknown>;
}

async function runInstall(home: string, bytes: Buffer, digest: string, manifest: ReturnType<typeof manifestForBytes>) {
	const child = spawn(
		process.execPath,
		[
			"-e",
			INSTALL_SCRIPT,
			digest,
			String(bytes.length),
			Buffer.from(`${JSON.stringify(manifest)}\n`).toString("base64"),
		],
		{
			env: { ...process.env, HOME: home },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", (data: Buffer) => stdout.push(Buffer.from(data)));
	child.stderr.on("data", (data: Buffer) => stderr.push(Buffer.from(data)));
	child.stdin.end(bytes);
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	return { exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

describe("Remote Agent artifact and bootstrap fixture", () => {
	it("produces a self-consistent manifest and atomically reuses an exact artifact", async () => {
		const bytes = Buffer.from("agent-bytes", "utf8");
		const home = await mkdtemp(join(tmpdir(), "beaupi-agent-home-"));
		try {
			const manifest = manifestForBytes(bytes, "test");
			const first = await runInstall(home, bytes, manifest.sha256, manifest);
			expect(first.exitCode).toBe(0);
			const result = JSON.parse(first.stdout) as { artifactPath: string; sha256: string; bytes: number };
			expect(result).toMatchObject({ sha256: sha256Bytes(bytes), bytes: bytes.length });
			expect((await stat(result.artifactPath)).mode & 0o777).toBe(0o600);
			expect(await readFile(result.artifactPath)).toEqual(bytes);
			const second = await runInstall(home, bytes, manifest.sha256, manifest);
			expect(second.exitCode).toBe(0);
			expect(JSON.parse(second.stdout)).toMatchObject({ sha256: manifest.sha256, bytes: bytes.length });
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("makes concurrent first installs converge on one exact artifact", async () => {
		const bytes = Buffer.from("concurrent-agent-bytes", "utf8");
		const manifest = manifestForBytes(bytes, "test");
		const home = await mkdtemp(join(tmpdir(), "beaupi-agent-concurrent-"));
		try {
			const results = await Promise.all([
				runInstall(home, bytes, manifest.sha256, manifest),
				runInstall(home, bytes, manifest.sha256, manifest),
			]);
			expect(results.every((result) => result.exitCode === 0)).toBe(true);
			expect(new Set(results.map((result) => JSON.parse(result.stdout).sha256))).toEqual(new Set([manifest.sha256]));
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("rejects a symlink installation root and mismatched local artifact manifests", async () => {
		const bytes = Buffer.from("agent-bytes", "utf8");
		const home = await mkdtemp(join(tmpdir(), "beaupi-agent-home-"));
		const outside = await mkdtemp(join(tmpdir(), "beaupi-agent-outside-"));
		try {
			await symlink(outside, join(home, ".beaupi"));
			const manifest = manifestForBytes(bytes, "test");
			expect(await runProbe(home, manifest.sha256)).toMatchObject({ artifactPresent: true, artifactSymlink: true });
			const result = await runInstall(home, bytes, manifest.sha256, manifest);
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toContain("agent_install_symlink");
			const bad = { ...manifest, sha256: "0".repeat(64) };
			expect(() => validateRemoteAgentArtifact({ sourcePath: "memory", manifest: bad, bytes })).toThrow(/hash/);
			const provider = new MemoryRemoteAgentArtifactProvider(bytes);
			expect((await provider.load()).manifest.sha256).toBe(sha256Bytes(bytes));
		} finally {
			await rm(home, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});
});
