import { randomUUID } from "node:crypto";
import {
	type Dirent,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import type { PathMetadata } from "./package-manager.ts";
import { type Skill, validateSkillDescription, validateSkillName } from "./skills.ts";

export const SKILL_REGISTRY_VERSION = 1;
export const SKILL_REGISTRY_FILENAME = "skills-registry.json";

const MAX_INVENTORY_FILES = 2048;
const SCRIPT_EXTENSIONS = new Set([".bash", ".js", ".mjs", ".pl", ".ps1", ".py", ".rb", ".sh", ".ts"]);
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([".bat", ".cmd", ".com", ".exe", ".ps1"]);
const DIAGNOSTIC_CODES = [
	"registry_malformed",
	"registry_scope_mismatch",
	"project_untrusted",
	"skill_path_missing",
	"skill_path_invalid",
	"skill_file_missing",
	"skill_file_invalid",
	"frontmatter_invalid",
	"name_required",
	"name_invalid",
	"name_mismatch",
	"description_required",
	"description_invalid",
	"relative_reference_missing",
	"relative_reference_outside_skill",
	"source_invalid",
	"source_missing",
	"source_fetch_failed",
	"source_subdirectory_invalid",
	"source_symlink_unsupported",
	"source_too_large",
	"skill_candidate_missing",
	"skill_candidate_ambiguous",
	"source_update_unavailable",
	"sha256_invalid",
	"sha256_mismatch",
	"name_conflict",
	"security_risk",
	"script_inventory",
	"executable_inventory",
	"inventory_truncated",
] as const;

export type SkillRegistryScope = "user" | "project";
export type SkillDiagnosticSeverity = "info" | "warning" | "error";
export type SkillDiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export type SkillSource =
	| { type: "local"; path: string }
	| { type: "git"; repository: string; ref?: string; subdirectory?: string }
	| { type: "npm"; package: string; version?: string; subdirectory?: string }
	| { type: "url"; url: string; sha256?: string }
	| { type: "external-directory"; path: string; harness?: "claude" | "codex" | "other" };

export interface SkillRegistryDiagnostic {
	code: SkillDiagnosticCode;
	severity: SkillDiagnosticSeverity;
	message: string;
	name?: string;
	scope?: SkillRegistryScope;
	registryPath?: string;
	entryId?: string;
	path?: string;
	relatedEntryId?: string;
	relatedPath?: string;
	source?: SkillSource;
	relatedSource?: SkillSource;
}

export interface SkillRegistryEntry {
	id: string;
	name: string;
	source: SkillSource;
	scope: SkillRegistryScope;
	path: string;
	enabled: boolean;
	pinnedRef?: string;
	sha256?: string;
	importedAt: number;
	updatedAt?: number;
	diagnostics: SkillRegistryDiagnostic[];
}

export interface SkillRegistryFile {
	version: typeof SKILL_REGISTRY_VERSION;
	entries: SkillRegistryEntry[];
}

export interface SkillRegistryScopePaths {
	scope: SkillRegistryScope;
	baseDir: string;
	managedSkillsDir: string;
	registryPath: string;
}

export interface SkillRegistryLoadResult {
	scope: SkillRegistryScope;
	paths: SkillRegistryScopePaths;
	registry: SkillRegistryFile;
	diagnostics: SkillRegistryDiagnostic[];
	exists: boolean;
}

export interface SkillInventory {
	scripts: string[];
	executables: string[];
	truncated: boolean;
}

export interface SkillAllowlist {
	/** When provided, only these Skill names are available. An empty list disables all Skills. */
	allow?: readonly string[];
	/** These Skill names are always excluded, including when also present in allow. */
	deny?: readonly string[];
}

export interface SkillResourceSet {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * Create a ResourceLoader skillsOverride for a controlled Agent profile.
 * Explicit allow entries that are not discovered remain unavailable and produce diagnostics.
 */
export function createSkillAllowlistOverride(policy: SkillAllowlist): (base: SkillResourceSet) => SkillResourceSet {
	const allowNames =
		policy.allow === undefined
			? undefined
			: Array.from(new Set(policy.allow.map((name) => name.trim()).filter((name) => name.length > 0)));
	const allow = allowNames ? new Set(allowNames) : undefined;
	const deny = new Set(policy.deny?.map((name) => name.trim()).filter((name) => name.length > 0) ?? []);

	return (base) => {
		const discoveredNames = new Set(base.skills.map((skill) => skill.name));
		const missingDiagnostics: ResourceDiagnostic[] = (allowNames ?? [])
			.filter((name) => !discoveredNames.has(name))
			.map((name) => ({
				type: "error",
				message: `Skill allowlist entry ${JSON.stringify(name)} was not discovered`,
			}));
		return {
			skills: base.skills.filter((skill) => (allow ? allow.has(skill.name) : true) && !deny.has(skill.name)),
			diagnostics: [...base.diagnostics, ...missingDiagnostics],
		};
	};
}

export interface SkillValidationResult {
	entry: SkillRegistryEntry;
	resolvedPath: string;
	skillFilePath?: string;
	name?: string;
	description?: string;
	references: string[];
	inventory: SkillInventory;
	diagnostics: SkillRegistryDiagnostic[];
	valid: boolean;
}

export interface SkillRegistryRecord {
	entry: SkillRegistryEntry;
	registryPath: string;
	resolvedPath: string;
	validation: SkillValidationResult;
	metadata: PathMetadata;
}

export interface SkillRegistrySnapshot {
	user: SkillRegistryLoadResult;
	project: SkillRegistryLoadResult;
	records: SkillRegistryRecord[];
	diagnostics: SkillRegistryDiagnostic[];
}

export interface SkillRegistryProjection extends SkillRegistrySnapshot {
	enabledRecords: SkillRegistryRecord[];
}

interface SkillFrontmatterRecord extends Record<string, unknown> {
	name?: unknown;
	description?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnostic(
	code: SkillDiagnosticCode,
	severity: SkillDiagnosticSeverity,
	message: string,
	options: Omit<SkillRegistryDiagnostic, "code" | "severity" | "message"> = {},
): SkillRegistryDiagnostic {
	return { code, severity, message, ...options };
}

export function getSkillRegistryScopePaths(options: {
	scope: SkillRegistryScope;
	cwd: string;
	agentDir: string;
}): SkillRegistryScopePaths {
	const baseDir =
		options.scope === "user" ? resolvePath(options.agentDir) : resolvePath(join(options.cwd, CONFIG_DIR_NAME));
	return {
		scope: options.scope,
		baseDir,
		managedSkillsDir: join(baseDir, "skills"),
		registryPath: join(baseDir, SKILL_REGISTRY_FILENAME),
	};
}

function parseOptionalString(record: Record<string, unknown>, key: string, context: string): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${context}.${key} must be a non-empty string`);
	}
	return value;
}

function parseRequiredString(record: Record<string, unknown>, key: string, context: string): string {
	const value = parseOptionalString(record, key, context);
	if (value === undefined) {
		throw new Error(`${context}.${key} is required`);
	}
	return value;
}

function parseSource(value: unknown, context: string): SkillSource {
	if (!isRecord(value)) {
		throw new Error(`${context} must be an object`);
	}
	const type = parseRequiredString(value, "type", context);
	switch (type) {
		case "local":
			return { type, path: parseRequiredString(value, "path", context) };
		case "git": {
			const ref = parseOptionalString(value, "ref", context);
			const subdirectory = parseOptionalString(value, "subdirectory", context);
			return {
				type,
				repository: parseRequiredString(value, "repository", context),
				...(ref ? { ref } : {}),
				...(subdirectory ? { subdirectory } : {}),
			};
		}
		case "npm": {
			const version = parseOptionalString(value, "version", context);
			const subdirectory = parseOptionalString(value, "subdirectory", context);
			return {
				type,
				package: parseRequiredString(value, "package", context),
				...(version ? { version } : {}),
				...(subdirectory ? { subdirectory } : {}),
			};
		}
		case "url": {
			const sha256 = parseOptionalString(value, "sha256", context);
			return {
				type,
				url: parseRequiredString(value, "url", context),
				...(sha256 ? { sha256 } : {}),
			};
		}
		case "external-directory": {
			const harness = value.harness;
			if (harness !== undefined && harness !== "claude" && harness !== "codex" && harness !== "other") {
				throw new Error(`${context}.harness must be "claude", "codex", or "other"`);
			}
			return {
				type,
				path: parseRequiredString(value, "path", context),
				...(harness ? { harness } : {}),
			};
		}
		default:
			throw new Error(`${context}.type is unsupported: ${JSON.stringify(type)}`);
	}
}

function parsePersistedDiagnostic(value: unknown, context: string): SkillRegistryDiagnostic {
	if (!isRecord(value)) {
		throw new Error(`${context} must be an object`);
	}
	const code = parseRequiredString(value, "code", context);
	if (!(DIAGNOSTIC_CODES as readonly string[]).includes(code)) {
		throw new Error(`${context}.code is unsupported: ${JSON.stringify(code)}`);
	}
	const severity = parseRequiredString(value, "severity", context);
	if (severity !== "info" && severity !== "warning" && severity !== "error") {
		throw new Error(`${context}.severity must be "info", "warning", or "error"`);
	}
	const scope = value.scope;
	if (scope !== undefined && scope !== "user" && scope !== "project") {
		throw new Error(`${context}.scope must be "user" or "project"`);
	}
	const name = parseOptionalString(value, "name", context);
	const registryPath = parseOptionalString(value, "registryPath", context);
	const entryId = parseOptionalString(value, "entryId", context);
	const path = parseOptionalString(value, "path", context);
	const relatedEntryId = parseOptionalString(value, "relatedEntryId", context);
	const relatedPath = parseOptionalString(value, "relatedPath", context);
	return {
		code: code as SkillDiagnosticCode,
		severity,
		message: parseRequiredString(value, "message", context),
		...(name ? { name } : {}),
		...(scope ? { scope } : {}),
		...(registryPath ? { registryPath } : {}),
		...(entryId ? { entryId } : {}),
		...(path ? { path } : {}),
		...(relatedEntryId ? { relatedEntryId } : {}),
		...(relatedPath ? { relatedPath } : {}),
		...(value.source === undefined ? {} : { source: parseSource(value.source, `${context}.source`) }),
		...(value.relatedSource === undefined
			? {}
			: { relatedSource: parseSource(value.relatedSource, `${context}.relatedSource`) }),
	};
}

function parseEntry(value: unknown, index: number, scope: SkillRegistryScope): SkillRegistryEntry {
	const context = `entries[${index}]`;
	if (!isRecord(value)) {
		throw new Error(`${context} must be an object`);
	}
	if (value.scope !== scope) {
		throw new Error(`${context}.scope must be ${JSON.stringify(scope)}`);
	}
	if (typeof value.enabled !== "boolean") {
		throw new Error(`${context}.enabled must be a boolean`);
	}
	if (typeof value.importedAt !== "number" || !Number.isFinite(value.importedAt) || value.importedAt < 0) {
		throw new Error(`${context}.importedAt must be a non-negative finite number`);
	}
	if (
		value.updatedAt !== undefined &&
		(typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt) || value.updatedAt < 0)
	) {
		throw new Error(`${context}.updatedAt must be a non-negative finite number`);
	}
	if (!Array.isArray(value.diagnostics)) {
		throw new Error(`${context}.diagnostics must be an array`);
	}
	const pinnedRef = parseOptionalString(value, "pinnedRef", context);
	const sha256 = parseOptionalString(value, "sha256", context);
	return {
		id: parseRequiredString(value, "id", context),
		name: parseRequiredString(value, "name", context),
		source: parseSource(value.source, `${context}.source`),
		scope,
		path: parseRequiredString(value, "path", context),
		enabled: value.enabled,
		...(pinnedRef ? { pinnedRef } : {}),
		...(sha256 ? { sha256 } : {}),
		importedAt: value.importedAt,
		...(typeof value.updatedAt === "number" ? { updatedAt: value.updatedAt } : {}),
		diagnostics: value.diagnostics.map((item, diagnosticIndex) =>
			parsePersistedDiagnostic(item, `${context}.diagnostics[${diagnosticIndex}]`),
		),
	};
}

function emptyRegistry(): SkillRegistryFile {
	return { version: SKILL_REGISTRY_VERSION, entries: [] };
}

export function loadSkillRegistry(options: {
	scope: SkillRegistryScope;
	cwd: string;
	agentDir: string;
}): SkillRegistryLoadResult {
	const paths = getSkillRegistryScopePaths(options);
	if (!existsSync(paths.registryPath)) {
		return { scope: options.scope, paths, registry: emptyRegistry(), diagnostics: [], exists: false };
	}

	try {
		const parsed = JSON.parse(readFileSync(paths.registryPath, "utf-8")) as unknown;
		if (!isRecord(parsed)) {
			throw new Error("registry root must be an object");
		}
		if (parsed.version !== SKILL_REGISTRY_VERSION) {
			throw new Error(`version must be ${SKILL_REGISTRY_VERSION}`);
		}
		if (!Array.isArray(parsed.entries)) {
			throw new Error("entries must be an array");
		}
		const entries = parsed.entries.map((entry, index) => parseEntry(entry, index, options.scope));
		const ids = new Set<string>();
		for (const entry of entries) {
			if (ids.has(entry.id)) {
				throw new Error(`duplicate entry id ${JSON.stringify(entry.id)}`);
			}
			ids.add(entry.id);
		}
		return {
			scope: options.scope,
			paths,
			registry: { version: SKILL_REGISTRY_VERSION, entries },
			diagnostics: [],
			exists: true,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			scope: options.scope,
			paths,
			registry: emptyRegistry(),
			diagnostics: [
				diagnostic("registry_malformed", "error", `Malformed skill registry: ${message}`, {
					scope: options.scope,
					registryPath: paths.registryPath,
					path: paths.registryPath,
				}),
			],
			exists: true,
		};
	}
}

function canonicalSource(source: SkillSource): SkillSource {
	switch (source.type) {
		case "local":
			return { type: source.type, path: source.path };
		case "git":
			return {
				type: source.type,
				repository: source.repository,
				...(source.ref ? { ref: source.ref } : {}),
				...(source.subdirectory ? { subdirectory: source.subdirectory } : {}),
			};
		case "npm":
			return {
				type: source.type,
				package: source.package,
				...(source.version ? { version: source.version } : {}),
				...(source.subdirectory ? { subdirectory: source.subdirectory } : {}),
			};
		case "url":
			return { type: source.type, url: source.url, ...(source.sha256 ? { sha256: source.sha256 } : {}) };
		case "external-directory":
			return { type: source.type, path: source.path, ...(source.harness ? { harness: source.harness } : {}) };
	}
}

function canonicalDiagnostic(value: SkillRegistryDiagnostic): SkillRegistryDiagnostic {
	return {
		code: value.code,
		severity: value.severity,
		message: value.message,
		...(value.name ? { name: value.name } : {}),
		...(value.scope ? { scope: value.scope } : {}),
		...(value.registryPath ? { registryPath: value.registryPath } : {}),
		...(value.entryId ? { entryId: value.entryId } : {}),
		...(value.path ? { path: value.path } : {}),
		...(value.relatedEntryId ? { relatedEntryId: value.relatedEntryId } : {}),
		...(value.relatedPath ? { relatedPath: value.relatedPath } : {}),
		...(value.source ? { source: canonicalSource(value.source) } : {}),
		...(value.relatedSource ? { relatedSource: canonicalSource(value.relatedSource) } : {}),
	};
}

function canonicalEntry(entry: SkillRegistryEntry): SkillRegistryEntry {
	return {
		id: entry.id,
		name: entry.name,
		source: canonicalSource(entry.source),
		scope: entry.scope,
		path: entry.path,
		enabled: entry.enabled,
		...(entry.pinnedRef ? { pinnedRef: entry.pinnedRef } : {}),
		...(entry.sha256 ? { sha256: entry.sha256 } : {}),
		importedAt: entry.importedAt,
		...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
		diagnostics: entry.diagnostics
			.map(canonicalDiagnostic)
			.sort((left, right) =>
				[left.severity, left.code, left.path ?? "", left.message]
					.join("\0")
					.localeCompare([right.severity, right.code, right.path ?? "", right.message].join("\0")),
			),
	};
}

function acquireRegistryLock(registryPath: string): () => void {
	const lockTarget = dirname(registryPath);
	const maxAttempts = 10;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return lockfile.lockSync(lockTarget, {
				realpath: false,
				lockfilePath: `${registryPath}.lock`,
			});
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code !== "ELOCKED" || attempt === maxAttempts) {
				throw error;
			}
			const start = Date.now();
			while (Date.now() - start < 20) {
				// Synchronous callers use the same bounded lock retry as settings and trust persistence.
			}
		}
	}
	throw new Error("Failed to acquire skill registry lock");
}

function withRegistryLock<T>(registryPath: string, fn: () => T): T {
	mkdirSync(dirname(registryPath), { recursive: true, mode: 0o700 });
	const release = acquireRegistryLock(registryPath);
	try {
		return fn();
	} finally {
		release();
	}
}

export function writeSkillRegistry(options: {
	scope: SkillRegistryScope;
	cwd: string;
	agentDir: string;
	registry: SkillRegistryFile;
	projectTrusted?: boolean;
}): void {
	if (options.scope === "project" && options.projectTrusted !== true) {
		throw new Error("Project is not trusted; refusing to write project skill registry");
	}
	const paths = getSkillRegistryScopePaths(options);
	const registry: SkillRegistryFile = {
		version: SKILL_REGISTRY_VERSION,
		entries: options.registry.entries
			.map(canonicalEntry)
			.sort((left, right) => [left.name, left.id].join("\0").localeCompare([right.name, right.id].join("\0"))),
	};
	const ids = new Set<string>();
	for (const entry of registry.entries) {
		if (entry.scope !== options.scope) {
			throw new Error(
				`Registry entry ${JSON.stringify(entry.id)} has scope ${entry.scope}, expected ${options.scope}`,
			);
		}
		if (ids.has(entry.id)) {
			throw new Error(`Duplicate skill registry entry id: ${JSON.stringify(entry.id)}`);
		}
		ids.add(entry.id);
	}
	const content = `${JSON.stringify(registry, null, 2)}\n`;
	withRegistryLock(paths.registryPath, () => {
		const temporaryPath = join(dirname(paths.registryPath), `.${SKILL_REGISTRY_FILENAME}.${randomUUID()}.tmp`);
		try {
			writeFileSync(temporaryPath, content, { encoding: "utf-8", mode: 0o600, flag: "wx" });
			renameSync(temporaryPath, paths.registryPath);
		} finally {
			rmSync(temporaryPath, { force: true });
		}
	});
}

function resolveRegistryPath(path: string, baseDir: string): string {
	return resolvePath(path, baseDir, { trim: true });
}

function isPathInside(target: string, root: string): boolean {
	const relativePath = relative(root, target);
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	);
}

function normalizeReferenceDestination(value: string): string | undefined {
	let destination = value.trim();
	if (destination.startsWith("<") && destination.endsWith(">")) {
		destination = destination.slice(1, -1);
	}
	if (
		!destination ||
		destination.startsWith("#") ||
		destination.startsWith("/") ||
		destination.startsWith("//") ||
		/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(destination)
	) {
		return undefined;
	}
	destination = destination.split("#", 1)[0]?.split("?", 1)[0] ?? destination;
	try {
		return decodeURIComponent(destination);
	} catch {
		return destination;
	}
}

function collectRelativeReferences(body: string): string[] {
	const references = new Set<string>();
	const inlinePattern = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;
	for (const match of body.matchAll(inlinePattern)) {
		const destination = match[1] ? normalizeReferenceDestination(match[1]) : undefined;
		if (destination) references.add(destination);
	}
	const definitionPattern = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm;
	for (const match of body.matchAll(definitionPattern)) {
		const destination = match[1] ? normalizeReferenceDestination(match[1]) : undefined;
		if (destination) references.add(destination);
	}
	return Array.from(references).sort();
}

function collectInventory(skillDir: string): SkillInventory {
	const scripts = new Set<string>();
	const executables = new Set<string>();
	let visited = 0;
	let truncated = false;

	const visit = (dir: string): void => {
		if (truncated) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(fullPath);
				continue;
			}
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			visited += 1;
			if (visited > MAX_INVENTORY_FILES) {
				truncated = true;
				return;
			}
			const relativePath = relative(skillDir, fullPath).split(sep).join("/");
			if (relativePath === "SKILL.md") continue;
			const extension = extname(entry.name).toLowerCase();
			if (relativePath.startsWith("scripts/") || SCRIPT_EXTENSIONS.has(extension)) {
				scripts.add(relativePath);
			}
			try {
				const stats = lstatSync(fullPath);
				if ((stats.mode & 0o111) !== 0 || WINDOWS_EXECUTABLE_EXTENSIONS.has(extension)) {
					executables.add(relativePath);
				}
			} catch {}
		}
	};
	visit(skillDir);
	return {
		scripts: Array.from(scripts).sort(),
		executables: Array.from(executables).sort(),
		truncated,
	};
}

function isSafeSourceSubdirectory(value: string): boolean {
	return (
		!isAbsolute(value) &&
		!value.includes("\\") &&
		!value.split("/").some((segment) => segment === ".." || segment === "")
	);
}

function validateSource(entry: SkillRegistryEntry, baseDir: string, registryPath: string): SkillRegistryDiagnostic[] {
	const diagnostics: SkillRegistryDiagnostic[] = [];
	const common = {
		scope: entry.scope,
		registryPath,
		entryId: entry.id,
		source: entry.source,
	};
	if (entry.sha256 && !/^[0-9a-f]{64}$/i.test(entry.sha256)) {
		diagnostics.push(
			diagnostic("sha256_invalid", "error", "Registry sha256 must contain 64 hexadecimal characters", common),
		);
	}
	switch (entry.source.type) {
		case "local":
		case "external-directory": {
			const sourcePath = resolveRegistryPath(entry.source.path, baseDir);
			if (!existsSync(sourcePath)) {
				diagnostics.push(
					diagnostic("source_missing", "warning", `Skill source does not exist: ${sourcePath}`, {
						...common,
						path: sourcePath,
					}),
				);
			}
			diagnostics.push(
				diagnostic(
					"source_update_unavailable",
					"info",
					"Local skill sources are referenced directly in Stage 1",
					common,
				),
			);
			break;
		}
		case "git":
			if (entry.source.subdirectory && !isSafeSourceSubdirectory(entry.source.subdirectory)) {
				diagnostics.push(
					diagnostic(
						"source_subdirectory_invalid",
						"error",
						`Git Skill subdirectory is unsafe: ${entry.source.subdirectory}`,
						common,
					),
				);
			}
			break;
		case "npm":
			if (entry.source.subdirectory && !isSafeSourceSubdirectory(entry.source.subdirectory)) {
				diagnostics.push(
					diagnostic(
						"source_subdirectory_invalid",
						"error",
						`npm Skill subdirectory is unsafe: ${entry.source.subdirectory}`,
						common,
					),
				);
			}
			break;
		case "url": {
			let url: URL | undefined;
			try {
				url = new URL(entry.source.url);
			} catch {}
			if (!url || url.protocol !== "https:") {
				diagnostics.push(diagnostic("source_invalid", "error", "URL skill sources must use HTTPS", common));
			}
			if (entry.source.sha256 && !/^[0-9a-f]{64}$/i.test(entry.source.sha256)) {
				diagnostics.push(
					diagnostic(
						"sha256_invalid",
						"error",
						"URL source sha256 must contain 64 hexadecimal characters",
						common,
					),
				);
			}
			if (entry.sha256 && entry.source.sha256 && entry.sha256.toLowerCase() !== entry.source.sha256.toLowerCase()) {
				diagnostics.push(
					diagnostic("sha256_mismatch", "error", "Registry and URL source SHA-256 pins do not match", common),
				);
			}
			break;
		}
	}
	return diagnostics;
}

export function validateSkillRegistryEntry(options: {
	entry: SkillRegistryEntry;
	paths: SkillRegistryScopePaths;
	projectTrusted: boolean;
}): SkillValidationResult {
	const { entry, paths } = options;
	const resolvedPath = resolveRegistryPath(entry.path, paths.baseDir);
	const diagnostics = validateSource(entry, paths.baseDir, paths.registryPath);
	const common = {
		scope: entry.scope,
		registryPath: paths.registryPath,
		entryId: entry.id,
		path: resolvedPath,
		source: entry.source,
	};
	const inventory: SkillInventory = { scripts: [], executables: [], truncated: false };
	const emptyResult = (): SkillValidationResult => ({
		entry,
		resolvedPath,
		references: [],
		inventory,
		diagnostics,
		valid: !diagnostics.some((item) => item.severity === "error"),
	});

	if (entry.scope === "project" && !options.projectTrusted) {
		diagnostics.push(
			diagnostic(
				"project_untrusted",
				"error",
				"Project skill registry is disabled until the project is trusted",
				common,
			),
		);
		return emptyResult();
	}
	if (!existsSync(resolvedPath)) {
		diagnostics.push(
			diagnostic("skill_path_missing", "error", `Registered skill path does not exist: ${resolvedPath}`, common),
		);
		return emptyResult();
	}

	let skillFilePath: string;
	try {
		const stats = statSync(resolvedPath);
		if (stats.isDirectory()) {
			skillFilePath = join(resolvedPath, "SKILL.md");
		} else if (stats.isFile() && resolvedPath.endsWith(`${sep}SKILL.md`)) {
			skillFilePath = resolvedPath;
		} else {
			diagnostics.push(
				diagnostic(
					"skill_path_invalid",
					"error",
					"Registered skill path must be a directory or a SKILL.md file",
					common,
				),
			);
			return emptyResult();
		}
	} catch (error) {
		diagnostics.push(
			diagnostic(
				"skill_path_invalid",
				"error",
				error instanceof Error ? error.message : "Failed to inspect skill path",
				common,
			),
		);
		return emptyResult();
	}
	if (!existsSync(skillFilePath)) {
		diagnostics.push(
			diagnostic(
				"skill_file_missing",
				"error",
				`Registered skill directory does not contain SKILL.md: ${skillFilePath}`,
				{
					...common,
					path: skillFilePath,
				},
			),
		);
		return { ...emptyResult(), skillFilePath };
	}
	try {
		if (!statSync(skillFilePath).isFile()) {
			diagnostics.push(
				diagnostic("skill_file_invalid", "error", `SKILL.md is not a file: ${skillFilePath}`, {
					...common,
					path: skillFilePath,
				}),
			);
			return { ...emptyResult(), skillFilePath };
		}
	} catch (error) {
		diagnostics.push(
			diagnostic(
				"skill_file_invalid",
				"error",
				error instanceof Error ? error.message : "Failed to inspect SKILL.md",
				{
					...common,
					path: skillFilePath,
				},
			),
		);
		return { ...emptyResult(), skillFilePath };
	}

	let rawContent: string;
	let frontmatter: SkillFrontmatterRecord;
	let body: string;
	try {
		rawContent = readFileSync(skillFilePath, "utf-8");
		const parsed = parseFrontmatter<SkillFrontmatterRecord>(rawContent);
		frontmatter = parsed.frontmatter;
		body = parsed.body;
	} catch (error) {
		diagnostics.push(
			diagnostic(
				"frontmatter_invalid",
				"error",
				error instanceof Error ? error.message : "Failed to parse frontmatter",
				{
					...common,
					path: skillFilePath,
				},
			),
		);
		return { ...emptyResult(), skillFilePath };
	}

	const name = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
	if (!name || name.trim() === "") {
		diagnostics.push(
			diagnostic("name_required", "error", "SKILL.md frontmatter name is required", {
				...common,
				path: skillFilePath,
			}),
		);
	} else {
		for (const message of validateSkillName(name)) {
			diagnostics.push(diagnostic("name_invalid", "error", message, { ...common, path: skillFilePath }));
		}
		if (entry.name !== name) {
			diagnostics.push(
				diagnostic(
					"name_mismatch",
					"error",
					`Registry name ${JSON.stringify(entry.name)} does not match SKILL.md name ${JSON.stringify(name)}`,
					{
						...common,
						path: skillFilePath,
					},
				),
			);
		}
	}

	const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined;
	for (const message of validateSkillDescription(description)) {
		diagnostics.push(
			diagnostic(description ? "description_invalid" : "description_required", "error", message, {
				...common,
				path: skillFilePath,
			}),
		);
	}

	const skillDir = dirname(skillFilePath);
	const references = collectRelativeReferences(body);
	for (const reference of references) {
		const target = resolve(skillDir, reference);
		if (!isPathInside(target, skillDir)) {
			diagnostics.push(
				diagnostic(
					"relative_reference_outside_skill",
					"error",
					`Relative reference escapes the skill directory: ${reference}`,
					{
						...common,
						path: skillFilePath,
						relatedPath: target,
					},
				),
			);
			continue;
		}
		if (!existsSync(target)) {
			diagnostics.push(
				diagnostic("relative_reference_missing", "error", `Relative reference does not exist: ${reference}`, {
					...common,
					path: skillFilePath,
					relatedPath: target,
				}),
			);
			continue;
		}
		const canonicalRoot = canonicalizePath(skillDir);
		const canonicalTarget = canonicalizePath(target);
		if (!isPathInside(canonicalTarget, canonicalRoot)) {
			diagnostics.push(
				diagnostic(
					"relative_reference_outside_skill",
					"error",
					`Relative reference resolves outside the skill directory: ${reference}`,
					{
						...common,
						path: skillFilePath,
						relatedPath: canonicalTarget,
					},
				),
			);
		}
	}

	const discoveredInventory = collectInventory(skillDir);
	inventory.scripts = discoveredInventory.scripts;
	inventory.executables = discoveredInventory.executables;
	inventory.truncated = discoveredInventory.truncated;
	if (inventory.scripts.length > 0) {
		diagnostics.push(
			diagnostic("script_inventory", "info", `Skill includes scripts: ${inventory.scripts.join(", ")}`, {
				...common,
				path: skillFilePath,
			}),
		);
	}
	if (inventory.executables.length > 0) {
		diagnostics.push(
			diagnostic(
				"executable_inventory",
				"warning",
				`Skill includes executable files: ${inventory.executables.join(", ")}`,
				{
					...common,
					path: skillFilePath,
				},
			),
		);
	}
	if (inventory.truncated) {
		diagnostics.push(
			diagnostic(
				"inventory_truncated",
				"warning",
				`Skill inventory exceeded ${MAX_INVENTORY_FILES} files and was truncated`,
				{
					...common,
					path: skillFilePath,
				},
			),
		);
	}

	const securityInputs = [rawContent];
	for (const script of inventory.scripts) {
		const scriptPath = join(skillDir, script);
		try {
			const stats = lstatSync(scriptPath);
			if (stats.isFile() && stats.size <= 256 * 1024) securityInputs.push(readFileSync(scriptPath, "utf-8"));
		} catch {}
	}
	const securityText = securityInputs.join("\n");
	const risks = [
		{ label: "sudo usage", pattern: /\bsudo\b/i },
		{ label: "curl or wget piped to a shell", pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z|k)?sh\b/i },
		{
			label: "credential or secret access",
			pattern:
				/\b(?:credentials?|api[ _-]?keys?|access[ _-]?tokens?|secrets?|AWS_SECRET_ACCESS_KEY)\b|(?:^|[/\\])\.env\b/im,
		},
		{ label: "remote execution instructions", pattern: /\b(?:ssh|scp|kubectl\s+exec|remote execution)\b/i },
	]
		.filter((risk) => risk.pattern.test(securityText))
		.map((risk) => risk.label);
	if (risks.length > 0) {
		diagnostics.push(
			diagnostic("security_risk", "warning", `Skill security review flagged: ${risks.join(", ")}`, {
				...common,
				path: skillFilePath,
			}),
		);
	}

	return {
		entry,
		resolvedPath,
		skillFilePath,
		...(name ? { name } : {}),
		...(description ? { description } : {}),
		references,
		inventory,
		diagnostics,
		valid: !diagnostics.some((item) => item.severity === "error"),
	};
}

export function formatSkillSource(source: SkillSource): string {
	switch (source.type) {
		case "local":
			return `local:${source.path}`;
		case "git":
			return `git:${source.repository}${source.ref ? `@${source.ref}` : ""}${source.subdirectory ? `#${source.subdirectory}` : ""}`;
		case "npm":
			return `npm:${source.package}${source.version ? `@${source.version}` : ""}${source.subdirectory ? `#${source.subdirectory}` : ""}`;
		case "url":
			return `url:${source.url}`;
		case "external-directory":
			return `external-directory:${source.harness ?? "other"}:${source.path}`;
	}
}

export function resolveSkillRegistryProjection(options: {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
}): SkillRegistryProjection {
	const user = loadSkillRegistry({ scope: "user", cwd: options.cwd, agentDir: options.agentDir });
	const projectPaths = getSkillRegistryScopePaths({ scope: "project", cwd: options.cwd, agentDir: options.agentDir });
	const project = options.projectTrusted
		? loadSkillRegistry({ scope: "project", cwd: options.cwd, agentDir: options.agentDir })
		: {
				scope: "project" as const,
				paths: projectPaths,
				registry: emptyRegistry(),
				diagnostics: existsSync(projectPaths.registryPath)
					? [
							diagnostic(
								"project_untrusted",
								"warning",
								"Project skill registry is ignored until the project is trusted",
								{
									scope: "project",
									registryPath: projectPaths.registryPath,
									path: projectPaths.registryPath,
								},
							),
						]
					: [],
				exists: existsSync(projectPaths.registryPath),
			};

	const records: SkillRegistryRecord[] = [];
	const diagnostics = [...user.diagnostics, ...project.diagnostics];
	for (const result of [project, user]) {
		for (const entry of result.registry.entries) {
			diagnostics.push(
				...entry.diagnostics.map((item) => ({
					...item,
					scope: item.scope ?? entry.scope,
					registryPath: item.registryPath ?? result.paths.registryPath,
					entryId: item.entryId ?? entry.id,
					path: item.path ?? resolveRegistryPath(entry.path, result.paths.baseDir),
					source: item.source ?? entry.source,
				})),
			);
			const validation = validateSkillRegistryEntry({
				entry,
				paths: result.paths,
				projectTrusted: options.projectTrusted,
			});
			diagnostics.push(...validation.diagnostics);
			const resolvedPath = validation.skillFilePath ?? validation.resolvedPath;
			records.push({
				entry,
				registryPath: result.paths.registryPath,
				resolvedPath,
				validation,
				metadata: {
					source: `registry:${formatSkillSource(entry.source)}`,
					scope: entry.scope,
					origin: "top-level",
					baseDir: result.paths.baseDir,
				},
			});
		}
	}

	records.sort((left, right) => {
		const scopeOrder = left.entry.scope === right.entry.scope ? 0 : left.entry.scope === "project" ? -1 : 1;
		return (
			scopeOrder ||
			[left.entry.name, left.entry.id].join("\0").localeCompare([right.entry.name, right.entry.id].join("\0"))
		);
	});

	const enabledRecords = records.filter((record) => record.entry.enabled && record.validation.valid);
	const winners = new Map<string, SkillRegistryRecord>();
	for (const record of enabledRecords) {
		const actualName = record.validation.name ?? record.entry.name;
		const winner = winners.get(actualName);
		if (!winner) {
			winners.set(actualName, record);
			continue;
		}
		diagnostics.push(
			diagnostic(
				"name_conflict",
				"error",
				`Skill name ${JSON.stringify(actualName)} conflicts with ${winner.resolvedPath}`,
				{
					name: actualName,
					scope: record.entry.scope,
					registryPath: record.registryPath,
					entryId: record.entry.id,
					path: record.resolvedPath,
					relatedEntryId: winner.entry.id,
					relatedPath: winner.resolvedPath,
					source: record.entry.source,
					relatedSource: winner.entry.source,
				},
			),
		);
	}

	return { user, project, records, enabledRecords, diagnostics };
}
