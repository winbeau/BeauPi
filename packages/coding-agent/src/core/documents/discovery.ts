import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ResourceLoader } from "../resource-loader.ts";
import {
	type DocumentDiagnostic,
	type DocumentKind,
	type DocumentRuntimeBudgets,
	type DocumentSource,
	hashDocumentContent,
	type PackageScript,
} from "./types.ts";

export const DEFAULT_DOCUMENT_RUNTIME_BUDGETS: DocumentRuntimeBudgets = Object.freeze({
	maxFiles: 256,
	maxFileBytes: 512 * 1024,
	maxTotalBytes: 4 * 1024 * 1024,
	maxCachedDocuments: 128,
	maxContractDocuments: 12,
	maxSearchResults: 30,
});

const IGNORED_DIRECTORIES = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	".cache",
	".next",
	".turbo",
	"target",
	"vendor",
	"generated",
	".generated",
]);

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

export interface DocumentDiscoveryFile {
	canonicalPath: string;
	path: string;
	displayPath: string;
	kind: DocumentKind;
	sources: DocumentSource[];
	directoryDistance: number;
	content: string;
	size: number;
	mtimeMs?: number;
	packageScripts: PackageScript[];
}

export interface DocumentDiscoveryResult {
	files: DocumentDiscoveryFile[];
	diagnostics: DocumentDiagnostic[];
	truncated: boolean;
	totalBytes: number;
}

interface Candidate {
	path: string;
	kind: DocumentKind;
	sources: Set<DocumentSource>;
	directoryDistance: number;
	priority: number;
	content?: string;
}

interface DiscoveryOptions {
	cwd: string;
	agentDir: string;
	resourceLoader: ResourceLoader;
	budgets?: Partial<DocumentRuntimeBudgets>;
	explicitPaths?: string[];
}

function mergeBudgets(input?: Partial<DocumentRuntimeBudgets>): DocumentRuntimeBudgets {
	return {
		...DEFAULT_DOCUMENT_RUNTIME_BUDGETS,
		...input,
	};
}

