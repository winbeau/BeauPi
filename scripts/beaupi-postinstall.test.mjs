import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	applyBeauPiConfigOverwrite,
	BEAUPI_CONFIG_OVERWRITE_VERSION,
} from "../packages/coding-agent/postinstall.mjs";

const tempDirs = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createAgentDir() {
	const agentDir = mkdtempSync(join(tmpdir(), "beaupi-postinstall-"));
	tempDirs.push(agentDir);
	return agentDir;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

describe("BeauPi npm postinstall", () => {
	it("overwrites settings, models, and auth once while retaining permission-restricted backups", () => {
		const agentDir = createAgentDir();
		const originals = {
			"settings.json": { theme: "light", review: { model: "old/reviewer" } },
			"models.json": { providers: { custom: { baseUrl: "https://old.example.test" } } },
			"auth.json": { openai: { type: "api_key", key: "secret" } },
		};
		for (const [name, value] of Object.entries(originals)) {
			writeFileSync(join(agentDir, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
		}

		assert.equal(
			applyBeauPiConfigOverwrite({
				agentDir,
				packageName: "@winbeau/beaupi",
				version: BEAUPI_CONFIG_OVERWRITE_VERSION,
			}),
			true,
		);
		assert.deepEqual(readJson(join(agentDir, "settings.json")), {
			review: { model: "openai/gpt-5.6-luna" },
			models: { providers: {} },
		});
		assert.deepEqual(readJson(join(agentDir, "models.json")), {});
		assert.deepEqual(readJson(join(agentDir, "auth.json")), {});

		const backupDir = join(agentDir, "backups", `config-overwrite-v${BEAUPI_CONFIG_OVERWRITE_VERSION}`);
		for (const [name, value] of Object.entries(originals)) {
			assert.deepEqual(readJson(join(backupDir, name)), value);
			if (process.platform !== "win32") assert.equal(statSync(join(backupDir, name)).mode & 0o777, 0o600);
		}
		if (process.platform !== "win32") {
			for (const name of Object.keys(originals)) assert.equal(statSync(join(agentDir, name)).mode & 0o777, 0o600);
		}

		writeFileSync(join(agentDir, "auth.json"), '{"preserved":true}\n', { mode: 0o600 });
		assert.equal(
			applyBeauPiConfigOverwrite({
				agentDir,
				packageName: "@winbeau/beaupi",
				version: BEAUPI_CONFIG_OVERWRITE_VERSION,
			}),
			false,
		);
		assert.deepEqual(readJson(join(agentDir, "auth.json")), { preserved: true });
	});

	it("runs from npm lifecycle environment variables", () => {
		const agentDir = createAgentDir();
		writeFileSync(join(agentDir, "auth.json"), '{"old":true}\n', { mode: 0o600 });
		const result = spawnSync(process.execPath, [fileURLToPath(new URL("../packages/coding-agent/postinstall.mjs", import.meta.url))], {
			encoding: "utf8",
			env: {
				...process.env,
				BEAUPI_CODING_AGENT_DIR: agentDir,
				npm_package_name: "@winbeau/beaupi",
				npm_package_version: BEAUPI_CONFIG_OVERWRITE_VERSION,
			},
		});

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(readJson(join(agentDir, "auth.json")), {});
		assert.deepEqual(
			readJson(join(agentDir, "backups", `config-overwrite-v${BEAUPI_CONFIG_OVERWRITE_VERSION}`, "auth.json")),
			{ old: true },
		);
	});

	it("does not modify config for source packages or other versions", () => {
		const agentDir = createAgentDir();
		const authPath = join(agentDir, "auth.json");
		writeFileSync(authPath, '{"preserved":true}\n', { mode: 0o600 });

		assert.equal(
			applyBeauPiConfigOverwrite({
				agentDir,
				packageName: "@earendil-works/pi-coding-agent",
				version: BEAUPI_CONFIG_OVERWRITE_VERSION,
			}),
			false,
		);
		assert.equal(
			applyBeauPiConfigOverwrite({ agentDir, packageName: "@winbeau/beaupi", version: "1.0.2" }),
			false,
		);
		assert.deepEqual(readJson(authPath), { preserved: true });
	});
});
