import { randomUUID } from "node:crypto";
import { cpSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import {
	getSkillRegistryScopePaths,
	loadSkillRegistry,
	resolveSkillRegistryProjection,
	SKILL_REGISTRY_VERSION,
	type SkillRegistryDiagnostic,
	type SkillRegistryEntry,
	type SkillRegistryFile,
	type SkillRegistryProjection,
	type SkillRegistryScope,
	type SkillSource,
	type SkillValidationResult,
	validateSkillRegistryEntry,
	writeSkillRegistry,
} from "./skill-registry.ts";
import { validateSkillName } from "./skills.ts";

export interface SkillRegistryServiceOptions {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean | (() => boolean);
	/** Names currently visible through ResourceLoader, used to reject native collisions before import. */
	getCurrentSkillNames?: () => ReadonlySet<string>;
	/** Current discovered path by name; an import may register that same source without treating it as a collision. */
	getCurrentSkillPaths?: () => ReadonlyMap<string, string>;
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
	paths: ReturnType<typeof getSkillRegistryScopePaths>;
}

interface ImportFrontmatter extends Record<string, unknown> {
	name?: unknown;
	description?: unknown;
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

export class SkillRegistryService {
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly projectTrusted: boolean | (() => boolean);
	private readonly getCurrentSkillNames: () => ReadonlySet<string>;
	private readonly getCurrentSkillPaths: () => ReadonlyMap<string, string>;
	private readonly now: () => number;
	private readonly createId: () => string;

	constructor(options: SkillRegistryServiceOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.projectTrusted = options.projectTrusted;
		this.getCurrentSkillNames = options.getCurrentSkillNames ?? (() => new Set<string>());
		this.getCurrentSkillPaths = options.getCurrentSkillPaths ?? (() => new Map<string, string>());
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

	async importLocal(source: string, scope: SkillRegistryScope = "user"): Promise<SkillRegistryImportResult> {
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

		const skillFilePath = join(sourceDir, "SKILL.md");
		let frontmatter: ImportFrontmatter;
		try {
			frontmatter = parseFrontmatter<ImportFrontmatter>(readFileSync(skillFilePath, "utf-8")).frontmatter;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throwMutationError(`Failed to read skill source: ${message}`, [
				mutationDiagnostic("frontmatter_invalid", "error", message, { scope, path: skillFilePath }),
			]);
		}

		const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
		if (!name) {
			throwMutationError("Skill import requires a SKILL.md frontmatter name", [
				mutationDiagnostic("name_required", "error", "SKILL.md frontmatter name is required", {
					scope,
					path: skillFilePath,
				}),
			]);
		}
		const nameErrors = validateSkillName(name);
		if (nameErrors.length > 0) {
			throwMutationError(`Cannot import skill ${JSON.stringify(name)}: ${nameErrors.join("; ")}`, [
				...nameErrors.map((message) =>
					mutationDiagnostic("name_invalid", "error", message, { scope, name, path: skillFilePath }),
				),
			]);
		}

		const loadedScopes = this.loadMutationScopes();
		const existing = loadedScopes.flatMap((loaded) => loaded.registry.entries.filter((entry) => entry.name === name));
		if (existing.length > 0) {
			throwMutationError(`Skill name ${JSON.stringify(name)} is already registered`, [
				mutationDiagnostic("name_conflict", "error", `Skill name ${JSON.stringify(name)} is already registered`, {
					name,
					path: sourceDir,
					relatedEntryId: existing[0]?.id,
					relatedPath: existing[0]?.path,
					source: this.getImportSource(sourceDir),
				}),
			]);
		}
		const currentSkill = this.getCurrentSkillNames().has(name);
		const currentSkillPath = this.getCurrentSkillPaths().get(name);
		if (
			currentSkill &&
			(!currentSkillPath || canonicalizePath(currentSkillPath) !== canonicalizePath(skillFilePath))
		) {
			throwMutationError(`Skill name ${JSON.stringify(name)} collides with an existing discovered skill`, [
				mutationDiagnostic(
					"name_conflict",
					"error",
					`Skill name ${JSON.stringify(name)} collides with an existing discovered skill`,
					{
						name,
						path: sourceDir,
						source: this.getImportSource(sourceDir),
					},
				),
			]);
		}

		const paths = getSkillRegistryScopePaths({ scope, cwd: this.cwd, agentDir: this.agentDir });
		const managedPath = join(paths.managedSkillsDir, name);
		if (existsSync(managedPath)) {
			throwMutationError(`Managed skill destination already exists: ${managedPath}`, [
				mutationDiagnostic(
					"skill_path_invalid",
					"error",
					`Managed skill destination already exists: ${managedPath}`,
					{
						scope,
						path: managedPath,
					},
				),
			]);
		}

		try {
			cpSync(sourceDir, managedPath, { recursive: true, errorOnExist: true, force: false });
		} catch (error) {
			rmSync(managedPath, { recursive: true, force: true });
			const message = error instanceof Error ? error.message : String(error);
			throwMutationError(`Failed to copy skill source: ${message}`);
		}

		const entry: SkillRegistryEntry = {
			id: this.createId(),
			name,
			source: this.getImportSource(sourceDir),
			scope,
			path: relative(paths.baseDir, managedPath).split(sep).join("/"),
			enabled: true,
			importedAt: this.now(),
			diagnostics: [],
		};
		const validation = validateSkillRegistryEntry({ entry, paths, projectTrusted: this.isProjectTrusted() });
		entry.diagnostics = validation.diagnostics;
		try {
			this.writeScope(scope, [...this.getLoadedScope(scope).registry.entries, entry]);
		} catch (error) {
			rmSync(managedPath, { recursive: true, force: true });
			throw error;
		}

		return { entry, validation, managedPath };
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

	private getImportSource(sourceDir: string): SkillSource {
		const harness = getExternalHarness(sourceDir);
		return harness ? { type: "external-directory", path: sourceDir, harness } : { type: "local", path: sourceDir };
	}

	private requireTrusted(scope: SkillRegistryScope): void {
		if (scope === "project" && !this.isProjectTrusted()) {
			throwMutationError("Project is not trusted; refusing project skill registry mutation", [
				mutationDiagnostic(
					"project_untrusted",
					"error",
					"Project skill registry is disabled until the project is trusted",
					{
						scope,
					},
				),
			]);
		}
	}

	private loadMutationScopes(): LoadedScope[] {
		if (!this.isProjectTrusted()) {
			const projectPaths = getSkillRegistryScopePaths({ scope: "project", cwd: this.cwd, agentDir: this.agentDir });
			if (existsSync(projectPaths.registryPath)) {
				throwMutationError("Project is not trusted; refusing to load project skill registry", [
					mutationDiagnostic(
						"project_untrusted",
						"error",
						"Project skill registry is disabled until the project is trusted",
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
			throwMutationError(`Cannot mutate malformed ${scope} skill registry`, loaded.diagnostics);
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
					`Skill name ${JSON.stringify(normalizedName)} has multiple registry entries`,
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
