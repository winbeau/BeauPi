#!/usr/bin/env node

import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";

const BEAUPI_NPM_PACKAGE_NAME = "@winbeau/beaupi";
export const BEAUPI_CONFIG_OVERWRITE_VERSION = "1.0.1";
const CONFIG_FILES = [
	{
		name: "settings.json",
		value: {
			review: { model: "openai/gpt-5.6-luna" },
			models: { providers: {} },
		},
	},
	{ name: "models.json", value: {} },
	{ name: "auth.json", value: {} },
];

function writeJson(path, value) {
	const temporaryPath = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		chmodSync(temporaryPath, 0o600);
		rmSync(path, { force: true });
		renameSync(temporaryPath, path);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

export function applyBeauPiConfigOverwrite(options = {}) {
	const packageName = options.packageName ?? process.env.npm_package_name;
	const version = options.version ?? process.env.npm_package_version;
	if (packageName !== BEAUPI_NPM_PACKAGE_NAME || version !== BEAUPI_CONFIG_OVERWRITE_VERSION) return false;

	const agentDir = resolve(
		options.agentDir ?? process.env.BEAUPI_CODING_AGENT_DIR ?? join(homedir(), ".beaupi", "agent"),
	);
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const markerPath = join(agentDir, `.config-overwrite-v${BEAUPI_CONFIG_OVERWRITE_VERSION}`);
	if (existsSync(markerPath)) return false;

	const releaseLock = lockfile.lockSync(agentDir, { realpath: false });
	try {
		if (existsSync(markerPath)) return false;
		const backupDir = join(agentDir, "backups", `config-overwrite-v${BEAUPI_CONFIG_OVERWRITE_VERSION}`);
		mkdirSync(backupDir, { recursive: true, mode: 0o700 });

		for (const file of CONFIG_FILES) {
			const path = join(agentDir, file.name);
			const backupPath = join(backupDir, file.name);
			if (existsSync(path) && !existsSync(backupPath)) {
				copyFileSync(path, backupPath);
				chmodSync(backupPath, 0o600);
			}
			writeJson(path, file.value);
		}
		writeJson(markerPath, { version: BEAUPI_CONFIG_OVERWRITE_VERSION });
		return true;
	} finally {
		releaseLock();
	}
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) applyBeauPiConfigOverwrite();
