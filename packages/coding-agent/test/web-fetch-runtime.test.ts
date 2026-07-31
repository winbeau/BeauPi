import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	canonicalizeWebUrl,
	resolveSearchConfig,
	SafeWebClient,
	SearchCache,
	SearchRuntime,
	type WebDnsLookup,
} from "../src/core/search/index.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "beaupi-fetch-test-"));
	cleanups.push(async () => await rm(path, { recursive: true, force: true }));
	return path;
}

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(
		async () =>
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	);
	return (server.address() as AddressInfo).port;
}

function runtimeConfig(
	options: {
		fetchTtlMs?: number;
		maxBytes?: number;
		maxInputCharacters?: number;
		timeoutMs?: number;
		maxRedirects?: number;
	} = {},
) {
	return resolveSearchConfig(
		{
			searxng: { endpoint: "http://unused.test" },
			cache: { queryTtlMs: 1_000, fetchTtlMs: options.fetchTtlMs ?? 1_000 },
			budget: {
				maxResultsPerSearch: 10,
				maxQueriesPerTask: 6,
				maxFetchesPerTask: 20,
				maxProviderAttemptsPerTask: 6,
				maxFetchBytes: options.maxBytes ?? 200_000,
				maxInputCharactersPerTask: options.maxInputCharacters ?? 200_000,
				timeoutMs: options.timeoutMs ?? 100,
				maxRedirects: options.maxRedirects ?? 3,
			},
		},
		{},
	);
}

function testLookup(): WebDnsLookup {
	return async (hostname) => {
		if (hostname === "fetch.test" || hostname === "tls.test") return [{ address: "127.0.0.1", family: 4 }];
		const error = new Error("not found") as NodeJS.ErrnoException;
		error.code = "ENOTFOUND";
		throw error;
	};
}

async function setupServer(): Promise<{ port: number; counts: Map<string, number> }> {
	const counts = new Map<string, number>();
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://fetch.test");
		counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
		if (url.pathname === "/html") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html>
				<html><head><title>Example Article</title><style>.bad{}</style></head><body>
				<nav>Home Products Pricing</nav><main><h1>Example Article</h1><p>Useful first paragraph.</p>
				<script>throw new Error('never execute')</script><ul><li>First item</li><li>Second item</li></ul>
				<p>Repeated meaningful sentence for dedupe.</p><p>Repeated meaningful sentence for dedupe.</p></main>
				<footer>Copyright links</footer></body></html>`);
			return;
		}
		if (url.pathname === "/text" || url.pathname === "/text-copy") {
			response.writeHead(200, { "content-type": "text/plain" }).end("plain text\nsecond line\n");
			return;
		}
		if (url.pathname === "/json") {
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, value: 3 }));
			return;
		}
		if (url.pathname === "/bad-json") {
			response.writeHead(200, { "content-type": "application/json" }).end("{broken");
			return;
		}
		if (url.pathname === "/large") {
			response
				.writeHead(200, { "content-type": "text/plain" })
				.end(Array.from({ length: 8_000 }, (_, index) => `line ${index} ${"x".repeat(12)}`).join("\n"));
			return;
		}
		if (url.pathname === "/too-large") {
			response.writeHead(200, { "content-type": "text/plain", "content-length": "100000" }).end("x".repeat(100_000));
			return;
		}
		if (url.pathname === "/redirect") {
			response.writeHead(302, { location: "/html" }).end();
			return;
		}
		if (url.pathname === "/private-redirect") {
			response
				.writeHead(302, { location: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/html` })
				.end();
			return;
		}
		if (url.pathname === "/redirect-loop") {
			response.writeHead(302, { location: "/redirect-loop" }).end();
			return;
		}
		if (url.pathname === "/slow") {
			setTimeout(() => response.writeHead(200, { "content-type": "text/plain" }).end("late"), 80);
			return;
		}
		if (url.pathname === "/rate") {
			response.writeHead(429, { "retry-after": "1" }).end("limited");
			return;
		}
		if (url.pathname === "/error") {
			response.writeHead(503).end("unavailable");
			return;
		}
		if (url.pathname === "/pdf") {
			response.writeHead(200, { "content-type": "application/pdf" }).end("%PDF");
			return;
		}
		response.writeHead(404).end("missing");
	});
	return { port: await listen(server), counts };
}

