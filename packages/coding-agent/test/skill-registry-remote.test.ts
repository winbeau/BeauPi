import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { loadSkillRegistry, type SkillSource } from "../src/core/skill-registry.ts";
import {
	parseRemoteSkillSource,
	SkillRegistryService,
	SkillRegistryServiceError,
	type SkillRemoteFetcher,
	type SkillRemoteFetchResult,
	type SkillSecurityReview,
} from "../src/core/skill-registry-service.ts";

function createSkill(root: string, name: string, description = `${name} skill`, body = "Instructions"): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
}

class FakeRemoteFetcher implements SkillRemoteFetcher {
	readonly calls: SkillSource[] = [];
	gitRoot: string | undefined;
	npmRoot: string | undefined;
	urlContent = "---\nname: remote-url\ndescription: URL skill\n---\nURL instructions\n";
	urlSha256: string | undefined;
	failure: Error | undefined;

	async fetch(
		source: Extract<SkillSource, { type: "git" | "npm" | "url" }>,
		stagingRoot: string,
	): Promise<SkillRemoteFetchResult> {
		this.calls.push(source);
		if (this.failure) throw this.failure;
		const root = join(stagingRoot, source.type);
		if (source.type === "git") {
			if (!this.gitRoot) throw new Error("missing fake Git fixture");
			cpSync(this.gitRoot, root, { recursive: true });
			return { rootPath: root, pinnedRef: "git-commit-1" };
		}
		if (source.type === "npm") {
			if (!this.npmRoot) throw new Error("missing fake npm fixture");
			cpSync(this.npmRoot, root, { recursive: true });
			return { rootPath: root, pinnedRef: "1.2.3" };
		}
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "SKILL.md"), this.urlContent);
		const bytes = Buffer.from(this.urlContent);
		this.urlSha256 = createHash("sha256").update(bytes).digest("hex");
		return { rootPath: root, sha256: this.urlSha256 };
	}
}

