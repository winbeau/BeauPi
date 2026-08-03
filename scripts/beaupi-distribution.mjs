#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const BEAUPI_REPOSITORY = "winbeau/beaupi";
export const BEAUPI_PACKAGES = [
	{
		directory: "packages/ai",
		publishName: "@winbeau/beaupi-ai",
		sourceName: "@earendil-works/pi-ai",
	},
	{
		directory: "packages/tui",
		publishName: "@winbeau/beaupi-tui",
		sourceName: "@earendil-works/pi-tui",
	},
	{
		directory: "packages/agent",
		publishName: "@winbeau/beaupi-agent-core",
		sourceName: "@earendil-works/pi-agent-core",
	},
	{
		directory: "packages/storage/sqlite-node",
		publishName: "@winbeau/beaupi-storage-sqlite-node",
		sourceName: "@earendil-works/pi-storage-sqlite-node",
	},
	{
		directory: "packages/coding-agent",
		publishName: "@winbeau/beaupi",
		sourceName: "@earendil-works/pi-coding-agent",
	},
];

const packageNameMap = new Map(BEAUPI_PACKAGES.map((pkg) => [pkg.sourceName, pkg.publishName]));
const publishPackageNames = new Set(packageNameMap.values());
const textReplacements = [...packageNameMap.entries()].sort(([left], [right]) => right.length - left.length);
const textExtensions = new Set([
	".cjs",
	".css",
	".d.ts",
	".html",
	".js",
	".json",
	".map",
	".md",
	".mjs",
	".sh",
	".ts",
	".txt",
	".yaml",
	".yml",
]);

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		shell: process.platform === "win32",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `${command} ${args.join(" ")} failed\n${output}` : `${command} ${args.join(" ")} failed`);
	}
	return result.stdout ?? "";
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function rewriteDependencyNames(dependencies, version) {
	if (!dependencies) return dependencies;
	return Object.fromEntries(
		Object.entries(dependencies).map(([name, spec]) => {
			const publishName = packageNameMap.get(name);
			return [publishName ?? name, publishName ? version : spec];
		}),
	);
}

export function rewriteDistributionPackageJson(packageJson) {
	const rewritten = structuredClone(packageJson);
	rewritten.name = packageNameMap.get(rewritten.name) ?? rewritten.name;
	for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
		if (rewritten[field]) {
			rewritten[field] = rewriteDependencyNames(rewritten[field], rewritten.version);
		}
	}
	rewritten.repository = {
		type: "git",
		url: `git+https://github.com/${BEAUPI_REPOSITORY}.git`,
		...(packageJson.repository?.directory ? { directory: packageJson.repository.directory } : {}),
	};
	rewritten.homepage = `https://github.com/${BEAUPI_REPOSITORY}`;
	rewritten.bugs = { url: `https://github.com/${BEAUPI_REPOSITORY}/issues` };
	rewritten.publishConfig = { ...(rewritten.publishConfig ?? {}), access: "public" };
	return rewritten;
}

export function rewriteDistributionText(content) {
	let rewritten = content;
	for (const [sourceName, publishName] of textReplacements) {
		rewritten = rewritten.replaceAll(sourceName, publishName);
	}
	return rewritten;
}

function rewritePublishedDependencySpecs(dependencies, version) {
	if (!dependencies) return dependencies;
	return Object.fromEntries(
		Object.entries(dependencies).map(([name, spec]) => [name, publishPackageNames.has(name) ? version : spec]),
	);
}

function findPublishedPackageName(lockPath, entry) {
	if (publishPackageNames.has(entry.name)) return entry.name;
	return [...publishPackageNames].find((name) => lockPath.endsWith(`node_modules/${name}`));
}

function registryTarballUrl(packageName, version) {
	const unscopedName = packageName.slice(packageName.indexOf("/") + 1);
	return `https://registry.npmjs.org/${packageName}/-/${unscopedName}-${version}.tgz`;
}

