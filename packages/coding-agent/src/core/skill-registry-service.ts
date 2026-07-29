import { createHash, randomUUID } from "node:crypto";
import {
	cpSync,
	type Dirent,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { parseGitUrl } from "../utils/git.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import { DefaultPackageManager } from "./package-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import {
	formatSkillSource,
	getSkillRegistryScopePaths,
	loadSkillRegistry,
	resolveSkillRegistryProjection,
	SKILL_REGISTRY_VERSION,
	type SkillRegistryDiagnostic,
	type SkillRegistryEntry,
	type SkillRegistryFile,
	type SkillRegistryProjection,
	type SkillRegistryScope,
	type SkillRegistryScopePaths,
	type SkillSource,
	type SkillValidationResult,
	validateSkillRegistryEntry,
	writeSkillRegistry,
} from "./skill-registry.ts";
import { validateSkillName } from "./skills.ts";

const MAX_URL_SKILL_BYTES = 2 * 1024 * 1024;
const MAX_REMOTE_SKILL_ENTRIES = 10_000;
const PREVIEW_CHARACTER_LIMIT = 1600;
const REMOTE_COPY_EXCLUDED_SEGMENTS = new Set([".git", "node_modules"]);

type RemoteSkillSource = Extract<SkillSource, { type: "git" | "npm" | "url" }>;

export interface SkillRemoteFetchResult {
	rootPath: string;
	pinnedRef?: string;
	sha256?: string;
}

export interface SkillRemoteFetcher {
	fetch(source: RemoteSkillSource, stagingRoot: string): Promise<SkillRemoteFetchResult>;
}

export interface SkillSecurityReview {
	action: "import" | "update";
	source: SkillSource;
	scope: SkillRegistryScope;
	name: string;
	targetPath: string;
	preview: string;
	previewTruncated: boolean;
	pinnedRef?: string;
	sha256?: string;
	validation: SkillValidationResult;
}

export type SkillSecurityReviewConfirmation = (review: SkillSecurityReview) => Promise<boolean>;

export interface SkillRegistryServiceOptions {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean | (() => boolean);
	/** Names currently visible through ResourceLoader, used to reject native collisions before import. */
	getCurrentSkillNames?: () => ReadonlySet<string>;
	/** Current discovered path by name; an import may register that same source without treating it as a collision. */
	getCurrentSkillPaths?: () => ReadonlyMap<string, string>;
	settingsManager?: SettingsManager;
	remoteFetcher?: SkillRemoteFetcher;
	now?: () => number;
	createId?: () => string;
}

export interface SkillRegistryImportResult {
	entry: SkillRegistryEntry;
	validation: SkillValidationResult;
	managedPath: string;
}

export interface SkillRegistryRemoveResult {
	entry: SkillRegistryEntry;
	managedPath?: string;
}

export interface SkillRegistryMutationResult {
	changed: boolean;
	entry?: SkillRegistryEntry;
	validation?: SkillValidationResult;
}

export class SkillRegistryServiceError extends Error {
	readonly diagnostics: SkillRegistryDiagnostic[];

	constructor(message: string, diagnostics: SkillRegistryDiagnostic[] = []) {
		super(message);
		this.name = "SkillRegistryServiceError";
		this.diagnostics = diagnostics;
	}
}

interface LoadedScope {
	scope: SkillRegistryScope;
	registry: SkillRegistryFile;
	paths: SkillRegistryScopePaths;
}

interface ImportFrontmatter extends Record<string, unknown> {
	name?: unknown;
	description?: unknown;
}

interface PreparedSkill {
	sourceDir: string;
	source: SkillSource;
	scope: SkillRegistryScope;
	name: string;
	paths: SkillRegistryScopePaths;
	managedPath: string;
	validation: SkillValidationResult;
	preview: string;
	previewTruncated: boolean;
	pinnedRef?: string;
	sha256?: string;
	stagingRoot?: string;
}

function isPathInside(target: string, root: string): boolean {
	const relativePath = relative(root, target);
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	);
}

function formatDiagnostic(diagnostic: SkillRegistryDiagnostic): string {
	return `${diagnostic.code}: ${diagnostic.message}`;
}

function mutationDiagnostic(
	code: SkillRegistryDiagnostic["code"],
	severity: SkillRegistryDiagnostic["severity"],
	message: string,
	options: Omit<SkillRegistryDiagnostic, "code" | "severity" | "message"> = {},
): SkillRegistryDiagnostic {
	return { code, severity, message, ...options };
}

function throwMutationError(message: string, diagnostics: SkillRegistryDiagnostic[] = []): never {
	const suffix = diagnostics.length > 0 ? ` (${diagnostics.map(formatDiagnostic).join("; ")})` : "";
	throw new SkillRegistryServiceError(`${message}${suffix}`, diagnostics);
}

function isMalformed(load: ReturnType<typeof loadSkillRegistry>): boolean {
	return load.diagnostics.some((item) => item.code === "registry_malformed");
}

function getManagedSkillRoot(resolvedPath: string, managedSkillsDir: string): string | undefined {
	const root = resolvedPath.endsWith(`${sep}SKILL.md`) ? dirname(resolvedPath) : resolvedPath;
	const resolvedRoot = resolve(root);
	const resolvedManagedDir = resolve(managedSkillsDir);
	if (resolvedRoot === resolvedManagedDir || !isPathInside(resolvedRoot, resolvedManagedDir)) {
		return undefined;
	}
	return resolvedRoot;
}

