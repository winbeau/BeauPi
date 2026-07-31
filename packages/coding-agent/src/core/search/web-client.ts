import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup as defaultLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { BlockList, isIP } from "node:net";
import { Agent, ProxyAgent, request } from "undici";
import { classifyNetworkError, createTimedSignal, raceWithSignal, SearchRuntimeError } from "./errors.ts";
import { canonicalizeWebUrl } from "./normalize.ts";
import type { SearchDiagnostic } from "./types.ts";

const METADATA_HOSTNAMES = new Set([
	"metadata",
	"metadata.google.internal",
	"instance-data",
	"instance-data.ec2.internal",
]);

const BLOCKED_IPV4_ADDRESSES = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	BLOCKED_IPV4_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
const BLOCKED_IPV6_ADDRESSES = new BlockList();
for (const [network, prefix] of [
	["::", 128],
	["::1", 128],
	["::ffff:0:0", 96],
	["64:ff9b::", 96],
	["100::", 64],
	["2001:db8::", 32],
	["2001:10::", 28],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const) {
	BLOCKED_IPV6_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

export type WebDnsLookup = (hostname: string) => Promise<LookupAddress[]>;

export interface SafeWebClientOptions {
	lookup?: WebDnsLookup;
	/** Test-only hostname exceptions still pin DNS to the injected resolved address. */
	allowHostnames?: ReadonlySet<string>;
	/** Environment source for standard HTTP(S)_PROXY and NO_PROXY settings. */
	environment?: NodeJS.ProcessEnv;
}

export interface SafeWebResponse {
	requestedUrl: string;
	finalUrl: string;
	statusCode: number;
	contentType: string;
	body: Buffer;
	redirects: number;
}

function blockedTarget(message: string): SearchRuntimeError {
	return new SearchRuntimeError({
		code: "blocked_target",
		severity: "error",
		message,
	});
}

export function isBlockedWebAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return BLOCKED_IPV4_ADDRESSES.check(address, "ipv4");
	if (family === 6) return BLOCKED_IPV6_ADDRESSES.check(address, "ipv6");
	return true;
}

function pinnedLookup(addresses: readonly LookupAddress[]): LookupFunction {
	return (_hostname: string, options: LookupOptions, callback) => {
		const requestedFamily = typeof options.family === "number" ? options.family : 0;
		const eligible = addresses.filter((address) => requestedFamily === 0 || address.family === requestedFamily);
		if (eligible.length === 0) {
			const error = new Error("No address matched the requested family") as NodeJS.ErrnoException;
			error.code = "ENOTFOUND";
			callback(error, "", 0);
			return;
		}
		if (options.all) {
			callback(
				null,
				eligible.map((address) => ({ ...address })),
			);
			return;
		}
		callback(null, eligible[0]!.address, eligible[0]!.family);
	};
}

function firstEnvironmentValue(environment: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = environment[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

function noProxyPatternMatches(hostname: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) return hostname.endsWith(pattern.slice(1));
	if (pattern.startsWith(".")) return hostname === pattern.slice(1) || hostname.endsWith(pattern);
	if (pattern.includes("*")) {
		const expression = pattern
			.split("*")
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*");
		return new RegExp(`^${expression}$`, "i").test(hostname);
	}
	return hostname === pattern || hostname.endsWith(`.${pattern}`);
}

function noProxyMatches(url: URL, value: string | undefined): boolean {
	if (!value) return false;
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const port = url.port || (url.protocol === "https:" ? "443" : "80");
	for (const rawEntry of value.split(",")) {
		let entry = rawEntry.trim().toLowerCase();
		if (!entry) continue;
		if (entry === "<local>" && !hostname.includes(".")) return true;
		let entryPort: string | undefined;
		if (entry.startsWith("[")) {
			const closing = entry.indexOf("]");
			if (closing !== -1) {
				entryPort = entry[closing + 1] === ":" ? entry.slice(closing + 2) : undefined;
				entry = entry.slice(1, closing);
			}
		} else {
			const colon = entry.lastIndexOf(":");
			if (colon !== -1 && entry.indexOf(":") === colon && /^\d+$/.test(entry.slice(colon + 1))) {
				entryPort = entry.slice(colon + 1);
				entry = entry.slice(0, colon);
			}
		}
		if (entryPort && entryPort !== port) continue;
		if (noProxyPatternMatches(hostname, entry)) return true;
	}
	return false;
}

function proxyUrlFor(url: URL, environment: NodeJS.ProcessEnv): string | undefined {
	const noProxy = firstEnvironmentValue(environment, ["NO_PROXY", "no_proxy"]);
	if (noProxyMatches(url, noProxy)) return undefined;
	const configured =
		url.protocol === "https:"
			? firstEnvironmentValue(environment, [
					"HTTPS_PROXY",
					"https_proxy",
					"HTTP_PROXY",
					"http_proxy",
					"ALL_PROXY",
					"all_proxy",
				])
			: firstEnvironmentValue(environment, ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]);
	if (!configured) return undefined;
	try {
		const proxy = new URL(configured);
		return ["http:", "https:", "socks:", "socks5:"].includes(proxy.protocol) ? proxy.toString() : undefined;
	} catch {
		return undefined;
	}
}

function firstHeader(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function contentTypeHeader(value: string | string[] | undefined): string {
	return (firstHeader(value) ?? "application/octet-stream").split(";", 1)[0]!.trim().toLowerCase();
}

async function readLimitedBody(body: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of body) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
		total += buffer.byteLength;
		if (total > maxBytes) {
			throw new SearchRuntimeError({
				code: "body_too_large",
				severity: "error",
				message: "The response exceeded the configured byte limit.",
				suggestion: "Increase search.budget.maxFetchBytes only for a trusted target.",
			});
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

function httpFailure(statusCode: number, retryAfter: string | undefined): SearchRuntimeError {
	if (statusCode === 429) {
		const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
		return new SearchRuntimeError({
			code: "rate_limited",
			severity: "error",
			message: "The web target rate limit was reached.",
			statusCode,
			retryAfterMs: Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined,
		});
	}
	return new SearchRuntimeError({
		code: "http",
		severity: "error",
		message: `The web target returned HTTP ${statusCode}.`,
		statusCode,
	});
}

export class SafeWebClient {
	private readonly lookup: WebDnsLookup;
	private readonly allowHostnames: ReadonlySet<string>;
	private readonly environment: NodeJS.ProcessEnv;

	constructor(options: SafeWebClientOptions = {}) {
		this.lookup =
			options.lookup ?? (async (hostname) => await defaultLookup(hostname, { all: true, verbatim: true }));
		this.allowHostnames = options.allowHostnames ?? new Set();
		this.environment = options.environment ?? process.env;
	}

	async fetch(
		input: string,
		options: { signal?: AbortSignal; timeoutMs: number; maxBytes: number; maxRedirects: number },
	): Promise<SafeWebResponse> {
		let requestedUrl: string;
		try {
			requestedUrl = canonicalizeWebUrl(input);
		} catch {
			throw new SearchRuntimeError({
				code: "invalid_url",
				severity: "error",
				message: "web_fetch requires an HTTP or HTTPS URL without credentials.",
			});
		}
		const timed = createTimedSignal(options.signal, options.timeoutMs);
		let current = requestedUrl;
		let redirects = 0;
		try {
			while (true) {
				const resolved = await this.validateAndResolve(current, timed.signal);
				const originalUrl = new URL(resolved.url);
				const proxyUrl = resolved.allowPrivate ? undefined : proxyUrlFor(originalUrl, this.environment);
				const pinnedAddress = resolved.addresses.find((address) => address.family === 4) ?? resolved.addresses[0]!;
				const requestUrl = new URL(originalUrl);
				if (proxyUrl) requestUrl.hostname = pinnedAddress.address;
				const dispatcher = proxyUrl
					? new ProxyAgent({
							uri: proxyUrl,
							proxyTunnel: originalUrl.protocol === "https:",
							connections: 1,
							connectTimeout: options.timeoutMs,
							headersTimeout: options.timeoutMs,
							bodyTimeout: options.timeoutMs,
							maxResponseSize: options.maxBytes + 1,
							requestTls: originalUrl.protocol === "https:" ? { servername: originalUrl.hostname } : undefined,
						})
					: new Agent({
							connections: 1,
							connectTimeout: options.timeoutMs,
							headersTimeout: options.timeoutMs,
							bodyTimeout: options.timeoutMs,
							maxResponseSize: options.maxBytes + 1,
							autoSelectFamily: true,
							autoSelectFamilyAttemptTimeout: 250,
							connect: { lookup: pinnedLookup(resolved.addresses) },
						});
				try {
					const response = await request(requestUrl, {
						method: "GET",
						dispatcher,
						signal: timed.signal,
						headers: {
							accept: "text/html, text/plain, application/json;q=0.9",
							"accept-encoding": "identity",
							"user-agent": "BeauPi-web-fetch/1.0 (+https://github.com/earendil-works/pi)",
							...(proxyUrl ? { host: originalUrl.host } : {}),
						},
						headersTimeout: options.timeoutMs,
						bodyTimeout: options.timeoutMs,
					});
					if (response.statusCode >= 300 && response.statusCode < 400) {
						const location = firstHeader(response.headers.location);
						await response.body.dump({ limit: 64 * 1024, signal: timed.signal }).catch(() => {});
						if (!location) throw httpFailure(response.statusCode, undefined);
						if (redirects >= options.maxRedirects) {
							throw new SearchRuntimeError({
								code: "redirect_limit",
								severity: "error",
								message: "The web target exceeded the configured redirect limit.",
								suggestion: "Increase search.budget.maxRedirects only for a trusted target.",
							});
						}
						try {
							current = canonicalizeWebUrl(new URL(location, resolved.url).toString());
						} catch {
							throw new SearchRuntimeError({
								code: "invalid_url",
								severity: "error",
								message: "The web target returned an invalid redirect URL.",
							});
						}
						redirects++;
						continue;
					}
					if (response.statusCode < 200 || response.statusCode >= 300) {
						await response.body.dump({ limit: 64 * 1024, signal: timed.signal }).catch(() => {});
						throw httpFailure(response.statusCode, firstHeader(response.headers["retry-after"]));
					}
					const declaredLength = Number(firstHeader(response.headers["content-length"]));
					if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
						await response.body.dump({ limit: 64 * 1024, signal: timed.signal }).catch(() => {});
						throw new SearchRuntimeError({
							code: "body_too_large",
							severity: "error",
							message: "The response exceeded the configured byte limit.",
							suggestion: "Increase search.budget.maxFetchBytes only for a trusted target.",
						});
					}
					return {
						requestedUrl,
						finalUrl: current,
						statusCode: response.statusCode,
						contentType: contentTypeHeader(response.headers["content-type"]),
						body: await readLimitedBody(response.body, options.maxBytes),
						redirects,
					};
				} finally {
					await dispatcher.close().catch(() => {});
				}
			}
		} catch (error) {
			if (error instanceof SearchRuntimeError) throw error;
			throw new SearchRuntimeError(
				classifyNetworkError(error, {
					operation: "fetch",
					cancelled: options.signal?.aborted === true,
					timedOut: timed.timedOut(),
				}),
			);
		} finally {
			timed.cleanup();
		}
	}

	private async validateAndResolve(
		input: string,
		signal: AbortSignal,
	): Promise<{ url: string; addresses: LookupAddress[]; allowPrivate: boolean }> {
		let url: URL;
		try {
			url = new URL(input);
		} catch {
			throw new SearchRuntimeError({ code: "invalid_url", severity: "error", message: "Invalid web URL." });
		}
		const hostname = url.hostname
			.toLowerCase()
			.replace(/^\[|\]$/g, "")
			.replace(/\.$/, "");
		if (hostname === "localhost" || hostname.endsWith(".localhost") || METADATA_HOSTNAMES.has(hostname)) {
			throw blockedTarget("The web target is a blocked local or metadata hostname.");
		}
		const allowPrivate = this.allowHostnames.has(hostname);
		let addresses: LookupAddress[];
		if (isIP(hostname)) {
			addresses = [{ address: hostname, family: isIP(hostname) }];
		} else {
			try {
				addresses = await raceWithSignal(this.lookup(hostname), signal);
			} catch (error) {
				if (signal.aborted) throw error;
				throw new SearchRuntimeError(
					classifyNetworkError(error, { operation: "fetch", cancelled: false, timedOut: false }),
				);
			}
		}
		if (addresses.length === 0) {
			throw new SearchRuntimeError({ code: "dns", severity: "error", message: "DNS returned no addresses." });
		}
		if (!allowPrivate && addresses.some((address) => isBlockedWebAddress(address.address))) {
			throw blockedTarget(
				"The web target resolves to a loopback, private, link-local, metadata, or reserved address.",
			);
		}
		return { url: canonicalizeWebUrl(url.toString()), addresses, allowPrivate };
	}
}

export function unsupportedContentTypeDiagnostic(contentType: string): SearchDiagnostic {
	return {
		code: "unsupported_content_type",
		severity: "error",
		message: `Unsupported web content type: ${contentType || "unknown"}.`,
		suggestion: "M8 supports HTML, plain text, and JSON; PDF extraction is not implemented.",
	};
}