export function rewriteDistributionLockfile(lockfile) {
	const rewritten = structuredClone(lockfile);
	const releaseVersion = rewritten.version ?? rewritten.packages?.[""]?.version;
	for (const [lockPath, entry] of Object.entries(rewritten.packages ?? {})) {
		entry.dependencies = rewritePublishedDependencySpecs(entry.dependencies, releaseVersion);
		const packageName = findPublishedPackageName(lockPath, entry);
		if (!packageName) continue;
		entry.resolved = registryTarballUrl(packageName, entry.version ?? releaseVersion);
		delete entry.integrity;
	}
	for (const [name, entry] of Object.entries(rewritten.dependencies ?? {})) {
		entry.requires = rewritePublishedDependencySpecs(entry.requires, releaseVersion);
		if (!publishPackageNames.has(name)) continue;
		entry.resolved = registryTarballUrl(name, entry.version ?? releaseVersion);
		delete entry.integrity;
	}
	return rewritten;
}

function shouldRewriteTextFile(path) {
	const extension = path.endsWith(".d.ts") ? ".d.ts" : extname(path).toLowerCase();
	return textExtensions.has(extension) || basename(path) === "LICENSE";
}

function rewriteDirectory(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			rewriteDirectory(path);
			continue;
		}
		if (!entry.isFile() || !shouldRewriteTextFile(path)) continue;
		const content = readFileSync(path, "utf8");
		const rewritten = rewriteDistributionText(content);
		if (rewritten !== content) {
			writeFileSync(path, rewritten);
		}
	}
}

function packageSlug(packageName) {
	return packageName.replace(/^@/, "").replaceAll("/", "-");
}

function packDirectory(directory, destination) {
	mkdirSync(destination, { recursive: true });
	const output = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], {
		capture: true,
		cwd: directory,
	});
	const packed = JSON.parse(output)[0];
	return join(destination, packed.filename);
}

function extractPackage(tarball, destination) {
	mkdirSync(destination, { recursive: true });
	run("tar", ["-xzf", tarball, "-C", destination]);
	const extracted = join(destination, "package");
	if (!existsSync(extracted)) {
		throw new Error(`Packed archive did not contain package/: ${tarball}`);
	}
	return extracted;
}

export function prepareBeauPiPackages(options) {
	const repoRoot = resolve(options.repoRoot ?? process.cwd());
	const outDir = resolve(options.outDir);
	const workspaceDir = join(outDir, "packages");
	const tarballDir = join(outDir, "tarballs");
	const temporaryDir = mkdtempSync(join(tmpdir(), "beaupi-package-source-"));
	const prepared = [];

	rmSync(outDir, { force: true, recursive: true });
	mkdirSync(workspaceDir, { recursive: true });
	mkdirSync(tarballDir, { recursive: true });

	try {
		for (const pkg of BEAUPI_PACKAGES) {
			const sourceDir = join(repoRoot, pkg.directory);
			const sourcePackageJson = readJson(join(sourceDir, "package.json"));
			if (sourcePackageJson.name !== pkg.sourceName) {
				throw new Error(`${pkg.directory}/package.json has name ${sourcePackageJson.name}, expected ${pkg.sourceName}`);
			}
			if (!existsSync(join(sourceDir, "dist"))) {
				throw new Error(`${pkg.directory}/dist does not exist. Build packages before preparing the distribution.`);
			}

			const sourceTarballDir = join(temporaryDir, packageSlug(pkg.sourceName));
			const sourceTarball = packDirectory(sourceDir, sourceTarballDir);
			const extractedDir = extractPackage(sourceTarball, join(sourceTarballDir, "extracted"));
			const preparedDir = join(workspaceDir, packageSlug(pkg.publishName));
			renameSync(extractedDir, preparedDir);
			rewriteDirectory(preparedDir);
			const preparedPackageJsonPath = join(preparedDir, "package.json");
			const preparedPackageJson = rewriteDistributionPackageJson(readJson(preparedPackageJsonPath));
			writeJson(preparedPackageJsonPath, preparedPackageJson);
			const shrinkwrapPath = join(preparedDir, "npm-shrinkwrap.json");
			if (existsSync(shrinkwrapPath)) {
				const shrinkwrap = readJson(shrinkwrapPath);
				shrinkwrap.name = preparedPackageJson.name;
				shrinkwrap.packages[""] = {
					...shrinkwrap.packages[""],
					name: preparedPackageJson.name,
					dependencies: preparedPackageJson.dependencies,
				};
				writeJson(shrinkwrapPath, rewriteDistributionLockfile(shrinkwrap));
			}

			if (preparedPackageJson.name !== pkg.publishName) {
				throw new Error(`Prepared package has name ${preparedPackageJson.name}, expected ${pkg.publishName}`);
			}
			const tarball = packDirectory(preparedDir, tarballDir);
			prepared.push({ ...pkg, directory: preparedDir, tarball, version: preparedPackageJson.version });
		}
	} finally {
		rmSync(temporaryDir, { force: true, recursive: true });
	}

	return prepared;
}