function createRuntime(
	cacheDir: string,
	config: ReturnType<typeof runtimeConfig>,
	options: { now?: () => number } = {},
): SearchRuntime {
	return new SearchRuntime({
		cacheDir,
		getConfig: () => config,
		webClient: new SafeWebClient({
			lookup: testLookup(),
			allowHostnames: new Set(["fetch.test", "tls.test"]),
		}),
		now: options.now,
	});
}

describe("M8 web_fetch runtime", () => {
	it("extracts HTML body as Markdown while removing scripts, styles, navigation noise, and duplicates", async () => {
		const cacheDir = await tempDir();
		const { port } = await setupServer();
		const runtime = createRuntime(cacheDir, runtimeConfig());
		const result = await runtime.fetch(`http://fetch.test:${port}/html`, { budgetScopeId: "html" });

		expect(result.ok).toBe(true);
		expect(result.title).toBe("Example Article");
		expect(result.content).toContain("# Example Article");
		expect(result.content).toContain("- First item");
		expect(result.content).not.toContain("throw new Error");
		expect(result.content).not.toContain("Home Products Pricing");
		expect(result.content?.match(/Repeated meaningful sentence/g)).toHaveLength(1);
		expect(result.citation).toMatchObject({ level: "content", contentHash: result.contentHash });
	});

	it("fetches plain text and JSON with stable content hashes", async () => {
		const cacheDir = await tempDir();
		const { port } = await setupServer();
		const runtime = createRuntime(cacheDir, runtimeConfig());
		const text = await runtime.fetch(`http://fetch.test:${port}/text`, { budgetScopeId: "text" });
		const json = await runtime.fetch(`http://fetch.test:${port}/json`, { budgetScopeId: "json" });

		expect(text.content).toContain("plain text");
		expect(text.contentType).toBe("text/plain");
		expect(json.content).toContain('"ok": true');
		expect(json.contentHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("uses URL cache hit/miss/TTL, rebuilds malformed entries, and avoids duplicate body injection by hash", async () => {
		const cacheDir = await tempDir();
		const { port, counts } = await setupServer();
		let now = 1_000;
		const config = runtimeConfig({ fetchTtlMs: 1_000 });
		const runtime = createRuntime(cacheDir, config, { now: () => now });
		const url = `http://fetch.test:${port}/text`;

		const first = await runtime.fetch(url, { budgetScopeId: "task" });
		const second = await runtime.fetch(url, { budgetScopeId: "task" });
		expect(first.cacheStatus).toBe("miss");
		expect(second.cacheStatus).toBe("hit");
		expect(second.duplicateContent).toBe(true);
		expect(second.content).toBeUndefined();
		expect(counts.get("/text")).toBe(1);
		const sameHashDifferentUrl = await runtime.fetch(`http://fetch.test:${port}/text-copy`, {
			budgetScopeId: "task",
		});
		expect(sameHashDifferentUrl.duplicateContent).toBe(true);
		expect(sameHashDifferentUrl.contentHash).toBe(first.contentHash);

		now = 2_001;
		const expired = await runtime.fetch(url, { budgetScopeId: "fresh-scope" });
		expect(expired.cacheStatus).toBe("miss");
		expect(counts.get("/text")).toBe(2);

		const corruptUrl = canonicalizeWebUrl(`http://fetch.test:${port}/json`);
		const cache = new SearchCache(cacheDir);
		await mkdir(join(cacheDir, "urls"), { recursive: true });
		await writeFile(
			cache.pathFor("urls", corruptUrl),
			JSON.stringify({ version: 1, canonicalKey: corruptUrl }),
			"utf-8",
		);
		const rebuilt = await runtime.fetch(corruptUrl, { budgetScopeId: "corrupt" });
		expect(rebuilt.ok).toBe(true);
		expect(rebuilt.diagnostics.map((item) => item.code)).toContain("cache_corrupt");
	});

	it("truncates large model output, writes full content to a private temp file, and keeps the complete hash", async () => {
		const cacheDir = await tempDir();
		const { port } = await setupServer();
		const runtime = createRuntime(cacheDir, runtimeConfig({ maxBytes: 200_000 }));
		const result = await runtime.fetch(`http://fetch.test:${port}/large`, { budgetScopeId: "large" });

		expect(result.ok).toBe(true);
		expect(result.truncation?.truncated).toBe(true);
		expect(result.fullOutputPath).toBeDefined();
		const full = await readFile(result.fullOutputPath!, "utf-8");
		expect(full.length).toBeGreaterThan(result.content?.length ?? 0);
		expect(full).toContain("line 7999");
		expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
		await rm(result.fullOutputPath!, { force: true });
	});

	it("enforces response size, redirect, HTTP, rate-limit, format, and content-type diagnostics", async () => {
		const cacheDir = await tempDir();
		const { port } = await setupServer();
		const small = createRuntime(cacheDir, runtimeConfig({ maxBytes: 128, maxRedirects: 1 }));
		const cases = [
			["/too-large", "body_too_large"],
			["/redirect-loop", "redirect_limit"],
			["/error", "http"],
			["/rate", "rate_limited"],
			["/bad-json", "invalid_response"],
			["/pdf", "unsupported_content_type"],
		] as const;
		for (const [path, code] of cases) {
			const result = await small.fetch(`http://fetch.test:${port}${path}`, { budgetScopeId: path });
			expect(result.ok, path).toBe(false);
			expect(result.diagnostics[0]?.code, path).toBe(code);
		}
	});

	it("revalidates every redirect and blocks localhost, loopback, private, link-local, metadata, credentials, and unsafe protocols", async () => {
		const cacheDir = await tempDir();
		const { port } = await setupServer();
		const runtime = createRuntime(cacheDir, runtimeConfig());
		const blocked = [
			"http://localhost/",
			"http://127.0.0.1/",
			"http://10.0.0.1/",
			"http://169.254.169.254/latest/meta-data/",
			"http://metadata.google.internal/",
			`http://fetch.test:${port}/private-redirect`,
		];
		for (const url of blocked) {
			const result = await runtime.fetch(url, { budgetScopeId: url });
			expect(result.ok, url).toBe(false);
			expect(result.diagnostics[0]?.code, url).toBe("blocked_target");
		}
		for (const url of ["ftp://example.com/file", "https://user:pass@example.com/"]) {
			const result = await runtime.fetch(url, { budgetScopeId: url });
			expect(result.diagnostics[0]?.code).toBe("invalid_url");
		}
	});

	it("supports safe redirects and classifies DNS, TLS, timeout, cancellation, and fetch-count budget exhaustion", async () => {
		const cacheDir = await tempDir();
		const { port } = await setupServer();
		const config = runtimeConfig();
		const runtime = createRuntime(cacheDir, config);
		const redirect = await runtime.fetch(`http://fetch.test:${port}/redirect`, { budgetScopeId: "redirect" });
		expect(redirect.ok).toBe(true);
		expect(redirect.redirects).toBe(1);
		expect(redirect.finalUrl).toContain("/html");

		const dns = await runtime.fetch("http://does-not-exist.test/", { budgetScopeId: "dns" });
		expect(dns.diagnostics[0]?.code).toBe("dns");

		const tls = await runtime.fetch(`https://tls.test:${port}/html`, { budgetScopeId: "tls" });
		expect(tls.diagnostics[0]?.code).toBe("tls");

		const timedRuntime = createRuntime(join(cacheDir, "timed"), runtimeConfig({ timeoutMs: 20 }));
		const timedOut = await timedRuntime.fetch(`http://fetch.test:${port}/slow`, { budgetScopeId: "timeout" });
		expect(timedOut.diagnostics[0]?.code).toBe("timeout");

		const controller = new AbortController();
		const promise = timedRuntime.fetch(`http://fetch.test:${port}/slow`, {
			budgetScopeId: "cancel",
			signal: controller.signal,
		});
		controller.abort();
		const cancelled = await promise;
		expect(cancelled.diagnostics[0]?.code).toBe("cancelled");

		const characterBounded = createRuntime(join(cacheDir, "characters"), runtimeConfig({ maxInputCharacters: 10 }));
		const partial = await characterBounded.fetch(`http://fetch.test:${port}/text`, {
			budgetScopeId: "characters",
		});
		expect(partial.budget.exhausted).toBe("input_characters");
		if (partial.fullOutputPath) await rm(partial.fullOutputPath, { force: true });
		const stopped = await characterBounded.fetch(`http://fetch.test:${port}/json`, {
			budgetScopeId: "characters",
		});
		expect(stopped.ok).toBe(false);
		expect(stopped.budget.exhausted).toBe("input_characters");

		const oneFetchConfig = {
			...config,
			budget: { ...config.budget, maxFetchesPerTask: 1 },
		};
		const bounded = createRuntime(join(cacheDir, "bounded"), oneFetchConfig);
		await bounded.fetch(`http://fetch.test:${port}/text`, { budgetScopeId: "bounded" });
		const exhausted = await bounded.fetch(`http://fetch.test:${port}/json`, { budgetScopeId: "bounded" });
		expect(exhausted.budget.exhausted).toBe("fetches");
	});
});