describe("remote Skill Registry sources", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let fetcher: FakeRemoteFetcher;
	let nextId: number;

	beforeEach(() => {
		tempDir = join(tmpdir(), `beaupi-skill-remote-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		fetcher = new FakeRemoteFetcher();
		nextId = 0;
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createService(
		options: Partial<ConstructorParameters<typeof SkillRegistryService>[0]> = {},
	): SkillRegistryService {
		return new SkillRegistryService({
			cwd,
			agentDir,
			projectTrusted: true,
			remoteFetcher: fetcher,
			now: () => 100 + nextId,
			createId: () => `remote-entry-${++nextId}`,
			...options,
		});
	}

	function confirmReview(reviews: SkillSecurityReview[], confirmed = true) {
		return async (review: SkillSecurityReview): Promise<boolean> => {
			reviews.push(review);
			return confirmed;
		};
	}

	it("parses HTTPS-only URL sources and rejects other remote schemes", () => {
		expect(parseRemoteSkillSource("https://example.com/SKILL.md")).toEqual({
			type: "url",
			url: "https://example.com/SKILL.md",
		});
		expect(parseRemoteSkillSource("git:github.com/user/repo@v1#skills/review")).toEqual({
			type: "git",
			repository: "https://github.com/user/repo",
			ref: "v1",
			subdirectory: "skills/review",
		});
		expect(parseRemoteSkillSource("npm:@team/skills@1.2.3#review")).toEqual({
			type: "npm",
			package: "@team/skills",
			version: "1.2.3",
			subdirectory: "review",
		});

		for (const source of [
			"http://example.com/SKILL.md",
			"file:///tmp/SKILL.md",
			"ssh://example.com/repo",
			"git+https://example.com/repo",
			"npm://example.com/pkg",
		]) {
			expect(() => parseRemoteSkillSource(source)).toThrow(SkillRegistryServiceError);
		}
	});

	it("stages Git ref/subdirectory sources, reviews them, and copies only the selected Skill", async () => {
		const gitRoot = join(tempDir, "git-fixture");
		createSkill(join(gitRoot, "skills", "review"), "review");
		createSkill(join(gitRoot, "skills", "other"), "other");
		writeFileSync(join(gitRoot, "skills", "review", "scripts.sh"), "echo should-not-run\n");
		fetcher.gitRoot = gitRoot;
		const reviews: SkillSecurityReview[] = [];

		const result = await createService().importSource(
			"git:github.com/user/repo@v1#skills/review",
			"user",
			confirmReview(reviews),
		);

		expect(fetcher.calls[0]).toEqual({
			type: "git",
			repository: "https://github.com/user/repo",
			ref: "v1",
			subdirectory: "skills/review",
		});
		expect(result?.entry.source).toEqual({
			type: "git",
			repository: "https://github.com/user/repo",
			ref: "v1",
			subdirectory: "skills/review",
		});
		expect(result?.entry.pinnedRef).toBe("git-commit-1");
		expect(reviews[0]?.preview).toContain("name: review");
		expect(existsSync(join(agentDir, "skills", "review", "SKILL.md"))).toBe(true);
		expect(existsSync(join(agentDir, "skills", "other"))).toBe(false);
	});

	it("imports npm package versions and selected Skill subdirectories without injecting the package root", async () => {
		const npmRoot = join(tempDir, "npm-fixture");
		createSkill(join(npmRoot, "review"), "review");
		writeFileSync(join(npmRoot, "package.json"), JSON.stringify({ name: "fixture", version: "1.2.3" }));
		createSkill(join(npmRoot, "other"), "other");
		fetcher.npmRoot = npmRoot;

		const result = await createService().importSource("npm:@team/skills@1.2.3#review", "user", async () => true);

		expect(fetcher.calls[0]).toEqual({
			type: "npm",
			package: "@team/skills",
			version: "1.2.3",
			subdirectory: "review",
		});
		expect(result?.entry.source).toEqual({
			type: "npm",
			package: "@team/skills",
			version: "1.2.3",
			subdirectory: "review",
		});
		expect(result?.entry.pinnedRef).toBe("1.2.3");
		expect(existsSync(join(agentDir, "skills", "review", "package.json"))).toBe(false);
	});

	it("treats file URLs as local sources and reviews them before copying", async () => {
		const localRoot = join(tempDir, "file-url-local");
		createSkill(localRoot, "file-url-local");
		const source = pathToFileURL(localRoot).href;
		const service = createService();

		expect(await service.importSource(source, "user", async () => false)).toBeUndefined();
		expect(existsSync(join(agentDir, "skills", "file-url-local"))).toBe(false);
		const result = await service.importSource(source, "user", async () => true);
		expect(result?.entry.name).toBe("file-url-local");
	});

	it("rejects remote symbolic links and excludes package caches and Git metadata", async () => {
		const root = join(tempDir, "remote-root");
		createSkill(root, "remote-root");
		mkdirSync(join(root, ".git"), { recursive: true });
		writeFileSync(join(root, ".git", "config"), "metadata");
		mkdirSync(join(root, "node_modules", "ignored"), { recursive: true });
		writeFileSync(join(root, "node_modules", "ignored", "package.js"), "ignored");
		fetcher.gitRoot = root;
		const imported = await createService().importSource("git:github.com/user/repo", "user", async () => true);
		expect(imported).toBeDefined();
		expect(existsSync(join(agentDir, "skills", "remote-root", ".git"))).toBe(false);
		expect(existsSync(join(agentDir, "skills", "remote-root", "node_modules"))).toBe(false);

		const symlinkRoot = join(tempDir, "remote-symlink");
		createSkill(symlinkRoot, "remote-symlink");
		writeFileSync(join(tempDir, "outside.txt"), "outside");
		symlinkSync(join(tempDir, "outside.txt"), join(symlinkRoot, "outside.txt"));
		fetcher.gitRoot = symlinkRoot;
		await expect(
			createService().importSource("git:github.com/user/symlink", "user", async () => true),
		).rejects.toMatchObject({
			diagnostics: [expect.objectContaining({ code: "source_symlink_unsupported" })],
		});
	});

	it("returns structured diagnostics for missing, ambiguous, and nameless remote Skills", async () => {
		const root = join(tempDir, "fixture");
		mkdirSync(root, { recursive: true });
		fetcher.gitRoot = root;
		const service = createService();

		await expect(service.importSource("git:github.com/user/repo", "user", async () => true)).rejects.toMatchObject({
			diagnostics: [expect.objectContaining({ code: "skill_candidate_missing" })],
		});

		createSkill(join(root, "one"), "one");
		createSkill(join(root, "two"), "two");
		await expect(service.importSource("git:github.com/user/repo", "user", async () => true)).rejects.toMatchObject({
			diagnostics: [expect.objectContaining({ code: "skill_candidate_ambiguous" })],
		});
		fetcher.npmRoot = root;
		await expect(service.importSource("npm:@team/skills@1.2.3", "user", async () => true)).rejects.toMatchObject({
			diagnostics: [expect.objectContaining({ code: "skill_candidate_ambiguous" })],
		});

		const nameless = join(tempDir, "nameless");
		mkdirSync(nameless, { recursive: true });
		writeFileSync(join(nameless, "SKILL.md"), "---\ndescription: missing name\n---\nBody\n");
		fetcher.gitRoot = nameless;
		await expect(service.importSource("git:github.com/user/repo", "user", async () => true)).rejects.toMatchObject({
			diagnostics: [expect.objectContaining({ code: "name_required" })],
		});
	});

	it("previews HTTPS content, saves SHA-256 pins, and cleans staging on cancellation", async () => {
		const cancelledReviews: SkillSecurityReview[] = [];
		const cancelled = await createService().importSource(
			"https://example.com/SKILL.md",
			"user",
			confirmReview(cancelledReviews, false),
		);
		expect(cancelled).toBeUndefined();
		expect(cancelledReviews[0]?.preview).toContain("name: remote-url");
		expect(loadSkillRegistry({ scope: "user", cwd, agentDir }).registry.entries).toEqual([]);
		expect(existsSync(join(agentDir, "skills", "remote-url"))).toBe(false);

		const reviews: SkillSecurityReview[] = [];
		const result = await createService().importSource("https://example.com/SKILL.md", "user", confirmReview(reviews));
		const sha256 = createHash("sha256").update(fetcher.urlContent).digest("hex");
		expect(reviews[0]?.sha256).toBe(sha256);
		expect(result?.entry.sha256).toBe(sha256);
		expect(result?.entry.source).toEqual({ type: "url", url: "https://example.com/SKILL.md", sha256 });
		expect(result?.entry.importedAt).toBe(result?.entry.updatedAt);
	});

	it("requires explicit confirmation for trusted project Skill imports", async () => {
		const localRoot = join(tempDir, "project-local");
		createSkill(localRoot, "project-local");
		const reviews: SkillSecurityReview[] = [];
		const service = createService();
		const cancelled = await service.importSource(localRoot, "project", async (review) => {
			reviews.push(review);
			return false;
		});
		expect(cancelled).toBeUndefined();
		expect(reviews[0]?.scope).toBe("project");
		expect(existsSync(join(cwd, CONFIG_DIR_NAME, "skills", "project-local"))).toBe(false);
		const imported = await service.importSource(localRoot, "project", async () => true);
		expect(imported?.entry.scope).toBe("project");
		expect(existsSync(join(cwd, CONFIG_DIR_NAME, "skills", "project-local"))).toBe(true);
	});

	it("rejects Registry and discovery collisions and untrusted project imports", async () => {
		const root = join(tempDir, "collision");
		createSkill(root, "collision");
		fetcher.gitRoot = root;
		await expect(
			createService({ getCurrentSkillNames: () => new Set(["collision"]) }).importSource(
				"git:github.com/user/repo",
				"user",
				async () => true,
			),
		).rejects.toThrow("collides");
		expect(loadSkillRegistry({ scope: "user", cwd, agentDir }).registry.entries).toEqual([]);

		const registered = createService();
		await registered.importSource("git:github.com/user/repo", "user", async () => true);
		await expect(registered.importSource("git:github.com/user/repo", "user", async () => true)).rejects.toThrow(
			"already registered",
		);
		expect(loadSkillRegistry({ scope: "user", cwd, agentDir }).registry.entries).toHaveLength(1);

		const callsBeforeUntrustedImport = fetcher.calls.length;
		const reviews: SkillSecurityReview[] = [];
		const untrusted = createService({ projectTrusted: false });
		await expect(
			untrusted.importSource("git:github.com/user/repo", "project", confirmReview(reviews)),
		).rejects.toMatchObject({ diagnostics: [expect.objectContaining({ code: "project_untrusted" })] });
		expect(fetcher.calls).toHaveLength(callsBeforeUntrustedImport);
	});

	it("keeps the old Skill and Registry entry when an update fails, then updates metadata and reload projection on success", async () => {
		const root = join(tempDir, "update");
		createSkill(root, "review", "old description", "Old instructions");
		fetcher.gitRoot = root;
		const service = createService();
		const initial = await service.importSource("git:github.com/user/repo@main", "user", async () => true);
		const oldContent = readFileSync(join(agentDir, "skills", "review", "SKILL.md"), "utf8");
		const oldEntry = loadSkillRegistry({ scope: "user", cwd, agentDir }).registry.entries[0]!;

		fetcher.failure = new Error("simulated download failure");
		await expect(service.update("review", async () => true)).rejects.toMatchObject({
			diagnostics: [expect.objectContaining({ code: "source_fetch_failed" })],
		});
		expect(readFileSync(join(agentDir, "skills", "review", "SKILL.md"), "utf8")).toBe(oldContent);
		expect(loadSkillRegistry({ scope: "user", cwd, agentDir }).registry.entries[0]).toEqual(oldEntry);
		fetcher.failure = undefined;

		writeFileSync(join(root, "SKILL.md"), "---\nname: review\ndescription: [bad\n---\nBroken\n");
		await expect(service.update("review", async () => true)).rejects.toMatchObject({
			diagnostics: [expect.objectContaining({ code: "frontmatter_invalid" })],
		});
		expect(readFileSync(join(agentDir, "skills", "review", "SKILL.md"), "utf8")).toBe(oldContent);
		expect(loadSkillRegistry({ scope: "user", cwd, agentDir }).registry.entries[0]).toEqual(oldEntry);

		createSkill(root, "review", "new description", "New instructions");
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();
		const updated = await service.update("review", async (review) => review.preview.includes("new description"));
		expect(updated?.entry.id).toBe(initial?.entry.id);
		expect(updated?.entry.updatedAt).toBeGreaterThan(oldEntry.updatedAt ?? oldEntry.importedAt);
		expect(updated?.entry.pinnedRef).toBe("git-commit-1");
		await loader.reload();
		expect(loader.getSkills().skills.find((skill) => skill.name === "review")?.description).toBe("new description");
		expect(loader.getSkills().skills.find((skill) => skill.name === "review")?.filePath).toBe(
			join(agentDir, "skills", "review", "SKILL.md"),
		);
	});

	it("does not update local sources and never executes staged scripts", async () => {
		const root = join(tempDir, "script");
		createSkill(root, "scripted", "scripted skill", "Instructions");
		writeFileSync(join(root, "run.sh"), "touch SHOULD_NOT_EXIST\n");
		fetcher.gitRoot = root;
		const service = createService();
		await service.importSource("git:github.com/user/repo", "user", async (review) => {
			expect(review.validation.inventory.scripts).toContain("run.sh");
			return true;
		});
		expect(existsSync(join(agentDir, "skills", "scripted", "SHOULD_NOT_EXIST"))).toBe(false);

		await expect(service.update("scripted", async () => true)).resolves.toBeDefined();
		const localRoot = join(tempDir, "local");
		createSkill(localRoot, "local");
		await service.importLocal(localRoot);
		await expect(service.update("local", async () => true)).rejects.toMatchObject({
			diagnostics: [expect.objectContaining({ code: "source_update_unavailable" })],
		});
	});

	it("leaves the old version untouched when update confirmation is declined", async () => {
		const root = join(tempDir, "decline");
		createSkill(root, "decline", "old");
		fetcher.gitRoot = root;
		const service = createService();
		await service.importSource("git:github.com/user/repo", "user", async () => true);
		const before = readFileSync(join(agentDir, "skills", "decline", "SKILL.md"), "utf8");
		const result = await service.update("decline", async () => false);
		expect(result).toBeUndefined();
		expect(readFileSync(join(agentDir, "skills", "decline", "SKILL.md"), "utf8")).toBe(before);
		expect(loadSkillRegistry({ scope: "user", cwd, agentDir }).registry.entries[0]?.updatedAt).toBe(100);
	});
});
