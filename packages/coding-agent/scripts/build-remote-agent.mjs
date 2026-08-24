#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const source = join(packageRoot, "src/remote-agent/main.ts");
const outputDirectory = join(packageRoot, "dist/remote-agent");
const outputPath = join(outputDirectory, "beaupi-agent.mjs");
const manifestPath = join(outputDirectory, "manifest.json");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));

await mkdir(outputDirectory, { recursive: true });
await build({
	absWorkingDir: repoRoot,
	entryPoints: [source],
	bundle: true,
	platform: "node",
	format: "esm",
	target: ["node22.19"],
	outfile: outputPath,
	logLevel: "silent",
	legalComments: "none",
	sourcemap: false,
	metafile: false,
});

const bytes = await readFile(outputPath);
const text = bytes.toString("utf8");
for (const forbidden of ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "playwright", "AgentSession", "Provider auth"]) {
	if (text.includes(forbidden)) throw new Error(`Remote Agent bundle contains forbidden dependency marker: ${forbidden}`);
}
const manifest = {
	version: 1,
	protocolVersion: 1,
	agentVersion: String(packageJson.version),
	minimumNodeVersion: "22.19.0",
	file: "beaupi-agent.mjs",
	sha256: createHash("sha256").update(bytes).digest("hex"),
	bytes: bytes.length,
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`, { mode: 0o600 });
await chmod(outputPath, 0o600);
process.stdout.write(`${outputPath}\n${manifestPath}\n`);
