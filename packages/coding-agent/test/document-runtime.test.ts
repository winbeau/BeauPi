import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentRuntime } from "../src/core/documents/document-runtime.ts";
import { indexMarkdownDocument } from "../src/core/documents/markdown.ts";
import { type DocumentReference, hashDocumentContent, stableDocumentId } from "../src/core/documents/types.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { loadProjectContextFiles } from "../src/core/resource-loader.ts";
import { createTestResourceLoader } from "./utilities.ts";

const tempDirs: string[] = [];

function tempProject(): { root: string; cwd: string; agentDir: string } {
	const root = join(tmpdir(), `beaupi-docs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const cwd = join(root, "packages", "app", "src");
	const agentDir = join(root, ".beaupi-agent");
	mkdirSync(join(root, ".git"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	tempDirs.push(root);
	return { root, cwd, agentDir };
}

function loaderFor(cwd: string, agentDir: string): ResourceLoader {
	return {
		...createTestResourceLoader(),
		getAgentsFiles: () => ({ agentsFiles: loadProjectContextFiles({ cwd, agentDir }) }),
	};
}

function runtimeFor(
	cwd: string,
	agentDir: string,
	budgets?: ConstructorParameters<typeof DocumentRuntime>[0]["budgets"],
): DocumentRuntime {
	return new DocumentRuntime({
		cwd,
		agentDir,
		resourceLoader: loaderFor(cwd, agentDir),
		budgets,
		now: () => 1_700_000_000_000,
	});
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const path = tempDirs.pop();
		if (path) rmSync(path, { recursive: true, force: true });
	}
});

describe("DocumentRuntime discovery", () => {
	it("reuses AGENTS/CLAUDE ancestor precedence and discovers project, nearby, docs, and nearest package scripts", async () => {
		const { root, cwd, agentDir } = tempProject();
		writeFileSync(join(agentDir, "AGENTS.md"), "# Global Rules\n\n- Must keep global behavior.\n");
		writeFileSync(join(root, "AGENTS.md"), "# Root Rules\n\n- Must run root checks.\n");
		writeFileSync(join(root, "packages", "app", "CLAUDE.md"), "# Package Rules\n\n- Must keep package scope.\n");
		writeFileSync(join(root, "README.md"), "# Project\n");
		writeFileSync(join(root, "CONTRIBUTING.md"), "# Testing\n\n```sh\nnpm run check\n```\n");
		mkdirSync(join(root, "docs"), { recursive: true });
		writeFileSync(join(root, "docs", "runtime.md"), "# Runtime\n\nDocument contract details.\n");
		writeFileSync(join(cwd, "NOTES.md"), "# Nearby Notes\n");
		writeFileSync(
			join(root, "packages", "app", "package.json"),
			JSON.stringify({ scripts: { check: "npm run lint", test: "vitest --run" } }, null, 2),
		);
		mkdirSync(join(root, "node_modules", "ignored"), { recursive: true });
		writeFileSync(join(root, "node_modules", "ignored", "README.md"), "ignored");
		mkdirSync(join(root, "dist"), { recursive: true });
		writeFileSync(join(root, "dist", "generated.md"), "ignored");
		symlinkSync(join(root, "docs", "runtime.md"), join(cwd, "runtime-link.md"));

		const discovered = await runtimeFor(cwd, agentDir).discover();
		const displays = discovered.documents.map((document) => document.reference.displayPath);
		expect(displays.some((path) => path.endsWith("/.beaupi-agent/AGENTS.md"))).toBe(true);
		expect(displays.some((path) => path.endsWith("/AGENTS.md"))).toBe(true);
		expect(displays.some((path) => path.endsWith("/CLAUDE.md"))).toBe(true);
		expect(displays.some((path) => path.endsWith("/README.md"))).toBe(true);
		expect(displays.some((path) => path.endsWith("/CONTRIBUTING.md"))).toBe(true);
		expect(displays.some((path) => path.endsWith("/docs/runtime.md"))).toBe(true);
		expect(displays).toContain("NOTES.md");
		expect(displays.some((path) => path.includes("node_modules"))).toBe(false);
		expect(displays.some((path) => path.includes("dist/generated.md"))).toBe(false);
		const runtimeDocuments = discovered.documents.filter((document) =>
			document.reference.path.endsWith("docs/runtime.md"),
		);
		expect(runtimeDocuments).toHaveLength(1);
		const packageDocument = discovered.documents.find((document) => document.reference.kind === "package-json");
		expect(packageDocument?.packageScripts.map((script) => script.name)).toEqual(["check", "test"]);
		const sources = discovered.documents.map((document) => document.reference.source);
		expect(sources).toContain("global");
		expect(sources).toContain("ancestor");
		expect(sources).toContain("project");
		expect(sources).toContain("nearby");
		expect(sources).toContain("package");
	});

	it("reports unsupported URLs without network fallback and enforces file/byte budgets", async () => {
		const { root, cwd, agentDir } = tempProject();
		mkdirSync(join(root, "docs"), { recursive: true });
		writeFileSync(join(root, "docs", "large.md"), "x".repeat(200));
		writeFileSync(join(root, "docs", "small.md"), "# Small\n");
		const runtime = runtimeFor(cwd, agentDir, { maxFileBytes: 100, maxFiles: 1, maxTotalBytes: 100 });
		const discovered = await runtime.discover(["https://example.com/rules.md"]);
		expect(discovered.diagnostics.some((diagnostic) => diagnostic.code === "unsupported_url")).toBe(true);
		expect(discovered.diagnostics.some((diagnostic) => diagnostic.code === "file_too_large")).toBe(true);
		expect(discovered.documents.length).toBeLessThanOrEqual(1);
	});
});

describe("Markdown indexing and reads", () => {
	it("indexes ATX and Setext headings, ignores fenced headings, and keeps 1-based ranges", () => {
		const content = [
			"# Top",
			"intro",
			"```md",
			"## Not a heading",
			"```",
			"Subsection",
			"----------",
			"body",
			"### Deep",
			"end",
		].join("\n");
		const reference: DocumentReference = {
			id: stableDocumentId("document", "/repo/doc.md"),
			path: "/repo/doc.md",
			displayPath: "doc.md",
			kind: "markdown",
			source: "project",
			sources: ["project"],
			directoryDistance: 0,
			hash: hashDocumentContent(content),
			size: Buffer.byteLength(content),
			critical: false,
		};
		const indexed = indexMarkdownDocument(reference, content);
		expect(
			indexed.headings.map((heading) => [heading.level, heading.path.join("/"), heading.startLine, heading.endLine]),
		).toEqual([
			[1, "Top", 1, 10],
			[2, "Top/Subsection", 6, 10],
			[3, "Top/Subsection/Deep", 9, 10],
		]);
		expect(indexed.codeBlocks[0]).toMatchObject({ startLine: 3, contentStartLine: 4, endLine: 5 });
	});

	it("reads by heading and explicit line ranges", async () => {
		const { root, cwd, agentDir } = tempProject();
		mkdirSync(join(root, "docs"), { recursive: true });
		writeFileSync(join(root, "docs", "guide.md"), "# Guide\nintro\n## Testing\nnpm run check\n## Done\nfinished\n");
		const runtime = runtimeFor(cwd, agentDir);
		const heading = await runtime.read({ document: join(root, "docs", "guide.md"), heading: "Guide/Testing" });
		expect(heading.content).toBe("## Testing\nnpm run check");
		expect(heading.citation).toMatchObject({ startLine: 3, endLine: 4, headingPath: ["Guide", "Testing"] });
		const range = await runtime.read({ document: join(root, "docs", "guide.md"), offset: 2, limit: 3 });
		expect(range.content).toBe("intro\n## Testing\nnpm run check");
		expect(range.citation).toMatchObject({ startLine: 2, endLine: 4 });
	});
});

