#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BEAUPI_PACKAGES, prepareBeauPiPackages } from "./beaupi-distribution.mjs";

const dryRun = process.argv.includes("--dry-run");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");
if (unknownArgs.length > 0) {
	console.error("Usage: node scripts/publish.mjs [--dry-run]");
	process.exit(1);
}

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`);
	}
	return result;
}

function readPackageJson(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function isPublished(name, version) {
	const result = spawnSync(commandForPlatform("npm"), ["view", `${name}@${version}`, "version", "--json"], {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	});
	if (result.status === 0 && result.stdout.trim()) return true;
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) return false;
	throw new Error(output ? `Failed to query ${name}@${version}\n${output}` : `Failed to query ${name}@${version}`);
}

function validatePack(directory) {
	const result = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true, cwd: directory });
	const packed = JSON.parse(result.stdout)[0];
	console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`);
}

const versions = new Set();
for (const pkg of BEAUPI_PACKAGES) {
	if (!existsSync(join(pkg.directory, "dist"))) {
		throw new Error(`${pkg.directory}/dist does not exist. Run npm run build before publishing.`);
	}
	versions.add(readPackageJson(pkg.directory).version);
}
if (versions.size !== 1) {
	throw new Error(`Publish packages are not lockstep versioned: ${[...versions].join(", ")}`);
}
const version = [...versions][0];
const stagingRoot = mkdtempSync(join(tmpdir(), "beaupi-publish-"));

try {
	console.log(`Publishing BeauPi packages at ${version}${dryRun ? " (dry run)" : ""}\n`);
	const prepared = prepareBeauPiPackages({ outDir: stagingRoot });
	const packageStates = prepared.map((pkg) => ({ ...pkg, published: isPublished(pkg.publishName, pkg.version) }));

	for (const pkg of packageStates) {
		console.log(`${pkg.publishName}@${pkg.version} ${pkg.published ? "is already published" : "is not published"}; validating package contents.`);
		validatePack(pkg.directory);
		console.log();
	}

	if (dryRun) process.exit(0);

	console.log("All packages validated; starting publication.\n");
	for (const pkg of packageStates) {
		if (pkg.published) {
			console.log(`Skipping ${pkg.publishName}@${pkg.version}: already published\n`);
			continue;
		}
		const publishArgs = ["publish", "--access", "public", "--ignore-scripts"];
		if (process.env.GITHUB_ACTIONS === "true") publishArgs.push("--provenance");
		run("npm", publishArgs, { cwd: pkg.directory });
		console.log();
	}
} finally {
	rmSync(stagingRoot, { force: true, recursive: true });
}