function getImportDirectory(sourcePath: string): string {
	try {
		const stats = statSync(sourcePath);
		if (stats.isDirectory()) return sourcePath;
		if (stats.isFile() && basename(sourcePath) === "SKILL.md") return dirname(sourcePath);
	} catch {
		// The caller reports a structured missing-source diagnostic below.
	}
	return sourcePath;
}

function getExternalHarness(sourcePath: string): "claude" | "codex" | undefined {
	const home = resolvePath("~");
	const candidates = [
		{ harness: "claude" as const, root: join(home, ".claude", "skills") },
		{ harness: "codex" as const, root: join(home, ".codex", "skills") },
	];
	const resolvedSource = canonicalizePath(resolve(sourcePath));
	return candidates.find(({ root }) => isPathInside(resolvedSource, canonicalizePath(resolve(root))))?.harness;
}

function isSafeSubdirectory(value: string): boolean {
	return (
		value !== "" &&
		!isAbsolute(value) &&
		!value.includes("\\") &&
		!value.split("/").some((segment) => segment === "" || segment === "..")
	);
}

function isLocalSkillSource(value: string): boolean {
	if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
	const scheme = value.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/i)?.[1]?.toLowerCase();
	return scheme === undefined || (scheme === "file" && /^file:\/\//i.test(value));
}

function splitRemoteSubdirectory(value: string): { source: string; subdirectory?: string } {
	const separator = value.indexOf("#");
	if (separator === -1) return { source: value };
	const subdirectory = value.slice(separator + 1).trim();
	if (!isSafeSubdirectory(subdirectory)) {
		throwMutationError(`Remote Skill subdirectory is unsafe: ${JSON.stringify(subdirectory)}`, [
			mutationDiagnostic(
				"source_subdirectory_invalid",
				"error",
				`Remote Skill subdirectory is unsafe: ${JSON.stringify(subdirectory)}`,
			),
		]);
	}
	return { source: value.slice(0, separator), subdirectory };
}

function parseNpmSkillSource(input: string): Extract<SkillSource, { type: "npm" }> {
	const split = splitRemoteSubdirectory(input.slice("npm:".length).trim());
	const spec = split.source.trim();
	let packageName = spec;
	let version: string | undefined;
	if (spec.startsWith("@")) {
		const slash = spec.indexOf("/");
		const separator = slash === -1 ? -1 : spec.indexOf("@", slash);
		if (separator !== -1) {
			packageName = spec.slice(0, separator);
			version = spec.slice(separator + 1);
		}
	} else {
		const separator = spec.lastIndexOf("@");
		if (separator > 0) {
			packageName = spec.slice(0, separator);
			version = spec.slice(separator + 1);
		}
	}
	if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName) || version === "") {
		throwMutationError(`Invalid npm Skill source: ${JSON.stringify(input)}`, [
			mutationDiagnostic("source_invalid", "error", `Invalid npm package or version: ${JSON.stringify(spec)}`, {
				source: { type: "npm", package: packageName || spec },
			}),
		]);
	}
	return {
		type: "npm",
		package: packageName,
		...(version ? { version } : {}),
		...(split.subdirectory ? { subdirectory: split.subdirectory } : {}),
	};
}

export function parseRemoteSkillSource(input: string): RemoteSkillSource {
	const trimmed = input.trim();
	if (/^git:/i.test(trimmed)) {
		const split = splitRemoteSubdirectory(`git:${trimmed.slice("git:".length)}`);
		const parsed = parseGitUrl(split.source);
		if (!parsed) {
			throwMutationError(`Invalid Git Skill source: ${JSON.stringify(input)}`, [
				mutationDiagnostic("source_invalid", "error", `Invalid Git Skill source: ${JSON.stringify(input)}`),
			]);
		}
		return {
			type: "git",
			repository: parsed.repo,
			...(parsed.ref ? { ref: parsed.ref } : {}),
			...(split.subdirectory ? { subdirectory: split.subdirectory } : {}),
		};
	}
	if (/^npm:/i.test(trimmed)) return parseNpmSkillSource(`npm:${trimmed.slice("npm:".length)}`);

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throwMutationError(`Unsupported remote Skill source: ${JSON.stringify(input)}`, [
			mutationDiagnostic("source_invalid", "error", "Remote Skill sources must use git:, npm:, or HTTPS"),
		]);
	}
	if (url.protocol !== "https:") {
		throwMutationError(`URL Skill sources must use HTTPS: ${JSON.stringify(input)}`, [
			mutationDiagnostic("source_invalid", "error", `URL Skill source scheme is not allowed: ${url.protocol}`, {
				source: { type: "url", url: trimmed },
			}),
		]);
	}
	return { type: "url", url: url.toString() };
}

function toPackageManagerSource(source: Extract<SkillSource, { type: "git" | "npm" }>): string {
	if (source.type === "git") {
		return `git:${source.repository}${source.ref ? `@${source.ref}` : ""}`;
	}
	return `npm:${source.package}${source.version ? `@${source.version}` : ""}`;
}

function findSkillCandidates(root: string): string[] {
	const candidates: string[] = [];
	const visit = (directory: string): void => {
		if (existsSync(join(directory, "SKILL.md"))) {
			try {
				if (statSync(join(directory, "SKILL.md")).isFile()) candidates.push(directory);
			} catch {}
			return;
		}
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") continue;
			visit(join(directory, entry.name));
		}
	};
	visit(root);
	return candidates.sort();
}

