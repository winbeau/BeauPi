import type { LookupAddress } from "node:dns";
import { lookup as defaultLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { PlaywrightDiagnosticCode } from "./types.ts";

const METADATA_HOSTNAMES = new Set([
	"metadata",
	"metadata.google.internal",
	"instance-data",
	"instance-data.ec2.internal",
	"metadata.azure.internal",
]);

const LOOPBACK_V4 = new BlockList();
LOOPBACK_V4.addSubnet("127.0.0.0", 8, "ipv4");
const PRIVATE_V4 = new BlockList();
for (const [network, prefix] of [
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
] as const) {
	PRIVATE_V4.addSubnet(network, prefix, "ipv4");
}
const ALWAYS_BLOCKED_V4 = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8],
	["169.254.0.0", 16],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	ALWAYS_BLOCKED_V4.addSubnet(network, prefix, "ipv4");
}
const PRIVATE_V6 = new BlockList();
PRIVATE_V6.addSubnet("fc00::", 7, "ipv6");
const ALWAYS_BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [
	["::", 128],
	["::ffff:0:0", 96],
	["64:ff9b::", 96],
	["100::", 64],
	["2001:db8::", 32],
	["2001:10::", 28],
	["fe80::", 10],
	["ff00::", 8],
] as const) {
	ALWAYS_BLOCKED_V6.addSubnet(network, prefix, "ipv6");
}

export type PlaywrightDnsLookup = (hostname: string) => Promise<LookupAddress[]>;

export class PlaywrightNetworkPolicyError extends Error {
	readonly code: PlaywrightDiagnosticCode;

	constructor(code: PlaywrightDiagnosticCode, message: string) {
		super(message);
		this.name = "PlaywrightNetworkPolicyError";
		this.code = code;
	}
}

function normalizeHostname(hostname: string): string {
	return hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
}

function isLoopback(address: string): boolean {
	const family = isIP(address);
	return family === 4 ? LOOPBACK_V4.check(address, "ipv4") : family === 6 && address === "::1";
}

function isPrivate(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return PRIVATE_V4.check(address, "ipv4");
	if (family === 6) return PRIVATE_V6.check(address, "ipv6");
	return false;
}

function isAlwaysBlocked(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return ALWAYS_BLOCKED_V4.check(address, "ipv4");
	if (family === 6) return ALWAYS_BLOCKED_V6.check(address, "ipv6");
	return true;
}

export interface PlaywrightUrlValidation {
	url: string;
	hostname?: string;
	addresses: LookupAddress[];
	loopback: boolean;
	privateNetwork: boolean;
}

export interface PlaywrightNetworkPolicyOptions {
	allowPrivateNetwork: boolean;
	lookup?: PlaywrightDnsLookup;
}

export class PlaywrightNetworkPolicy {
	private readonly allowPrivateNetwork: boolean;
	private readonly lookup: PlaywrightDnsLookup;
	private readonly dnsCache = new Map<string, LookupAddress[]>();

	constructor(options: PlaywrightNetworkPolicyOptions) {
		this.allowPrivateNetwork = options.allowPrivateNetwork;
		this.lookup =
			options.lookup ?? (async (hostname) => await defaultLookup(hostname, { all: true, verbatim: true }));
	}

	async validate(input: string, kind: "navigation" | "request" = "navigation"): Promise<PlaywrightUrlValidation> {
		let url: URL;
		try {
			url = new URL(input);
		} catch {
			throw new PlaywrightNetworkPolicyError("invalid_url", "Playwright requires a valid absolute URL.");
		}
		if (url.username || url.password) {
			throw new PlaywrightNetworkPolicyError("blocked_target", "URLs containing embedded credentials are blocked.");
		}
		if (url.protocol === "about:" && url.href === "about:blank") {
			return { url: url.href, addresses: [], loopback: false, privateNetwork: false };
		}
		const allowedProtocols = kind === "request" ? ["http:", "https:", "ws:", "wss:"] : ["http:", "https:"];
		if (!allowedProtocols.includes(url.protocol)) {
			throw new PlaywrightNetworkPolicyError(
				"blocked_target",
				`Playwright blocked the ${url.protocol || "unknown"} protocol. Only HTTP(S) navigation is allowed.`,
			);
		}
		const hostname = normalizeHostname(url.hostname);
		if (!hostname) throw new PlaywrightNetworkPolicyError("invalid_url", "The URL does not contain a hostname.");
		if (METADATA_HOSTNAMES.has(hostname)) {
			throw new PlaywrightNetworkPolicyError("blocked_target", "Cloud metadata hostnames are always blocked.");
		}
		if (hostname === "localhost" || hostname.endsWith(".localhost")) {
			return { url: url.toString(), hostname, addresses: [], loopback: true, privateNetwork: false };
		}

		let addresses: LookupAddress[];
		const family = isIP(hostname);
		if (family) {
			addresses = [{ address: hostname, family }];
		} else {
			const cached = this.dnsCache.get(hostname);
			if (cached) {
				addresses = cached;
			} else {
				try {
					addresses = await this.lookup(hostname);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new PlaywrightNetworkPolicyError(
						"navigation",
						`DNS resolution failed for ${hostname}: ${message}`,
					);
				}
				if (addresses.length > 0) this.dnsCache.set(hostname, addresses);
			}
		}
		if (addresses.length === 0) {
			throw new PlaywrightNetworkPolicyError("navigation", `DNS returned no addresses for ${hostname}.`);
		}
		if (addresses.some((address) => isAlwaysBlocked(address.address))) {
			throw new PlaywrightNetworkPolicyError(
				"blocked_target",
				"The browser target resolves to a metadata, link-local, reserved, multicast, or unspecified address.",
			);
		}
		const loopback = addresses.some((address) => isLoopback(address.address));
		const privateNetwork = addresses.some((address) => isPrivate(address.address));
		if (privateNetwork && !this.allowPrivateNetwork) {
			throw new PlaywrightNetworkPolicyError(
				"blocked_target",
				"The browser target resolves to a private LAN or carrier-grade NAT address. Set playwright.allowPrivateNetwork only for a trusted project.",
			);
		}
		return { url: url.toString(), hostname, addresses, loopback, privateNetwork };
	}
}
