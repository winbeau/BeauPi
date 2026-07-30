import type { SearchDiagnostic, SearchDiagnosticCode } from "./types.ts";

export class SearchRuntimeError extends Error {
	readonly diagnostic: SearchDiagnostic;

	constructor(diagnostic: SearchDiagnostic) {
		super(diagnostic.message);
		this.name = "SearchRuntimeError";
		this.diagnostic = diagnostic;
	}
}

function errorCodes(error: unknown): Set<string> {
	const codes = new Set<string>();
	let current: unknown = error;
	for (let depth = 0; depth < 5; depth++) {
		if (typeof current !== "object" || current === null) break;
		if ("code" in current && typeof (current as { code?: unknown }).code === "string") {
			codes.add((current as { code: string }).code);
		}
		current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
	}
	return codes;
}

function diagnostic(code: SearchDiagnosticCode, message: string, suggestion?: string): SearchDiagnostic {
	return { code, severity: "error", message, suggestion };
}

export function classifyNetworkError(
	error: unknown,
	options: { operation: "provider" | "fetch"; cancelled: boolean; timedOut: boolean },
): SearchDiagnostic {
	if (error instanceof SearchRuntimeError) return error.diagnostic;
	if (options.cancelled) return diagnostic("cancelled", "The network operation was cancelled.");
	if (options.timedOut) {
		return diagnostic(
			"timeout",
			"The network operation exceeded its configured timeout.",
			"Increase search.budget.timeoutMs only when the target is expected to respond slowly.",
		);
	}
	const codes = errorCodes(error);
	if (
		[...codes].some(
			(code) =>
				code.startsWith("ERR_TLS") ||
				code.startsWith("ERR_SSL") ||
				code.startsWith("CERT_") ||
				code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
				code === "SELF_SIGNED_CERT_IN_CHAIN" ||
				code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
		)
	) {
		return diagnostic("tls", "TLS validation failed for the network target.");
	}
	if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"].some((code) => codes.has(code))) {
		return diagnostic("dns", "DNS resolution failed for the network target.");
	}
	if (
		["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].some(
			(code) => codes.has(code),
		)
	) {
		return diagnostic("connection", "The network target could not be reached.");
	}
	if (codes.has("UND_ERR_HEADERS_TIMEOUT") || codes.has("UND_ERR_BODY_TIMEOUT")) {
		return diagnostic("timeout", "The network target stopped responding before the timeout budget completed.");
	}
	if (codes.has("UND_ERR_RES_EXCEEDED_MAX_SIZE")) {
		return diagnostic(
			"body_too_large",
			"The response exceeded the configured byte limit.",
			"Increase search.budget.maxFetchBytes only for a trusted target.",
		);
	}
	return diagnostic(
		options.operation === "provider" ? "connection" : "http",
		options.operation === "provider"
			? "The configured search provider request failed."
			: "The web request failed before a usable response was received.",
	);
}

export function createTimedSignal(
	parent: AbortSignal | undefined,
	timeoutMs: number,
): {
	signal: AbortSignal;
	timedOut: () => boolean;
	cleanup: () => void;
} {
	const timeoutController = new AbortController();
	let didTimeout = false;
	const timer = setTimeout(() => {
		didTimeout = true;
		timeoutController.abort();
	}, timeoutMs);
	const signal = parent ? AbortSignal.any([parent, timeoutController.signal]) : timeoutController.signal;
	return {
		signal,
		timedOut: () => didTimeout,
		cleanup: () => clearTimeout(timer),
	};
}

export async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw new DOMException("Operation aborted", "AbortError");
	return await new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(new DOMException("Operation aborted", "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