function isUnderPath(target: string, root: string): boolean {
	const normalizedTarget = resolve(target);
	const normalizedRoot = resolve(root);
	return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`);
}

function directoryDistance(cwd: string, path: string): number {
	const relativePath = relative(cwd, dirname(path));
	if (relativePath === "") return 0;
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return 20;
	return relativePath.split(sep).filter(Boolean).length;
}

function displayPathFor(path: string, cwd: string): string {
	const relativePath = relative(cwd, path);
	if (relativePath === "") return ".";
	if (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)) {
		return relativePath.split(sep).join("/");
	}
	return path.split(sep).join("/");
}

function kindForPath(path: string): DocumentKind {
	const name = basename(path).toLocaleLowerCase();
	if (name === "agents.md") return "agents";
	if (name === "claude.md") return "claude";
	if (name === "readme.md") return "readme";
	if (name === "contributing.md") return "contributing";
	if (name === "package.json") return "package-json";
	return "markdown";
}

function sourceRank(sources: Iterable<DocumentSource>): number {
	const ranks: Record<DocumentSource, number> = {
		global: 0,
		ancestor: 1,
		project: 2,
		nearby: 3,
		explicit: 4,
		package: 2,
	};
	return Math.min(...Array.from(sources, (source) => ranks[source]));
}

function addCandidate(
	candidates: Map<string, Candidate>,
	path: string,
	kind: DocumentKind,
	source: DocumentSource,
	cwd: string,
	priority: number,
	content?: string,
): void {
	const canonicalPath = resolve(path);
	const existing = candidates.get(canonicalPath);
	if (existing) {
		existing.sources.add(source);
		existing.priority = Math.min(existing.priority, priority);
		if (content !== undefined && existing.content === undefined) existing.content = content;
		return;
	}
	candidates.set(canonicalPath, {
		path: canonicalPath,
		kind,
		sources: new Set([source]),
		directoryDistance: directoryDistance(cwd, canonicalPath),
		priority,
		content,
	});
}

async function findProjectRoot(cwd: string): Promise<string> {
	let current = resolve(cwd);
	let packageRoot: string | undefined;
	while (true) {
		try {
			const gitStats = await stat(join(current, ".git"));
			if (gitStats.isDirectory() || gitStats.isFile()) return current;
		} catch {
			// Keep walking.
		}
		try {
			const packageStats = await stat(join(current, "package.json"));
			if (!packageRoot && packageStats.isFile()) packageRoot = current;
		} catch {
			// Keep walking.
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return packageRoot ?? resolve(cwd);
}

async function collectDirectMarkdown(
	directory: string,
	candidates: Map<string, Candidate>,
	cwd: string,
	source: DocumentSource,
	priority: number,
): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		if (!MARKDOWN_EXTENSIONS.has(extname(entry.name).toLocaleLowerCase())) continue;
		addCandidate(
			candidates,
			join(directory, entry.name),
			kindForPath(join(directory, entry.name)),
			source,
			cwd,
			priority,
		);
	}
}

async function collectMarkdownTree(
	root: string,
	candidates: Map<string, Candidate>,
	cwd: string,
	projectRoot: string,
	maxCandidates: number,
): Promise<void> {
	const visitedDirectories = new Set<string>();
	const walk = async (directory: string): Promise<void> => {
		if (candidates.size >= maxCandidates) return;
		let canonicalDirectory: string;
		try {
			canonicalDirectory = await realpath(directory);
		} catch {
			return;
		}
		if (visitedDirectories.has(canonicalDirectory)) return;
		visitedDirectories.add(canonicalDirectory);
		if (!isUnderPath(canonicalDirectory, projectRoot)) return;
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (candidates.size >= maxCandidates) return;
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				if (IGNORED_DIRECTORIES.has(entry.name.toLocaleLowerCase())) continue;
				let isDirectory = entry.isDirectory();
				if (entry.isSymbolicLink()) {
					try {
						isDirectory = (await stat(join(directory, entry.name))).isDirectory();
					} catch {
						continue;
					}
				}
				if (isDirectory) {
					await walk(join(directory, entry.name));
					continue;
				}
			}
			if (entry.isFile() || entry.isSymbolicLink()) {
				const entryPath = join(directory, entry.name);
				const extension = extname(entry.name).toLocaleLowerCase();
				if (!MARKDOWN_EXTENSIONS.has(extension)) continue;
				addCandidate(candidates, entryPath, kindForPath(entryPath), "project", cwd, 50);
			}
		}
	};
	await walk(root);
}

async function collectPackageScripts(
	cwd: string,
	projectRoot: string,
	candidates: Map<string, Candidate>,
): Promise<void> {
	let current = resolve(cwd);
	while (isUnderPath(current, projectRoot)) {
		const packagePath = join(current, "package.json");
		try {
			const packageStats = await stat(packagePath);
			if (packageStats.isFile()) {
				addCandidate(candidates, packagePath, "package-json", "package", cwd, 5);
				return;
			}
		} catch {
			// Continue to the nearest ancestor package.
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
}

function isUrl(value: string): boolean {
	return /^[a-z][a-z\d+.-]*:\/\//i.test(value);
}

function normalizeExplicitPath(value: string, cwd: string): string {
	return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

function parsePackageScripts(content: string): PackageScript[] {
	try {
		const parsed = JSON.parse(content) as { scripts?: Record<string, unknown> };
		if (!parsed.scripts || typeof parsed.scripts !== "object" || Array.isArray(parsed.scripts)) return [];
		const lines = content.split("\n");
		return Object.entries(parsed.scripts)
			.filter(([, command]) => typeof command === "string")
			.map(([name, command]) => {
				const marker = `"${name}"`;
				const line = Math.max(1, lines.findIndex((item) => item.includes(marker)) + 1);
				return { name, command: command as string, line };
			});
	} catch {
		return [];
	}
}

async function loadCandidate(
	candidate: Candidate,
	cwd: string,
	budgets: DocumentRuntimeBudgets,
	diagnostics: DocumentDiagnostic[],
): Promise<DocumentDiscoveryFile | undefined> {
	let content = candidate.content;
	let stats: { size: number; mtimeMs: number } | undefined;
	try {
		const fileStats = await stat(candidate.path);
		if (!fileStats.isFile()) return undefined;
		stats = { size: fileStats.size, mtimeMs: fileStats.mtimeMs };
		if (fileStats.size > budgets.maxFileBytes) {
			diagnostics.push({
				code: "file_too_large",
				severity: "warning",
				message: `Skipped document larger than ${budgets.maxFileBytes} bytes`,
				path: candidate.path,
			});
			return undefined;
		}
		content = await readFile(candidate.path, "utf-8");
	} catch (error) {
		if (content === undefined) {
			diagnostics.push({
				code: "unreadable",
				severity: "warning",
				message: error instanceof Error ? error.message : "Unable to read document",
				path: candidate.path,
			});
			return undefined;
		}
	}
	if (content === undefined) return undefined;
	const size = Buffer.byteLength(content, "utf-8");
	if (size > budgets.maxFileBytes) {
		diagnostics.push({
			code: "file_too_large",
			severity: "warning",
			message: `Skipped document larger than ${budgets.maxFileBytes} bytes`,
			path: candidate.path,
		});
		return undefined;
	}
	const canonicalPath = await realpath(candidate.path).catch(() => resolve(candidate.path));
	const sources = [...candidate.sources].sort(
		(left, right) => sourceRank([left]) - sourceRank([right]) || left.localeCompare(right),
	);
	return {
		canonicalPath,
		path: canonicalPath,
		displayPath: displayPathFor(canonicalPath, cwd),
		kind: candidate.kind,
		sources,
		directoryDistance: candidate.directoryDistance,
		content,
		size: stats?.size ?? size,
		mtimeMs: stats?.mtimeMs,
		packageScripts: candidate.kind === "package-json" ? parsePackageScripts(content) : [],
	};
}

export async function discoverDocuments(options: DiscoveryOptions): Promise<DocumentDiscoveryResult> {
	const cwd = resolve(options.cwd);
	const agentDir = resolve(options.agentDir);
	const budgets = mergeBudgets(options.budgets);
	const projectRoot = await findProjectRoot(cwd);
	const candidates = new Map<string, Candidate>();
	const diagnostics: DocumentDiagnostic[] = [];

	for (const context of options.resourceLoader.getAgentsFiles().agentsFiles) {
		const contextPath = resolve(context.path);
		const source: DocumentSource = isUnderPath(contextPath, agentDir)
			? "global"
			: dirname(contextPath) === projectRoot
				? "project"
				: isUnderPath(contextPath, projectRoot)
					? "ancestor"
					: "explicit";
		addCandidate(
			candidates,
			contextPath,
			kindForPath(contextPath),
			source,
			cwd,
			source === "global" ? 0 : 10,
			context.content,
		);
	}

	let current = cwd;
	let distance = 0;
	while (isUnderPath(current, projectRoot)) {
		await collectDirectMarkdown(
			current,
			candidates,
			cwd,
			current === projectRoot ? "project" : "nearby",
			20 + distance,
		);
		const docsDirectory = join(current, "docs");
		try {
			if ((await stat(docsDirectory)).isDirectory()) {
				await collectMarkdownTree(docsDirectory, candidates, cwd, projectRoot, budgets.maxFiles * 2);
			}
		} catch {
			// No nearby docs directory.
		}
		if (current === projectRoot) break;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
		distance++;
	}
	await collectMarkdownTree(join(projectRoot, "docs"), candidates, cwd, projectRoot, budgets.maxFiles * 2);
	await collectPackageScripts(cwd, projectRoot, candidates);

	for (const explicit of options.explicitPaths ?? []) {
		if (isUrl(explicit)) {
			diagnostics.push({
				code: "unsupported_url",
				severity: "warning",
				message: "URL documents are unsupported in M3; use the future web_fetch capability",
				path: explicit,
			});
			continue;
		}
		const explicitPath = normalizeExplicitPath(explicit, cwd);
		const extension = extname(explicitPath).toLocaleLowerCase();
		if (extension !== ".json" && !MARKDOWN_EXTENSIONS.has(extension)) {
			diagnostics.push({
				code: "unsupported_type",
				severity: "warning",
				message: "Only local Markdown and package.json documents are supported",
				path: explicitPath,
			});
			continue;
		}
		try {
			if (!(await stat(explicitPath)).isFile()) throw new Error("Not a file");
			addCandidate(candidates, explicitPath, kindForPath(explicitPath), "explicit", cwd, 0);
		} catch {
			diagnostics.push({
				code: "not_found",
				severity: "warning",
				message: "Explicit document was not found",
				path: explicitPath,
			});
		}
	}

	const orderedCandidates = [...candidates.values()].sort(
		(left, right) =>
			left.priority - right.priority ||
			left.directoryDistance - right.directoryDistance ||
			left.path.localeCompare(right.path),
	);
	const files: DocumentDiscoveryFile[] = [];
	const canonicalFiles = new Set<string>();
	let totalBytes = 0;
	let truncated = false;
	for (const candidate of orderedCandidates) {
		if (files.length >= budgets.maxFiles) {
			truncated = true;
			break;
		}
		const file = await loadCandidate(candidate, cwd, budgets, diagnostics);
		if (!file) continue;
		if (canonicalFiles.has(file.canonicalPath)) continue;
		canonicalFiles.add(file.canonicalPath);
		if (totalBytes + file.size > budgets.maxTotalBytes) {
			truncated = true;
			diagnostics.push({
				code: "byte_budget_exceeded",
				severity: "warning",
				message: `Stopped indexing after reaching the ${budgets.maxTotalBytes}-byte document budget`,
				path: file.path,
			});
			break;
		}
		if (
			!isUnderPath(file.path, projectRoot) &&
			!isUnderPath(file.path, agentDir) &&
			!candidate.sources.has("explicit")
		) {
			diagnostics.push({
				code: "outside_scope",
				severity: "warning",
				message: "Skipped document outside project scope",
				path: file.path,
			});
			continue;
		}
		// Hashing here is deliberately content-based. mtime/size are only metadata for diagnostics and display.
		void hashDocumentContent(file.content);
		files.push(file);
		totalBytes += file.size;
	}
	if (
		orderedCandidates.length >
		files.length + diagnostics.filter((diagnostic) => diagnostic.code === "unreadable").length
	) {
		truncated ||= files.length >= budgets.maxFiles;
	}
	return { files, diagnostics, truncated, totalBytes };
}