export function writeDistributionPackageJson(sourcePath, outputPath) {
	mkdirSync(dirname(outputPath), { recursive: true });
	writeJson(outputPath, rewriteDistributionPackageJson(readJson(sourcePath)));
}

export function writeBeauPiInstallLock(outputDirectory, repoRoot = process.cwd()) {
	const sourceDirectory = join(repoRoot, "packages/coding-agent/install-lock");
	const packageJson = rewriteDistributionPackageJson(
		JSON.parse(rewriteDistributionText(readFileSync(join(sourceDirectory, "package.json"), "utf8"))),
	);
	const lockfile = rewriteDistributionLockfile(
		JSON.parse(rewriteDistributionText(readFileSync(join(sourceDirectory, "package-lock.json"), "utf8"))),
	);
	mkdirSync(outputDirectory, { recursive: true });
	const packageJsonPath = join(outputDirectory, "beaupi-install-package.json");
	const lockfilePath = join(outputDirectory, "beaupi-install-package-lock.json");
	writeJson(packageJsonPath, packageJson);
	writeJson(lockfilePath, lockfile);
	return { lockfilePath, packageJsonPath };
}

function parseCli(args) {
	const [command, ...rest] = args;
	const options = {};
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (!["--out", "--source"].includes(arg)) {
			throw new Error(`Unknown option: ${arg}`);
		}
		const value = rest[++index];
		if (!value) throw new Error(`${arg} requires a value`);
		if (arg === "--out") options.out = value;
		if (arg === "--source") options.source = value;
	}
	return { command, options };
}

function printUsage() {
	console.log(`Usage:
  node scripts/beaupi-distribution.mjs prepare --out <directory>
  node scripts/beaupi-distribution.mjs install-lock --out <directory>
  node scripts/beaupi-distribution.mjs package-json --source <package.json> --out <package.json>`);
}

function main(args) {
	const { command, options } = parseCli(args);
	if (command === "prepare") {
		if (!options.out) throw new Error("prepare requires --out");
		const prepared = prepareBeauPiPackages({ outDir: options.out });
		for (const pkg of prepared) console.log(`${pkg.publishName}@${pkg.version}: ${pkg.tarball}`);
		return;
	}
	if (command === "install-lock") {
		if (!options.out) throw new Error("install-lock requires --out");
		const result = writeBeauPiInstallLock(resolve(options.out));
		console.log(result.packageJsonPath);
		console.log(result.lockfilePath);
		return;
	}
	if (command === "package-json") {
		if (!options.source || !options.out) throw new Error("package-json requires --source and --out");
		writeDistributionPackageJson(resolve(options.source), resolve(options.out));
		console.log(resolve(options.out));
		return;
	}
	printUsage();
	process.exitCode = 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
