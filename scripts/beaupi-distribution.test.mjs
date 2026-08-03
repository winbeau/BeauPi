import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BEAUPI_REPOSITORY,
	rewriteDistributionLockfile,
	rewriteDistributionPackageJson,
	rewriteDistributionText,
} from "./beaupi-distribution.mjs";

describe("BeauPi distribution metadata", () => {
	it("rewrites package names, internal dependencies, and repository metadata", () => {
		const rewritten = rewriteDistributionPackageJson({
			name: "@earendil-works/pi-coding-agent",
			version: "1.2.3",
			dependencies: {
				"@earendil-works/pi-agent-core": "^1.2.3",
				chalk: "5.6.2",
			},
			repository: {
				type: "git",
				url: "git+https://github.com/earendil-works/pi.git",
				directory: "packages/coding-agent",
			},
		});

		assert.equal(rewritten.name, "@winbeau/beaupi");
		assert.deepEqual(rewritten.dependencies, {
			"@winbeau/beaupi-agent-core": "1.2.3",
			chalk: "5.6.2",
		});
		assert.deepEqual(rewritten.repository, {
			type: "git",
			url: `git+https://github.com/${BEAUPI_REPOSITORY}.git`,
			directory: "packages/coding-agent",
		});
		assert.equal(rewritten.publishConfig.access, "public");
	});

	it("rewrites internal lockfile tarball URLs and dependency ranges", () => {
		const rewritten = rewriteDistributionLockfile({
			name: "@winbeau/beaupi",
			version: "1.0.0",
			lockfileVersion: 3,
			packages: {
				"": {
					name: "@winbeau/beaupi",
					version: "1.0.0",
					dependencies: { "@winbeau/beaupi-agent-core": "1.0.0" },
				},
				"node_modules/@winbeau/beaupi-agent-core": {
					version: "1.0.0",
					resolved: "https://registry.npmjs.org/@winbeau/beaupi-agent-core/-/pi-agent-core-1.0.0.tgz",
					integrity: "sha512-source-package",
					dependencies: { "@winbeau/beaupi-ai": "^1.0.0" },
				},
			},
		});

		assert.equal(
			rewritten.packages["node_modules/@winbeau/beaupi-agent-core"].resolved,
			"https://registry.npmjs.org/@winbeau/beaupi-agent-core/-/beaupi-agent-core-1.0.0.tgz",
		);
		assert.equal(rewritten.packages["node_modules/@winbeau/beaupi-agent-core"].integrity, undefined);
		assert.equal(
			rewritten.packages["node_modules/@winbeau/beaupi-agent-core"].dependencies["@winbeau/beaupi-ai"],
			"1.0.0",
		);
	});

	it("rewrites package imports including subpath exports", () => {
		const source = [
			'import { stream } from "@earendil-works/pi-ai";',
			'import { Agent } from "@earendil-works/pi-agent-core/base";',
			'import { TUI } from "@earendil-works/pi-tui";',
			'import { createAgentSession } from "@earendil-works/pi-coding-agent";',
		].join("\n");

		assert.equal(
			rewriteDistributionText(source),
			[
				'import { stream } from "@winbeau/beaupi-ai";',
				'import { Agent } from "@winbeau/beaupi-agent-core/base";',
				'import { TUI } from "@winbeau/beaupi-tui";',
				'import { createAgentSession } from "@winbeau/beaupi";',
			].join("\n"),
		);
	});
});
