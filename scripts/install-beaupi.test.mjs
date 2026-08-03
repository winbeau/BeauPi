import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("install.sh", () => {
	let tempDir;
	let releaseDir;
	let binDir;
	let installRoot;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "beaupi-installer-test-"));
		releaseDir = join(tempDir, "release");
		binDir = join(tempDir, "bin");
		installRoot = join(tempDir, "share", "beaupi");
		const bundleDir = join(tempDir, "bundle", "beaupi");
		mkdirSync(bundleDir, { recursive: true });
		mkdirSync(releaseDir, { recursive: true });
		writeFileSync(join(bundleDir, "package.json"), `${JSON.stringify({ name: "@winbeau/beaupi", version: "1.2.3" }, null, 2)}\n`);
		writeFileSync(join(bundleDir, "beaupi"), "#!/bin/sh\nprintf 'BeauPi 1.2.3\\n'\n");
		chmodSync(join(bundleDir, "beaupi"), 0o755);
		const archive = join(releaseDir, "beaupi-linux-x64.tar.gz");
		execFileSync("tar", ["-czf", archive, "-C", join(tempDir, "bundle"), "beaupi"]);
		writeFileSync(join(releaseDir, "SHA256SUMS"), `${sha256(archive)}  beaupi-linux-x64.tar.gz\n`);
	});

	afterEach(() => {
		rmSync(tempDir, { force: true, recursive: true });
	});

	function installerEnv() {
		return {
			...process.env,
			BEAUPI_BIN_DIR: binDir,
			BEAUPI_DOWNLOAD_BASE_URL: `file://${releaseDir}`,
			BEAUPI_INSTALL_ROOT: installRoot,
			BEAUPI_PLATFORM: "linux-x64",
		};
	}

	it("installs a verified versioned bundle and command symlink", () => {
		const result = spawnSync("sh", ["install.sh", "--version", "1.2.3"], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: installerEnv(),
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Installed BeauPi 1\.2\.3/);
		assert.equal(execFileSync(join(binDir, "beaupi"), { encoding: "utf8" }), "BeauPi 1.2.3\n");
		assert.equal(readFileSync(join(installRoot, "1.2.3", "package.json"), "utf8").includes("@winbeau/beaupi"), true);
	});

	it("rejects a checksum mismatch without installing", () => {
		writeFileSync(join(releaseDir, "SHA256SUMS"), `${"0".repeat(64)}  beaupi-linux-x64.tar.gz\n`);
		const result = spawnSync("sh", ["install.sh"], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: installerEnv(),
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Checksum verification failed/);
	});

	it("removes the command and installed bundles", () => {
		mkdirSync(join(installRoot, "1.2.3"), { recursive: true });
		mkdirSync(binDir, { recursive: true });
		symlinkSync(join(installRoot, "1.2.3", "beaupi"), join(binDir, "beaupi"));
		const result = spawnSync("sh", ["install.sh", "--uninstall"], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: installerEnv(),
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Removed BeauPi/);
		assert.equal(spawnSync("test", ["-e", join(binDir, "beaupi")]).status, 1);
		assert.equal(spawnSync("test", ["-e", installRoot]).status, 1);
	});
});