function selectSkillDirectory(root: string, source: RemoteSkillSource): string {
	const subdirectory = source.type === "url" ? undefined : source.subdirectory;
	if (subdirectory) {
		if (!isSafeSubdirectory(subdirectory)) {
			throwMutationError(`Remote Skill subdirectory is unsafe: ${JSON.stringify(subdirectory)}`, [
				mutationDiagnostic(
					"source_subdirectory_invalid",
					"error",
					`Remote Skill subdirectory is unsafe: ${JSON.stringify(subdirectory)}`,
					{ source },
				),
			]);
		}
		const candidate = resolve(root, subdirectory);
		if (!isPathInside(candidate, resolve(root))) {
			throwMutationError(`Remote Skill subdirectory escapes the fetched source: ${subdirectory}`, [
				mutationDiagnostic(
					"source_subdirectory_invalid",
					"error",
					`Remote Skill subdirectory escapes the fetched source: ${subdirectory}`,
					{ source, path: candidate },
				),
			]);
		}
		const directory = getImportDirectory(candidate);
		if (!existsSync(join(directory, "SKILL.md"))) {
			throwMutationError(`Fetched source does not contain a Skill at ${subdirectory}`, [
				mutationDiagnostic(
					"skill_candidate_missing",
					"error",
					`Fetched source does not contain SKILL.md at ${subdirectory}`,
					{ source, path: directory },
				),
			]);
		}
		return directory;
	}

	const candidates = findSkillCandidates(root);
	if (candidates.length === 0) {
		throwMutationError("Fetched source does not contain a Skill", [
			mutationDiagnostic("skill_candidate_missing", "error", "Fetched source does not contain SKILL.md", {
				source,
				path: root,
			}),
		]);
	}
	if (candidates.length > 1) {
		const names = candidates.map((candidate) => relative(root, candidate).split(sep).join("/") || ".");
		throwMutationError(`Fetched source contains multiple Skills: ${names.join(", ")}`, [
			mutationDiagnostic(
				"skill_candidate_ambiguous",
				"error",
				`Fetched source contains multiple Skills; specify a subdirectory: ${names.join(", ")}`,
				{ source, path: root },
			),
		]);
	}
	return candidates[0]!;
}

function sourceWithSelectedSubdirectory(source: RemoteSkillSource, root: string, selected: string): RemoteSkillSource {
	if (source.type === "url") return source;
	const subdirectory = relative(root, selected).split(sep).join("/");
	if (!subdirectory) return source;
	return { ...source, subdirectory };
}

function getPreview(content: string): { preview: string; previewTruncated: boolean } {
	if (content.length <= PREVIEW_CHARACTER_LIMIT) return { preview: content, previewTruncated: false };
	return { preview: content.slice(0, PREVIEW_CHARACTER_LIMIT), previewTruncated: true };
}

function getRemoteRelativeSegments(root: string, candidate: string): string[] {
	const relativePath = relative(root, candidate);
	return relativePath ? relativePath.split(sep) : [];
}

function shouldCopyRemoteSkillPath(root: string, candidate: string): boolean {
	return !getRemoteRelativeSegments(root, candidate).some((segment) => REMOTE_COPY_EXCLUDED_SEGMENTS.has(segment));
}

function assertRemoteSourceTreeSafe(root: string, scope: SkillRegistryScope, source: RemoteSkillSource): void {
	if (lstatSync(root).isSymbolicLink()) {
		throwMutationError("Remote Skill root cannot be a symbolic link", [
			mutationDiagnostic("source_symlink_unsupported", "error", "Remote Skill root cannot be a symbolic link", {
				scope,
				source,
				path: root,
			}),
		]);
	}

	let visitedEntries = 0;
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const fullPath = join(directory, entry.name);
			if (!shouldCopyRemoteSkillPath(root, fullPath)) continue;
			visitedEntries += 1;
			if (visitedEntries > MAX_REMOTE_SKILL_ENTRIES) {
				throwMutationError(`Remote Skill exceeds ${MAX_REMOTE_SKILL_ENTRIES} files and directories`, [
					mutationDiagnostic(
						"source_too_large",
						"error",
						`Remote Skill exceeds ${MAX_REMOTE_SKILL_ENTRIES} files and directories`,
						{ scope, source, path: root },
					),
				]);
			}
			if (entry.isSymbolicLink()) {
				throwMutationError(`Remote Skill contains a symbolic link: ${fullPath}`, [
					mutationDiagnostic(
						"source_symlink_unsupported",
						"error",
						"Remote Skills cannot contain symbolic links",
						{ scope, source, path: fullPath },
					),
				]);
			}
			if (entry.isDirectory()) visit(fullPath);
		}
	};
	visit(root);
}

class DefaultSkillRemoteFetcher implements SkillRemoteFetcher {
	private readonly packageManager: DefaultPackageManager;

	constructor(options: { cwd: string; agentDir: string; settingsManager: SettingsManager }) {
		this.packageManager = new DefaultPackageManager(options);
	}

	async fetch(source: RemoteSkillSource, stagingRoot: string): Promise<SkillRemoteFetchResult> {
		if (source.type === "git" || source.type === "npm") {
			const staged = await this.packageManager.stagePackageSource(toPackageManagerSource(source), stagingRoot);
			return {
				rootPath: staged.path,
				...(staged.pinnedRef ? { pinnedRef: staged.pinnedRef } : {}),
			};
		}

		const response = await fetch(source.url, {
			redirect: "error",
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			throw new Error(`HTTPS download failed with ${response.status} ${response.statusText}`.trim());
		}
		const contentLength = Number(response.headers.get("content-length"));
		if (Number.isFinite(contentLength) && contentLength > MAX_URL_SKILL_BYTES) {
			throw new Error(`HTTPS Skill exceeds ${MAX_URL_SKILL_BYTES} bytes`);
		}
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.length > MAX_URL_SKILL_BYTES) {
			throw new Error(`HTTPS Skill exceeds ${MAX_URL_SKILL_BYTES} bytes`);
		}
		const rootPath = join(stagingRoot, "url-skill");
		mkdirSync(rootPath, { recursive: true, mode: 0o700 });
		writeFileSync(join(rootPath, "SKILL.md"), bytes, { mode: 0o600 });
		return {
			rootPath,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		};
	}
}

