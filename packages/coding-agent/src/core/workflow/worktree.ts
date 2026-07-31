import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execCommand } from "../exec.ts";
import type { WorkflowDiagnostic, WorkflowWorktreeSnapshot } from "./types.ts";

const GIT_TIMEOUT_MS = 30_000;

export interface WorkflowWorktreeLease {
	workflowId: string;
	nodeId: string;
	repositoryRoot: string;
	path: string;
	branch: string;
	status: "active" | "cleaned" | "cleanup_failed";
	diagnostics: WorkflowDiagnostic[];
}

export interface WorkflowWorktreeManagerOptions {
	cwd: string;
	sessionId: string;
	rootDir?: string;
}

function digest(value: string, length = 12): string {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function safeSegment(value: string): string {
	const normalized = value
		.replace(/[^A-Za-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return normalized || digest(value, 10);
}

function boundedDiagnostic(value: string): string {
	const normalized = value
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return normalized.length > 500 ? `${normalized.slice(0, 499)}…` : normalized;
}

function assertOwnedPath(root: string, target: string): void {
	const relativePath = relative(resolve(root), resolve(target));
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		throw new Error(`Refusing to clean Workflow path outside the managed root: ${target}`);
	}
}

async function assertOwnedPathOnDisk(root: string, target: string): Promise<void> {
	assertOwnedPath(root, target);
	const rootStat = await lstat(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new Error(`Workflow managed root is not a physical directory: ${root}`);
	}
	const targetParent = dirname(target);
	const parentRelative = relative(root, targetParent);
	let current = root;
	for (const segment of parentRelative.split(sep).filter(Boolean)) {
		current = join(current, segment);
		const stat = await lstat(current);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error(`Workflow managed path contains a non-directory or symlink: ${current}`);
		}
	}
	const realRoot = await realpath(root);
	const realParent = await realpath(targetParent);
	const realRelative = relative(realRoot, realParent);
	if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
		throw new Error(`Refusing to clean Workflow path outside the physical managed root: ${target}`);
	}
}

async function removeOwnedPath(root: string, target: string): Promise<void> {
	if (!existsSync(target)) return;
	await assertOwnedPathOnDisk(root, target);
	const stat = await lstat(target);
	if (stat.isSymbolicLink()) {
		await unlink(target);
		return;
	}
	await rm(target, { recursive: true, force: true });
}

function hasOwnedWorktree(output: string, path: string, branch: string): boolean {
	const expectedPath = resolve(path);
	const expectedBranch = `refs/heads/${branch}`;
	return output.split(/\n\n+/).some((block) => {
		let worktreePath: string | undefined;
		let worktreeBranch: string | undefined;
		for (const line of block.split("\n")) {
			if (line.startsWith("worktree ")) worktreePath = resolve(line.slice("worktree ".length));
			if (line.startsWith("branch ")) worktreeBranch = line.slice("branch ".length);
		}
		return worktreePath === expectedPath && worktreeBranch === expectedBranch;
	});
}

export class WorkflowWorktreeManager {
	private readonly cwd: string;
	private readonly sessionId: string;
	private readonly rootDir: string;
	private readonly leases = new Map<string, WorkflowWorktreeLease>();
	private queue: Promise<void> = Promise.resolve();

	constructor(options: WorkflowWorktreeManagerOptions) {
		this.cwd = resolve(options.cwd);
		this.sessionId = options.sessionId;
		this.rootDir = resolve(options.rootDir ?? join(tmpdir(), "beaupi-workflows", digest(this.cwd)));
	}