describe("Execution Contract", () => {
	it("extracts conservative requirements, commands, checks, completion criteria, and package scripts", async () => {
		const { root, cwd, agentDir } = tempProject();
		writeFileSync(
			join(root, "AGENTS.md"),
			[
				"# Rules",
				"- Must not use sudo.",
				"- Keep descriptions concise.",
				"# Testing",
				"- Must run `npm run check`.",
				"```sh",
				"./test.sh",
				"```",
				"# Completion",
				"- All documented checks must pass.",
			].join("\n"),
		);
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ scripts: { check: "npm run lint", lint: "eslint ." } }, null, 2),
		);
		const runtime = runtimeFor(cwd, agentDir);
		const result = await runtime.resolveTask({ task: "Implement document runtime and verify it" });
		expect(result.contract.id).toMatch(/^contract_/);
		expect(result.contract.requirements.map((item) => item.text)).toEqual(
			expect.arrayContaining(["Must not use sudo.", "Keep descriptions concise.", "Must run `npm run check`."]),
		);
		expect(result.contract.allowedCommands.map((item) => item.command)).toEqual(
			expect.arrayContaining(["npm run check", "./test.sh", "npm run lint", "eslint ."]),
		);
		expect(result.contract.requiredChecks.flatMap((item) => item.commands)).toEqual(
			expect.arrayContaining(["npm run check", "./test.sh", "npm run lint"]),
		);
		expect(result.contract.completionCriteria.some((item) => item.text.includes("checks must pass"))).toBe(true);
		expect(result.contract.stopConditions.some((item) => item.text === "Must not use sudo.")).toBe(true);
		for (const requirement of result.contract.requirements)
			expect(requirement.citations[0]?.documentHash).toHaveLength(64);

		const stable = await runtime.resolveTask({ task: "Implement document runtime and verify it" });
		expect(stable.contract.id).toBe(result.contract.id);
		expect(stable.contract.createdAt).toBe(result.contract.createdAt);
	});

	it("preserves conflicting requirements and both source citations", async () => {
		const { root, cwd, agentDir } = tempProject();
		writeFileSync(join(root, "AGENTS.md"), "# Rules\n- Must run integration tests.\n");
		mkdirSync(join(root, "docs"), { recursive: true });
		writeFileSync(join(root, "docs", "constraints.md"), "# Constraints\n- Must not run integration tests.\n");
		const result = await runtimeFor(cwd, agentDir).resolveTask({ task: "integration tests" });
		const conflict = result.contract.diagnostics.find((diagnostic) => diagnostic.code === "conflict");
		expect(conflict?.citations).toHaveLength(2);
		expect(result.contract.requirements.filter((item) => item.text.includes("integration tests"))).toHaveLength(2);
	});

	it("marks only referenced document changes stale, rebuilds, and deterministically recovers on the original hash", async () => {
		const { root, cwd, agentDir } = tempProject();
		const rulesPath = join(root, "AGENTS.md");
		const unrelatedPath = join(root, "docs", "unrelated.md");
		mkdirSync(dirname(unrelatedPath), { recursive: true });
		const original = "# Rules\n- Must run npm run check.\n";
		writeFileSync(rulesPath, original);
		writeFileSync(unrelatedPath, "# Other\nnot selected phrase\n");
		const runtime = runtimeFor(cwd, agentDir);
		const initial = await runtime.resolveTask({ task: "run check" });
		expect(initial.contract.status).toBe("active");

		writeFileSync(unrelatedPath, "# Other\nchanged but unrelated\n");
		await runtime.noteFilesModified([unrelatedPath]);
		expect(runtime.getContract()?.status).toBe("active");

		writeFileSync(rulesPath, "# Rules\n- Must run npm run check twice.\n");
		await runtime.noteFilesModified([rulesPath]);
		expect(runtime.getContract()?.status).toBe("stale");
		expect(runtime.getPromptContract()).toBeUndefined();

		writeFileSync(rulesPath, original);
		await runtime.noteFilesModified([rulesPath]);
		expect(runtime.getContract()?.status).toBe("active");
		expect(runtime.getPromptContract()).toContain("Must run npm run check");

		writeFileSync(rulesPath, "# Rules\n- Must run npm run check twice.\n");
		const rebuilt = await runtime.resolveTask({ task: "run check", refresh: true });
		expect(rebuilt.contract.status).toBe("active");
		expect(rebuilt.contract.id).not.toBe(initial.contract.id);
	});
});