export class SkillRegistryService {
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly projectTrusted: boolean | (() => boolean);
	private readonly getCurrentSkillNames: () => ReadonlySet<string>;
	private readonly getCurrentSkillPaths: () => ReadonlyMap<string, string>;
	private readonly settingsManager: SettingsManager | undefined;
	private readonly configuredRemoteFetcher: SkillRemoteFetcher | undefined;
	private readonly now: () => number;
	private readonly createId: () => string;
	private defaultRemoteFetcher: SkillRemoteFetcher | undefined;

	constructor(options: SkillRegistryServiceOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.projectTrusted = options.projectTrusted;
		this.getCurrentSkillNames = options.getCurrentSkillNames ?? (() => new Set<string>());
		this.getCurrentSkillPaths = options.getCurrentSkillPaths ?? (() => new Map<string, string>());
		this.settingsManager = options.settingsManager;
		this.configuredRemoteFetcher = options.remoteFetcher;
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? randomUUID;
	}

	isProjectTrusted(): boolean {
		return typeof this.projectTrusted === "function" ? this.projectTrusted() : this.projectTrusted;
	}

	getSnapshot(): SkillRegistryProjection {
		return resolveSkillRegistryProjection({
			cwd: this.cwd,
			agentDir: this.agentDir,
			projectTrusted: this.isProjectTrusted(),
		});
	}

	list(search?: string): SkillRegistryProjection["records"] {
		const records = this.getSnapshot().records;
		const query = search?.trim().toLowerCase();
		if (!query) return records;
		return records.filter((record) => {
			const diagnosticText = [...record.entry.diagnostics, ...record.validation.diagnostics]
				.map((item) => item.message)
				.join(" ");
			return [record.entry.name, record.entry.scope, record.entry.path, diagnosticText]
				.join(" ")
				.toLowerCase()
				.includes(query);
		});
	}

	async importSource(
		source: string,
		scope: SkillRegistryScope,
		confirm: SkillSecurityReviewConfirmation,
	): Promise<SkillRegistryImportResult | undefined> {
		const trimmed = source.trim();
		if (isLocalSkillSource(trimmed)) {
			const prepared = this.prepareLocal(trimmed, scope);
			if (!(await confirm(this.createSecurityReview("import", prepared)))) return undefined;
			return this.commitNewSkill(prepared, false);
		}

		this.requireTrusted(scope);
		const remoteSource = parseRemoteSkillSource(trimmed);
		const prepared = await this.prepareRemote(remoteSource, scope);
		try {
			if (!(await confirm(this.createSecurityReview("import", prepared)))) return undefined;
			return this.commitNewSkill(prepared, true);
		} finally {
			if (prepared.stagingRoot) rmSync(prepared.stagingRoot, { recursive: true, force: true });
		}
	}

	async importLocal(source: string, scope: SkillRegistryScope = "user"): Promise<SkillRegistryImportResult> {
		return this.commitNewSkill(this.prepareLocal(source, scope), false);
	}

	async update(
		name: string,
		confirm: SkillSecurityReviewConfirmation,
	): Promise<SkillRegistryImportResult | undefined> {
		const { loaded, entry } = this.findUniqueEntry(name);
		if (entry.source.type === "local" || entry.source.type === "external-directory") {
			throwMutationError(`Skill ${JSON.stringify(entry.name)} does not have an updateable remote source`, [
				mutationDiagnostic(
					"source_update_unavailable",
					"error",
					`Skill source ${formatSkillSource(entry.source)} does not support updates`,
					{ scope: entry.scope, entryId: entry.id, name: entry.name, source: entry.source },
				),
			]);
		}
		this.requireTrusted(entry.scope);
		const prepared = await this.prepareRemote(entry.source, entry.scope, entry);
		try {
			if (!(await confirm(this.createSecurityReview("update", prepared)))) return undefined;
			return this.commitUpdatedSkill(loaded, entry, prepared);
		} finally {
			if (prepared.stagingRoot) rmSync(prepared.stagingRoot, { recursive: true, force: true });
		}
	}

	setEnabled(name: string, enabled: boolean): SkillRegistryMutationResult {
		const { loaded, entry } = this.findUniqueEntry(name);
		if (entry.enabled === enabled) {
			return { changed: false, entry };
		}
		const updatedEntry: SkillRegistryEntry = { ...entry, enabled, updatedAt: this.now() };
		this.writeScope(
			loaded.scope,
			loaded.registry.entries.map((candidate) => (candidate.id === entry.id ? updatedEntry : candidate)),
		);
		return { changed: true, entry: updatedEntry };
	}

	validate(name?: string): SkillRegistryMutationResult[] {
		const scopes = this.loadMutationScopes();
		const results: SkillRegistryMutationResult[] = [];
		for (const loaded of scopes) {
			const selected = name
				? loaded.registry.entries.filter((entry) => entry.name === name.trim())
				: loaded.registry.entries;
			if (name && selected.length === 0) continue;
			const updatedEntries = loaded.registry.entries.map((entry) => {
				if (!selected.some((candidate) => candidate.id === entry.id)) return entry;
				const paths = getSkillRegistryScopePaths({ scope: loaded.scope, cwd: this.cwd, agentDir: this.agentDir });
				const validation = validateSkillRegistryEntry({
					entry,
					paths,
					projectTrusted: this.isProjectTrusted(),
				});
				const updatedEntry = { ...entry, diagnostics: validation.diagnostics, updatedAt: this.now() };
				results.push({ changed: true, entry: updatedEntry, validation });
				return updatedEntry;
			});
			if (selected.length > 0) this.writeScope(loaded.scope, updatedEntries);
		}
		if (name && results.length === 0) {
			throwMutationError(`Skill ${JSON.stringify(name.trim())} is not registered`);
		}
		return results;
	}