	async create(workflowId: string, nodeId: string, signal?: AbortSignal): Promise<WorkflowWorktreeLease> {
		return await this.serial(async () => {
			if (signal?.aborted) throw new Error("Workflow Worktree creation was cancelled");
			const repository = await execCommand("git", ["rev-parse", "--show-toplevel"], this.cwd, {
				signal,
				timeout: GIT_TIMEOUT_MS,
			});
			if (repository.code !== 0 || repository.killed || signal?.aborted) {
				throw new Error(
					signal?.aborted
						? "Workflow Worktree creation was cancelled"
						: `Workflow isolated write requires a Git repository: ${boundedDiagnostic(repository.stderr)}`,
				);
			}
			const repositoryRoot = resolve(repository.stdout.trim());
			const workflowSegment = `${safeSegment(workflowId)}-${digest(workflowId, 8)}`;
			const nodeSegment = `${safeSegment(nodeId)}-${digest(nodeId, 8)}`;
			const path = join(this.rootDir, safeSegment(this.sessionId), workflowSegment, nodeSegment);
			assertOwnedPath(this.rootDir, path);
			if (existsSync(path)) throw new Error(`Workflow Worktree path already exists: ${path}`);
			const branch = `beaupi-workflow/${digest(this.sessionId, 8)}/${workflowSegment}/${nodeSegment}`;
			const existingBranch = await execCommand(
				"git",
				["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
				repositoryRoot,
				{ signal, timeout: GIT_TIMEOUT_MS },
			);
			if (existingBranch.code === 0) throw new Error(`Workflow Worktree branch already exists: ${branch}`);
			if (existingBranch.code !== 1 || existingBranch.killed || signal?.aborted) {
				throw new Error(
					signal?.aborted
						? "Workflow Worktree creation was cancelled"
						: `Failed to inspect Workflow Worktree branch: ${boundedDiagnostic(existingBranch.stderr)}`,
				);
			}
			await mkdir(dirname(path), { recursive: true });
			await assertOwnedPathOnDisk(this.rootDir, path);
			const created = await execCommand("git", ["worktree", "add", "-b", branch, path, "HEAD"], repositoryRoot, {
				signal,
				timeout: GIT_TIMEOUT_MS,
			});
			if (created.code !== 0 || created.killed || signal?.aborted) {
				const worktrees = await execCommand("git", ["worktree", "list", "--porcelain"], repositoryRoot, {
					timeout: GIT_TIMEOUT_MS,
				});
				const ownsWorktree = worktrees.code === 0 && hasOwnedWorktree(worktrees.stdout, path, branch);
				if (ownsWorktree) {
					await execCommand("git", ["worktree", "remove", "--force", path], repositoryRoot, {
						timeout: GIT_TIMEOUT_MS,
					});
				}
				await removeOwnedPath(this.rootDir, path);
				await execCommand("git", ["worktree", "prune"], repositoryRoot, { timeout: GIT_TIMEOUT_MS });
				if (ownsWorktree) {
					await execCommand("git", ["branch", "-D", branch], repositoryRoot, { timeout: GIT_TIMEOUT_MS });
				}
				throw new Error(
					signal?.aborted
						? "Workflow Worktree creation was cancelled"
						: `Failed to create Workflow Worktree: ${boundedDiagnostic(created.stderr || created.stdout)}`,
				);
			}
			const lease: WorkflowWorktreeLease = {
				workflowId,
				nodeId,
				repositoryRoot,
				path,
				branch,
				status: "active",
				diagnostics: [],
			};
			this.leases.set(`${workflowId}:${nodeId}`, lease);
			return lease;
		});
	}

	get(workflowId: string, nodeId: string): WorkflowWorktreeLease | undefined {
		return this.leases.get(`${workflowId}:${nodeId}`);
	}

	toSnapshot(lease: WorkflowWorktreeLease, cleanup: WorkflowWorktreeSnapshot["cleanup"]): WorkflowWorktreeSnapshot {
		return {
			path: lease.path,
			branch: lease.branch,
			status: lease.status,
			cleanup,
		};
	}

	async cleanupNode(workflowId: string, nodeId: string): Promise<WorkflowWorktreeLease | undefined> {
		const lease = this.get(workflowId, nodeId);
		if (!lease || lease.status !== "active") return lease;
		await this.cleanupLease(lease);
		return lease;
	}

	async cleanupWorkflow(workflowId: string): Promise<void> {
		const leases = [...this.leases.values()].filter((lease) => lease.workflowId === workflowId);
		for (const lease of leases) await this.cleanupLease(lease);
	}

	async dispose(): Promise<void> {
		for (const lease of [...this.leases.values()]) await this.cleanupLease(lease);
	}

	private async cleanupLease(lease: WorkflowWorktreeLease): Promise<void> {
		await this.serial(async () => {
			if (lease.status !== "active") return;
			try {
				await assertOwnedPathOnDisk(this.rootDir, lease.path);
				const removed = await execCommand(
					"git",
					["worktree", "remove", "--force", lease.path],
					lease.repositoryRoot,
					{ timeout: GIT_TIMEOUT_MS },
				);
				if (removed.code !== 0) {
					lease.diagnostics.push({
						code: "worktree_remove_failed",
						message: boundedDiagnostic(removed.stderr || removed.stdout),
						nodeId: lease.nodeId,
					});
				}
				await removeOwnedPath(this.rootDir, lease.path);
				await execCommand("git", ["worktree", "prune"], lease.repositoryRoot, { timeout: GIT_TIMEOUT_MS });
				const branch = await execCommand("git", ["branch", "-D", lease.branch], lease.repositoryRoot, {
					timeout: GIT_TIMEOUT_MS,
				});
				if (branch.code !== 0 && !/not found|not a valid branch/i.test(branch.stderr)) {
					lease.diagnostics.push({
						code: "worktree_branch_cleanup_failed",
						message: boundedDiagnostic(branch.stderr || branch.stdout),
						nodeId: lease.nodeId,
					});
				}
				lease.status = lease.diagnostics.length > 0 ? "cleanup_failed" : "cleaned";
			} catch (error) {
				lease.status = "cleanup_failed";
				lease.diagnostics.push({
					code: "worktree_cleanup_failed",
					message: error instanceof Error ? error.message : String(error),
					nodeId: lease.nodeId,
				});
			}
		});
	}

	private async serial<T>(operation: () => Promise<T>): Promise<T> {
		let resolveResult!: (value: T | PromiseLike<T>) => void;
		let rejectResult!: (reason?: unknown) => void;
		const result = new Promise<T>((resolve, reject) => {
			resolveResult = resolve;
			rejectResult = reject;
		});
		const previous = this.queue;
		this.queue = result.then(
			() => undefined,
			() => undefined,
		);
		void previous.then(async () => {
			try {
				resolveResult(await operation());
			} catch (error) {
				rejectResult(error);
			}
		});
		return await result;
	}
}
