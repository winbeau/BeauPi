import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup as defaultLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { BlockList, isIP } from "node:net";
import { Agent, request } from "undici";
import { classifyNetworkError, createTimedSignal, raceWithSignal, SearchRuntimeError } from "./errors.ts";
import { canonicalizeWebUrl } from "./normalize.ts";
import type { SearchDiagnostic } from "./types.ts";

const METADATA_HOSTNAMES = new Set([
	"metadata",
	"metadata.google.internal",
	"instance-data",
	"instance-data.ec2.internal",
]);

const BLOCKED_ADDRESSES = new BlockList();
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
	BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
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
	BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

export type WebDnsLookup = (hostname: string) => Promise<LookupAddress[]>;

export interface SafeWebClientOptions {
	lookup?: WebDnsLookup;
	/** Test-only hostname exceptions still pin DNS to the injected resolved address. */
	allowHostnames?: ReadonlySet<string>;
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

function isBlockedAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return BLOCKED_ADDRESSES.check(address, "ipv4");
	if (family === 6) return BLOCKED_ADDRESSES.check(address, "ipv6");
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

	constructor(options: SafeWebClientOptions = {}) {
		this.lookup =
			options.lookup ?? (async (hostname) => await defaultLookup(hostname, { all: true, verbatim: true }));
		this.allowHostnames = options.allowHostnames ?? new Set();
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
				const url = await this.validateAndResolve(current, timed.signal);
				const addresses = url.addresses;
				const dispatcher = new Agent({
					connections: 1,
					connectTimeout: options.timeoutMs,
					headersTimeout: options.timeoutMs,
					bodyTimeout: options.timeoutMs,
					maxResponseSize: options.maxBytes + 1,
					connect: { lookup: pinnedLookup(addresses) },
				});
				try {
					const response = await request(url.url, {
						method: "GET",
						dispatcher,
						signal: timed.signal,
						headers: {
							accept: "text/html, text/plain, application/json;q=0.9",
							"accept-encoding": "identity",
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
							current = canonicalizeWebUrl(new URL(location, url.url).toString());
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
	): Promise<{ url: string; addresses: LookupAddress[] }> {
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
		if (!allowPrivate && addresses.some((address) => isBlockedAddress(address.address))) {
			throw blockedTarget(
				"The web target resolves to a loopback, private, link-local, metadata, or reserved address.",
			);
		}
		return { url: canonicalizeWebUrl(url.toString()), addresses };
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