	remove(name: string): SkillRegistryRemoveResult {
		const { loaded, entry } = this.findUniqueEntry(name);
		const paths = getSkillRegistryScopePaths({ scope: loaded.scope, cwd: this.cwd, agentDir: this.agentDir });
		this.writeScope(
			loaded.scope,
			loaded.registry.entries.filter((candidate) => candidate.id !== entry.id),
		);
		return {
			entry,
			managedPath: getManagedSkillRoot(resolve(paths.baseDir, entry.path), paths.managedSkillsDir),
		};
	}

	deleteManagedFiles(result: SkillRegistryRemoveResult): void {
		if (!result.managedPath) return;
		this.requireTrusted(result.entry.scope);
		const paths = getSkillRegistryScopePaths({
			scope: result.entry.scope,
			cwd: this.cwd,
			agentDir: this.agentDir,
		});
		const managedPath = getManagedSkillRoot(result.managedPath, paths.managedSkillsDir);
		if (!managedPath) {
			throwMutationError("Refusing to delete a skill outside the managed skills directory");
		}
		rmSync(managedPath, { recursive: true, force: true });
	}

	private getRemoteFetcher(): SkillRemoteFetcher {
		if (this.configuredRemoteFetcher) return this.configuredRemoteFetcher;
		if (this.defaultRemoteFetcher) return this.defaultRemoteFetcher;
		if (!this.settingsManager) {
			throwMutationError("Remote Skill import requires the current SettingsManager");
		}
		this.defaultRemoteFetcher = new DefaultSkillRemoteFetcher({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
		});
		return this.defaultRemoteFetcher;
	}

	private prepareLocal(source: string, scope: SkillRegistryScope): PreparedSkill {
		this.requireTrusted(scope);
		const sourcePath = resolvePath(source, this.cwd, { trim: true });
		const sourceDir = getImportDirectory(sourcePath);
		if (!existsSync(sourceDir)) {
			throwMutationError(`Skill source does not exist: ${sourcePath}`, [
				mutationDiagnostic("source_missing", "error", `Skill source does not exist: ${sourcePath}`, {
					scope,
					path: sourcePath,
				}),
			]);
		}
		return this.inspectPreparedSkill({
			sourceDir,
			source: this.getImportSource(sourceDir),
			scope,
		});
	}

