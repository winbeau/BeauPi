import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentRuntime, getDocumentRuntimeToolDetails } from "../src/core/documents/index.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { loadProjectContextFiles, type ResourceLoader } from "../src/core/resource-loader.ts";
import {
	createDocsReadToolDefinition,
	createDocsResolveTaskToolDefinition,
	createDocsSearchToolDefinition,
} from "../src/core/tools/documents.ts";
import { createTestResourceLoader } from "./utilities.ts";

const roots: string[] = [];

function setup(): { root: string; cwd: string; agentDir: string; runtime: DocumentRuntime } {
	const root = join(tmpdir(), `beaupi-document-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const cwd = join(root, "packages", "app");
	const agentDir = join(root, ".agent");
	mkdirSync(join(root, ".git"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	roots.push(root);
	const resourceLoader: ResourceLoader = {
		...createTestResourceLoader(),
		getAgentsFiles: () => ({ agentsFiles: loadProjectContextFiles({ cwd, agentDir }) }),
	};
	return { root, cwd, agentDir, runtime: new DocumentRuntime({ cwd, agentDir, resourceLoader }) };
}

function context(): ExtensionContext {
	return undefined as unknown as ExtensionContext;
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

describe("document tools", () => {
	it("docs_search ranks nearby heading matches and returns structured citations without full bodies", async () => {
		const { root, cwd, runtime } = setup();
		mkdirSync(join(root, "docs"), { recursive: true });
		writeFileSync(
			join(root, "docs", "general.md"),
			`# General\nAuthentication is mentioned once.\n${"full body\n".repeat(100)}`,
		);
		writeFileSync(join(cwd, "AUTH.md"), "# Authentication\nUse refresh token rotation.\n");
		const tool = createDocsSearchToolDefinition(runtime);
		const result = await tool.execute(
			"search-1",
			{ query: "authentication refresh token" },
			undefined,
			undefined,
			context(),
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text.split("\n")[0]).toContain("AUTH.md");
		expect(text).not.toContain("full body\nfull body");
		expect(result.details.matches).toBeGreaterThan(0);
		expect(result.details.documentRuntime.citations[0]).toMatchObject({ displayPath: "AUTH.md", startLine: 1 });
		expect(getDocumentRuntimeToolDetails(result.details)?.kind).toBe("search");
	});

	it("docs_read supports headings, records resolved hash/range, and writes full truncated output", async () => {
		const { root, runtime } = setup();
		mkdirSync(join(root, "docs"), { recursive: true });
		const longBody = Array.from({ length: 2200 }, (_, index) => `line ${index + 1}`).join("\n");
		const path = join(root, "docs", "large.md");
		writeFileSync(path, `# Large\n${longBody}\n`);
		const tool = createDocsReadToolDefinition(runtime);
		const result = await tool.execute(
			"read-1",
			{ document: path, heading: "Large" },
			undefined,
			undefined,
			context(),
		);
		expect(result.details.path).toBe(path);
		expect(result.details.hash).toHaveLength(64);
		expect(result.details.startLine).toBe(1);
		expect(result.details.endLine).toBe(2202);
		expect(result.details.truncation?.truncated).toBe(true);
		expect(result.details.fullOutputPath && existsSync(result.details.fullOutputPath)).toBe(true);
		expect(result.details.fullOutputPath && readFileSync(result.details.fullOutputPath, "utf-8")).toContain(
			"line 2200",
		);
		expect(getDocumentRuntimeToolDetails(result.details)?.filesRead).toEqual([path]);
		const unsupported = await tool.execute(
			"read-url",
			{ document: "https://example.com/rules.md" },
			undefined,
			undefined,
			context(),
		);
		expect(
			getDocumentRuntimeToolDetails(unsupported.details)?.diagnostics.some(
				(diagnostic) => diagnostic.code === "unsupported_url",
			),
		).toBe(true);
	});

	it("docs_resolve_task returns a stable full contract and structured URL/conflict diagnostics", async () => {
		const { root, runtime } = setup();
		writeFileSync(join(root, "AGENTS.md"), "# Rules\n- Must run npm run check.\n");
		mkdirSync(join(root, "docs"), { recursive: true });
		writeFileSync(join(root, "docs", "conflict.md"), "# Rules\n- Must not run npm run check.\n");
		const tool = createDocsResolveTaskToolDefinition(runtime);
		const first = await tool.execute(
			"resolve-1",
			{ task: "check the project", explicitDocuments: ["https://example.com/rules.md"] },
			undefined,
			undefined,
			context(),
		);
		const second = await tool.execute("resolve-2", { task: "check the project" }, undefined, undefined, context());
		expect(first.details.contract.id).toBe(second.details.contract.id);
		expect(first.details.diagnostics.some((diagnostic) => diagnostic.code === "unsupported_url")).toBe(true);
		expect(first.details.diagnostics.some((diagnostic) => diagnostic.code === "conflict")).toBe(true);
		expect(getDocumentRuntimeToolDetails(first.details)?.contract?.id).toBe(first.details.contract.id);
	});
});
