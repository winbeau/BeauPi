import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import { WorkflowWorktreeManager } from "../src/core/workflow/index.ts";

const tempDirs: string[] = [];

function digest(value: string, length: number): string {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

async function createRepository(): Promise<string> {
	const repository = await mkdtemp(join(tmpdir(), "beaupi-worktree-test-"));
	tempDirs.push(repository);
	for (const args of [["init"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"]]) {
		expect((await execCommand("git", args, repository)).code).toBe(0);
	}
	await writeFile(join(repository, "README.md"), "test\n");
	expect((await execCommand("git", ["add", "README.md"], repository)).code).toBe(0);
	expect((await execCommand("git", ["commit", "-m", "initial"], repository)).code).toBe(0);
	return repository;
}

afterEach(async () => {
	for (const path of tempDirs.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("WorkflowWorktreeManager", () => {
	it("never deletes a pre-existing deterministic branch when creation fails", async () => {
		const repository = await createRepository();
		const sessionId = "session-preexisting";
		const workflowId = "workflow";
		const nodeId = "node";
		const branch = `beaupi-workflow/${digest(sessionId, 8)}/${workflowId}-${digest(workflowId, 8)}/${nodeId}-${digest(nodeId, 8)}`;
		expect((await execCommand("git", ["branch", branch], repository)).code).toBe(0);
		const manager = new WorkflowWorktreeManager({
			cwd: repository,
			sessionId,
			rootDir: join(repository, ".test-worktrees"),
		});

		await expect(manager.create(workflowId, nodeId)).rejects.toThrow("branch already exists");
		expect((await execCommand("git", ["show-ref", "--verify", `refs/heads/${branch}`], repository)).code).toBe(0);
	});

	it("refuses cleanup through a symlinked managed-path ancestor", async () => {
		const repository = await createRepository();
		const rootDir = join(repository, ".test-worktrees");
		const manager = new WorkflowWorktreeManager({ cwd: repository, sessionId: "session", rootDir });
		const lease = await manager.create("workflow", "node");
		const worktreeParent = dirname(lease.path);
		const movedParent = `${worktreeParent}-moved`;
		const outside = join(repository, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "sentinel"), "keep\n");
		await rename(worktreeParent, movedParent);
		await symlink(outside, worktreeParent, "dir");

		const result = await manager.cleanupNode("workflow", "node");
		expect(result).toMatchObject({ status: "cleanup_failed" });
		expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("keep\n");

		await unlink(worktreeParent);
		await rename(movedParent, worktreeParent);
		expect((await execCommand("git", ["worktree", "remove", "--force", lease.path], repository)).code).toBe(0);
		expect((await execCommand("git", ["branch", "-D", lease.branch], repository)).code).toBe(0);
	});
});