	private async prepareRemote(
		source: RemoteSkillSource,
		scope: SkillRegistryScope,
		existingEntry?: SkillRegistryEntry,
	): Promise<PreparedSkill> {
		this.requireTrusted(scope);
		const stagingRoot = mkdtempSync(join(tmpdir(), "beaupi-skill-stage-"));
		let fetched: SkillRemoteFetchResult;
		try {
			fetched = await this.getRemoteFetcher().fetch(source, stagingRoot);
		} catch (error) {
			rmSync(stagingRoot, { recursive: true, force: true });
			if (error instanceof SkillRegistryServiceError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throwMutationError(`Failed to fetch ${formatSkillSource(source)}: ${message}`, [
				mutationDiagnostic("source_fetch_failed", "error", message, { scope, source }),
			]);
		}

		try {
			const fetchedRoot = resolve(fetched.rootPath);
			if (!isPathInside(canonicalizePath(fetchedRoot), canonicalizePath(resolve(stagingRoot)))) {
				throwMutationError("Remote fetcher returned a path outside its staging directory", [
					mutationDiagnostic(
						"source_invalid",
						"error",
						"Remote fetcher returned a path outside its staging directory",
						{ scope, source, path: fetchedRoot },
					),
				]);
			}
			if (!existsSync(fetchedRoot)) {
				throwMutationError("Remote fetcher did not produce a staged source", [
					mutationDiagnostic("source_fetch_failed", "error", "Remote fetcher did not produce a staged source", {
						scope,
						source,
						path: fetchedRoot,
					}),
				]);
			}

			let resolvedSource: RemoteSkillSource = source;
			if (source.type === "url") {
				if (!fetched.sha256 || !/^[0-9a-f]{64}$/i.test(fetched.sha256)) {
					throwMutationError("HTTPS Skill fetch did not produce a SHA-256 pin", [
						mutationDiagnostic("sha256_invalid", "error", "HTTPS Skill fetch did not produce a SHA-256 pin", {
							scope,
							source,
						}),
					]);
				}
				resolvedSource = { ...source, sha256: fetched.sha256 };
			}
			const selectedDir = selectSkillDirectory(fetchedRoot, resolvedSource);
			resolvedSource = sourceWithSelectedSubdirectory(resolvedSource, fetchedRoot, selectedDir);
			assertRemoteSourceTreeSafe(selectedDir, scope, resolvedSource);
			const prepared = this.inspectPreparedSkill({
				sourceDir: selectedDir,
				source: resolvedSource,
				scope,
				...(existingEntry ? { existingEntry } : {}),
				...(fetched.pinnedRef ? { pinnedRef: fetched.pinnedRef } : {}),
				...(fetched.sha256 ? { sha256: fetched.sha256 } : {}),
			});
			if (!prepared.validation.valid) {
				throwMutationError(
					`Fetched Skill ${JSON.stringify(prepared.name)} failed validation`,
					prepared.validation.diagnostics,
				);
			}
			return { ...prepared, stagingRoot };
		} catch (error) {
			rmSync(stagingRoot, { recursive: true, force: true });
			throw error;
		}
	}

	private inspectPreparedSkill(options: {
		sourceDir: string;
		source: SkillSource;
		scope: SkillRegistryScope;
		existingEntry?: SkillRegistryEntry;
		pinnedRef?: string;
		sha256?: string;
	}): PreparedSkill {
		const skillFilePath = join(options.sourceDir, "SKILL.md");
		let rawContent: string;
		let frontmatter: ImportFrontmatter;
		try {
			rawContent = readFileSync(skillFilePath, "utf-8");
			frontmatter = parseFrontmatter<ImportFrontmatter>(rawContent).frontmatter;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throwMutationError(`Failed to read Skill source: ${message}`, [
				mutationDiagnostic(
					existsSync(skillFilePath) ? "frontmatter_invalid" : "skill_file_missing",
					"error",
					message,
					{
						scope: options.scope,
						path: skillFilePath,
						source: options.source,
					},
				),
			]);
		}

		const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
		if (!name) {
			throwMutationError("Skill import requires a SKILL.md frontmatter name", [
				mutationDiagnostic("name_required", "error", "SKILL.md frontmatter name is required", {
					scope: options.scope,
					path: skillFilePath,
					source: options.source,
				}),
			]);
		}
		const nameErrors = validateSkillName(name);
		if (nameErrors.length > 0) {
			throwMutationError(`Cannot import Skill ${JSON.stringify(name)}: ${nameErrors.join("; ")}`, [
				...nameErrors.map((message) =>
					mutationDiagnostic("name_invalid", "error", message, {
						scope: options.scope,
						name,
						path: skillFilePath,
						source: options.source,
					}),
				),
			]);
		}
		if (options.existingEntry && options.existingEntry.name !== name) {
			throwMutationError(`Updated Skill name changed from ${options.existingEntry.name} to ${name}`, [
				mutationDiagnostic(
					"name_mismatch",
					"error",
					`Updated Skill name ${JSON.stringify(name)} does not match Registry name ${JSON.stringify(options.existingEntry.name)}`,
					{
						scope: options.scope,
						name,
						entryId: options.existingEntry.id,
						path: skillFilePath,
						source: options.source,
					},
				),
			]);
		}

		const paths = getSkillRegistryScopePaths({ scope: options.scope, cwd: this.cwd, agentDir: this.agentDir });
		const managedPath = options.existingEntry
			? getManagedSkillRoot(resolve(paths.baseDir, options.existingEntry.path), paths.managedSkillsDir)
			: join(paths.managedSkillsDir, name);
		if (!managedPath) {
			throwMutationError("Remote Skill update target is outside the managed skills directory", [
				mutationDiagnostic(
					"skill_path_invalid",
					"error",
					"Remote Skill update target is outside the managed skills directory",
					{ scope: options.scope, name, source: options.source },
				),
			]);
		}

		this.assertNameAvailable(name, options.sourceDir, options.source, options.existingEntry);
		if (!options.existingEntry && existsSync(managedPath)) {
			throwMutationError(`Managed Skill destination already exists: ${managedPath}`, [
				mutationDiagnostic(
					"skill_path_invalid",
					"error",
					`Managed Skill destination already exists: ${managedPath}`,
					{ scope: options.scope, path: managedPath, source: options.source },
				),
			]);
		}

		const transientEntry: SkillRegistryEntry = {
			id: options.existingEntry?.id ?? "pending-import",
			name,
			source: options.source,
			scope: options.scope,
			path: options.sourceDir,
			enabled: options.existingEntry?.enabled ?? true,
			...(options.pinnedRef ? { pinnedRef: options.pinnedRef } : {}),
			...(options.sha256 ? { sha256: options.sha256 } : {}),
			importedAt: options.existingEntry?.importedAt ?? this.now(),
			...(options.existingEntry?.updatedAt !== undefined ? { updatedAt: options.existingEntry.updatedAt } : {}),
			diagnostics: [],
		};
		const validation = validateSkillRegistryEntry({
			entry: transientEntry,
			paths,
			projectTrusted: this.isProjectTrusted(),
		});
		const preview = getPreview(rawContent);
		return {
			sourceDir: options.sourceDir,
			source: options.source,
			scope: options.scope,
			name,
			paths,
			managedPath,
			validation,
			preview: preview.preview,
			previewTruncated: preview.previewTruncated,
			...(options.pinnedRef ? { pinnedRef: options.pinnedRef } : {}),
			...(options.sha256 ? { sha256: options.sha256 } : {}),
		};
	}

	private createSecurityReview(action: "import" | "update", prepared: PreparedSkill): SkillSecurityReview {
		return {
			action,
			source: prepared.source,
			scope: prepared.scope,
			name: prepared.name,
			targetPath: prepared.managedPath,
			preview: prepared.preview,
			previewTruncated: prepared.previewTruncated,
			...(prepared.pinnedRef ? { pinnedRef: prepared.pinnedRef } : {}),
			...(prepared.sha256 ? { sha256: prepared.sha256 } : {}),
			validation: prepared.validation,
		};
	}

	private commitNewSkill(prepared: PreparedSkill, remote: boolean): SkillRegistryImportResult {
		this.requireTrusted(prepared.scope);
		this.assertNameAvailable(prepared.name, prepared.sourceDir, prepared.source);
		if (existsSync(prepared.managedPath)) {
			throwMutationError(`Managed Skill destination already exists: ${prepared.managedPath}`, [
				mutationDiagnostic(
					"skill_path_invalid",
					"error",
					`Managed Skill destination already exists: ${prepared.managedPath}`,
					{ scope: prepared.scope, path: prepared.managedPath, source: prepared.source },
				),
			]);
		}
		this.copySkillAtomically(prepared.sourceDir, prepared.managedPath, remote);

		const timestamp = this.now();
		const entry: SkillRegistryEntry = {
			id: this.createId(),
			name: prepared.name,
			source: prepared.source,
			scope: prepared.scope,
			path: relative(prepared.paths.baseDir, prepared.managedPath).split(sep).join("/"),
			enabled: true,
			...(prepared.pinnedRef ? { pinnedRef: prepared.pinnedRef } : {}),
			...(prepared.sha256 ? { sha256: prepared.sha256 } : {}),
			importedAt: timestamp,
			...(remote ? { updatedAt: timestamp } : {}),
			diagnostics: [],
		};
		const validation = validateSkillRegistryEntry({
			entry,
			paths: prepared.paths,
			projectTrusted: this.isProjectTrusted(),
		});
		if (remote && !validation.valid) {
			rmSync(prepared.managedPath, { recursive: true, force: true });
			throwMutationError(
				`Fetched Skill ${JSON.stringify(entry.name)} failed validation after staging`,
				validation.diagnostics,
			);
		}
		entry.diagnostics = validation.diagnostics;
		try {
			this.writeScope(prepared.scope, [...this.getLoadedScope(prepared.scope).registry.entries, entry]);
		} catch (error) {
			rmSync(prepared.managedPath, { recursive: true, force: true });
			throw error;
		}
		return { entry, validation, managedPath: prepared.managedPath };
	}

	private commitUpdatedSkill(
		loaded: LoadedScope,
		oldEntry: SkillRegistryEntry,
		prepared: PreparedSkill,
	): SkillRegistryImportResult {
		const managedPath = getManagedSkillRoot(
			resolve(prepared.paths.baseDir, oldEntry.path),
			prepared.paths.managedSkillsDir,
		);
		if (!managedPath || !existsSync(managedPath)) {
			throwMutationError(
				`Managed Skill update target is missing: ${resolve(prepared.paths.baseDir, oldEntry.path)}`,
				[
					mutationDiagnostic("skill_path_missing", "error", "Managed Skill update target is missing", {
						scope: oldEntry.scope,
						entryId: oldEntry.id,
						name: oldEntry.name,
						path: resolve(prepared.paths.baseDir, oldEntry.path),
						source: oldEntry.source,
					}),
				],
			);
		}

		mkdirSync(prepared.paths.managedSkillsDir, { recursive: true, mode: 0o700 });
		const replacementPath = join(prepared.paths.managedSkillsDir, `.${oldEntry.name}.${randomUUID()}.replacement`);
		const backupPath = join(prepared.paths.managedSkillsDir, `.${oldEntry.name}.${randomUUID()}.backup`);
		cpSync(prepared.sourceDir, replacementPath, {
			recursive: true,
			errorOnExist: true,
			force: false,
			verbatimSymlinks: true,
			filter: (sourcePath) => shouldCopyRemoteSkillPath(prepared.sourceDir, sourcePath),
		});

		let movedOld = false;
		try {
			renameSync(managedPath, backupPath);
			movedOld = true;
			renameSync(replacementPath, managedPath);
			const entryWithoutPins = { ...oldEntry };
			delete entryWithoutPins.pinnedRef;
			delete entryWithoutPins.sha256;
			const updatedEntry: SkillRegistryEntry = {
				...entryWithoutPins,
				source: prepared.source,
				...(prepared.pinnedRef ? { pinnedRef: prepared.pinnedRef } : {}),
				...(prepared.sha256 ? { sha256: prepared.sha256 } : {}),
				updatedAt: this.now(),
				diagnostics: [],
			};
			const validation = validateSkillRegistryEntry({
				entry: updatedEntry,
				paths: prepared.paths,
				projectTrusted: this.isProjectTrusted(),
			});
			if (!validation.valid) {
				throw new SkillRegistryServiceError(
					`Updated Skill ${JSON.stringify(updatedEntry.name)} failed validation`,
					validation.diagnostics,
				);
			}
			updatedEntry.diagnostics = validation.diagnostics;
			this.writeScope(
				loaded.scope,
				loaded.registry.entries.map((candidate) => (candidate.id === oldEntry.id ? updatedEntry : candidate)),
			);
			rmSync(backupPath, { recursive: true, force: true });
			return { entry: updatedEntry, validation, managedPath };
		} catch (error) {
			if (existsSync(managedPath)) rmSync(managedPath, { recursive: true, force: true });
			if (movedOld && existsSync(backupPath)) renameSync(backupPath, managedPath);
			throw error;
		} finally {
			rmSync(replacementPath, { recursive: true, force: true });
			rmSync(backupPath, { recursive: true, force: true });
		}
	}

	private copySkillAtomically(sourceDir: string, managedPath: string, remote: boolean): void {
		mkdirSync(dirname(managedPath), { recursive: true, mode: 0o700 });
		const temporaryPath = join(dirname(managedPath), `.${basename(managedPath)}.${randomUUID()}.tmp`);
		try {
			cpSync(sourceDir, temporaryPath, {
				recursive: true,
				errorOnExist: true,
				force: false,
				verbatimSymlinks: true,
				...(remote ? { filter: (sourcePath: string) => shouldCopyRemoteSkillPath(sourceDir, sourcePath) } : {}),
			});
			renameSync(temporaryPath, managedPath);
		} catch (error) {
			rmSync(temporaryPath, { recursive: true, force: true });
			const message = error instanceof Error ? error.message : String(error);
			throwMutationError(`Failed to copy Skill source: ${message}`);
		}
	}

	private assertNameAvailable(
		name: string,
		sourceDir: string,
		source: SkillSource,
		existingEntry?: SkillRegistryEntry,
	): void {
		const loadedScopes = this.loadMutationScopes();
		const existing = loadedScopes.flatMap((loaded) =>
			loaded.registry.entries.filter((entry) => entry.name === name && entry.id !== existingEntry?.id),
		);
		if (existing.length > 0) {
			throwMutationError(`Skill name ${JSON.stringify(name)} is already registered`, [
				mutationDiagnostic("name_conflict", "error", `Skill name ${JSON.stringify(name)} is already registered`, {
					name,
					path: sourceDir,
					relatedEntryId: existing[0]?.id,
					relatedPath: existing[0]?.path,
					source,
				}),
			]);
		}

		const currentSkill = this.getCurrentSkillNames().has(name);
		const currentSkillPath = this.getCurrentSkillPaths().get(name);
		const allowedPaths = new Set([canonicalizePath(join(sourceDir, "SKILL.md"))]);
		if (existingEntry) {
			const paths = getSkillRegistryScopePaths({
				scope: existingEntry.scope,
				cwd: this.cwd,
				agentDir: this.agentDir,
			});
			const resolvedEntryPath = resolve(paths.baseDir, existingEntry.path);
			allowedPaths.add(canonicalizePath(resolvedEntryPath));
			allowedPaths.add(canonicalizePath(join(resolvedEntryPath, "SKILL.md")));
		}
		if (currentSkill && (!currentSkillPath || !allowedPaths.has(canonicalizePath(currentSkillPath)))) {
			throwMutationError(`Skill name ${JSON.stringify(name)} collides with an existing discovered Skill`, [
				mutationDiagnostic(
					"name_conflict",
					"error",
					`Skill name ${JSON.stringify(name)} collides with an existing discovered Skill`,
					{ name, path: sourceDir, source },
				),
			]);
		}
	}

	private getImportSource(sourceDir: string): SkillSource {
		const harness = getExternalHarness(sourceDir);
		return harness ? { type: "external-directory", path: sourceDir, harness } : { type: "local", path: sourceDir };
	}

	private requireTrusted(scope: SkillRegistryScope): void {
		if (scope === "project" && !this.isProjectTrusted()) {
			throwMutationError("Project is not trusted; refusing project Skill Registry mutation", [
				mutationDiagnostic(
					"project_untrusted",
					"error",
					"Project Skill Registry is disabled until the project is trusted",
					{ scope },
				),
			]);
		}
	}

	private loadMutationScopes(): LoadedScope[] {
		if (!this.isProjectTrusted()) {
			const projectPaths = getSkillRegistryScopePaths({ scope: "project", cwd: this.cwd, agentDir: this.agentDir });
			if (existsSync(projectPaths.registryPath)) {
				throwMutationError("Project is not trusted; refusing to load project Skill Registry", [
					mutationDiagnostic(
						"project_untrusted",
						"error",
						"Project Skill Registry is disabled until the project is trusted",
						{ scope: "project", registryPath: projectPaths.registryPath, path: projectPaths.registryPath },
					),
				]);
			}
		}
		return this.isProjectTrusted()
			? [this.getLoadedScope("user"), this.getLoadedScope("project")]
			: [this.getLoadedScope("user")];
	}

	private getLoadedScope(scope: SkillRegistryScope): LoadedScope {
		this.requireTrusted(scope);
		const loaded = loadSkillRegistry({ scope, cwd: this.cwd, agentDir: this.agentDir });
		if (isMalformed(loaded)) {
			throwMutationError(`Cannot mutate malformed ${scope} Skill Registry`, loaded.diagnostics);
		}
		return { scope, registry: loaded.registry, paths: loaded.paths };
	}

	private findUniqueEntry(name: string): { loaded: LoadedScope; entry: SkillRegistryEntry } {
		const normalizedName = name.trim();
		if (!normalizedName) throwMutationError("Skill name is required");
		const matches: Array<{ loaded: LoadedScope; entry: SkillRegistryEntry }> = [];
		for (const loaded of this.loadMutationScopes()) {
			for (const entry of loaded.registry.entries) {
				if (entry.name === normalizedName) matches.push({ loaded, entry });
			}
		}
		if (matches.length === 0) throwMutationError(`Skill ${JSON.stringify(normalizedName)} is not registered`);
		if (matches.length > 1) {
			throwMutationError(`Skill ${JSON.stringify(normalizedName)} is ambiguous across registries`, [
				mutationDiagnostic(
					"name_conflict",
					"error",
					`Skill name ${JSON.stringify(normalizedName)} has multiple Registry entries`,
					{
						name: normalizedName,
						entryId: matches[1]?.entry.id,
						path: matches[1]?.entry.path,
						relatedEntryId: matches[0]?.entry.id,
						relatedPath: matches[0]?.entry.path,
					},
				),
			]);
		}
		return matches[0]!;
	}

	private writeScope(scope: SkillRegistryScope, entries: SkillRegistryEntry[]): void {
		this.requireTrusted(scope);
		writeSkillRegistry({
			scope,
			cwd: this.cwd,
			agentDir: this.agentDir,
			projectTrusted: this.isProjectTrusted(),
			registry: { version: SKILL_REGISTRY_VERSION, entries },
		});
	}
}
