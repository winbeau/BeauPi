import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolvePath } from "../../utils/paths.ts";
import type { SessionEntry } from "../session-manager.ts";
import type { PolicyOperationAnalysis } from "./classifier.ts";
import {
	classifyPolicyFailure,
	classifyPolicyOperation,
	policyFailureLimit,
	policyPathRequiresConfirmation,
	policyShellPathReferences,
} from "./classifier.ts";
import {
	type PendingPolicyInteraction,
	POLICY_DETAILS_VERSION,
	type PolicyAdvisory,
	type PolicyDecision,
	type PolicyFailure,
	type PolicyInteractionHandler,
	type PolicyRuntimeEvent,
	type PolicyToolDetails,
	policyFactsFromEntries,
	type ResolvedPolicyConfig,
} from "./types.ts";

const BRACED_HOME = "$" + "{HOME}";

interface ActivePolicyCall {
	analysis: PolicyOperationAnalysis;
	decision: PolicyDecision;
	createdAt: string;
	advisories: PolicyAdvisory[];
	notedFailure?: PolicyFailure;
	targetRevisionBefore: number;
	terminalBuffer?: { terminalId: string; before: string; after: string; unknownBefore: boolean };
}

export interface PolicyAuthorization {
	managed: boolean;
	execute: boolean;
	details?: PolicyToolDetails;
}

export interface PolicyRuntimeOptions {
	cwd: string;
	getConfig: () => ResolvedPolicyConfig;
	/** Internal host boundary for legacy direct AgentSession construction; production sessions leave this enabled. */
	enabled?: boolean;
	/** Legacy compatibility input. Advisory-only Policy never invokes interaction handlers. */
	handler?: PolicyInteractionHandler;
	/** Legacy compatibility input. Advisory-only Policy has no interactive mode distinction. */
	interactionMode?: "coordinator" | "controlled";
	now?: () => Date;
}

function stableRequestId(sessionId: string, toolCallId: string, signature: string): string {
	const digest = createHash("sha256").update(`${sessionId}\0${toolCallId}\0${signature}`).digest("hex").slice(0, 24);
	return `policy_${digest}`;
}

async function canonicalLocalPath(path: string, cwd: string): Promise<string> {
	const absolute = resolvePath(path, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
	let candidate = absolute;
	const suffix: string[] = [];
	for (let depth = 0; depth < 128; depth++) {
		try {
			return join(await realpath(candidate), ...suffix.reverse());
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
					? error.code
					: undefined;
			if (code !== "ENOENT" && code !== "ENOTDIR") return absolute;
			const parent = dirname(candidate);
			if (parent === candidate) return absolute;
			suffix.push(basename(candidate));
			candidate = parent;
		}
	}
	return absolute;
}

function terminalInputState(current: string, input: string): { analysisText: string; next: string; overflow: boolean } {
	const completed: string[] = [];
	let line = current;
	let overflow = false;
	for (const character of input) {
		if (character === "\r" || character === "\n") {
			completed.push(line);
			line = "";
			continue;
		}
		if (character === "\u0003" || character === "\u0015" || character === "\u0004") {
			line = "";
			continue;
		}
		if (character === "\b" || character === "\u007f") {
			line = [...line].slice(0, -1).join("");
			continue;
		}
		if (character === "\u0017") {
			line = line.replace(/\S+\s*$/, "");
			continue;
		}
		line += character;
		if (line.length > 8_192) overflow = true;
	}
	return {
		analysisText: [...completed, line].join("\n"),
		next: line,
		overflow,
	};
}

async function canonicalPolicyArgs(toolName: string, args: unknown, cwd: string): Promise<unknown> {
	if (!["read", "grep", "find", "ls", "write", "edit"].includes(toolName)) return args;
	if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
	const record = args as Record<string, unknown>;
	const pathKey =
		typeof record.path === "string" ? "path" : typeof record.file_path === "string" ? "file_path" : undefined;
	if (!pathKey) return args;
	return { ...record, [pathKey]: await canonicalLocalPath(record[pathKey] as string, cwd) };
}

async function canonicalShellReference(reference: string, cwd: string): Promise<string | undefined> {
	if (
		reference.includes("/") ||
		reference.startsWith(".") ||
		reference.startsWith("~") ||
		reference.startsWith("$HOME") ||
		reference.startsWith(BRACED_HOME)
	) {
		return await canonicalLocalPath(reference, cwd);
	}
	try {
		return await realpath(resolve(cwd, reference));
	} catch {
		return undefined;
	}
}

async function applyCanonicalShellBoundary(
	analysis: PolicyOperationAnalysis,
	toolName: string,
	args: unknown,
	cwd: string,
	config: ResolvedPolicyConfig,
): Promise<PolicyOperationAnalysis> {
	if (toolName !== "bash" || analysis.descriptor.target !== "local") return analysis;
	if (typeof args !== "object" || args === null || Array.isArray(args)) return analysis;
	const command = (args as Record<string, unknown>).command;
	if (typeof command !== "string") return analysis;
	for (const reference of policyShellPathReferences(command)) {
		const canonical = await canonicalShellReference(reference, cwd);
		if (
			!canonical ||
			!policyPathRequiresConfirmation(canonical, cwd, config, analysis.descriptor.workspaceMutation)
		) {
			continue;
		}
		return {
			...analysis,
			requiresConfirmation: true,
			descriptor: {
				...analysis.descriptor,
				classes: [...new Set([...analysis.descriptor.classes, "sensitive_path" as const])],
				sensitive: true,
			},
		};
	}
	return analysis;
}

export class PolicyRuntime {
	private readonly cwd: string;
	private readonly getConfig: () => ResolvedPolicyConfig;
	private readonly enabled: boolean;
	private readonly now: () => Date;
	private sessionId = "unbound";
	private facts: PolicyToolDetails[] = [];
	private readonly active = new Map<string, ActivePolicyCall>();
	private readonly targetRevisions = new Map<string, number>();
	private readonly terminalBuffers = new Map<string, string>();
	private readonly unknownTerminalBuffers = new Set<string>();
	private readonly listeners = new Set<(event: PolicyRuntimeEvent) => void>();
	private tail: Promise<void> = Promise.resolve();

	constructor(options: PolicyRuntimeOptions) {
		this.cwd = options.cwd;
		this.getConfig = options.getConfig;
		this.enabled = options.enabled ?? true;
		this.now = options.now ?? (() => new Date());
	}

	bindSession(sessionId: string, entries: readonly SessionEntry[]): void {
		this.sessionId = sessionId;
		this.rebuild(entries);
	}

	rebuild(entries: readonly SessionEntry[]): void {
		this.facts = policyFactsFromEntries(entries);
		this.targetRevisions.clear();
		this.terminalBuffers.clear();
		this.unknownTerminalBuffers.clear();
		this.active.clear();
		for (const fact of this.facts) {
			this.targetRevisions.set(
				fact.operation.target,
				Math.max(this.targetRevisions.get(fact.operation.target) ?? 0, fact.targetRevisionAfter),
			);
			if (fact.operation.toolName === "terminal_send" && fact.operation.target.startsWith("terminal:")) {
				const terminalId = fact.operation.target.slice("terminal:".length);
				if (fact.terminalInputPending === true) this.unknownTerminalBuffers.add(terminalId);
				else if (fact.terminalInputPending === false) this.unknownTerminalBuffers.delete(terminalId);
			} else if (fact.operation.toolName === "terminal_close" && fact.operation.target.startsWith("terminal:")) {
				this.unknownTerminalBuffers.delete(fact.operation.target.slice("terminal:".length));
			}
		}
	}

	setHandler(_handler: PolicyInteractionHandler | undefined): void {}

	getPending(): PendingPolicyInteraction | undefined {
		return undefined;
	}

	getFacts(): PolicyToolDetails[] {
		return this.facts.map((fact) => structuredClone(fact));
	}

	getAdvisories(): PolicyAdvisory[] {
		const active = [...this.active.values()];
		const advisories =
			active.length > 0 ? active.flatMap((call) => call.advisories) : (this.facts.at(-1)?.advisories ?? []);
		return advisories.map((advisory) => structuredClone(advisory));
	}

	subscribe(listener: (event: PolicyRuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	wrapTool(tool: AgentTool, getAvailableTools: () => readonly string[]): AgentTool {
		const execute = tool.execute;
		return {
			...tool,
			...(tool.name === "terminal_send" ? { executionMode: "sequential" as const } : {}),
			execute: async (toolCallId, params, signal, onUpdate) => {
				await this.authorizeTool(toolCallId, tool.name, params, getAvailableTools(), signal);
				try {
					return await execute(toolCallId, params, signal, onUpdate);
				} catch (error) {
					await this.noteThrownError(toolCallId, tool.name, error, signal);
					throw error;
				}
			},
		};
	}

	async authorizeTool(
		toolCallId: string,
		toolName: string,
		args: unknown,
		availableTools: readonly string[],
		_signal?: AbortSignal,
	): Promise<PolicyAuthorization> {
		return await this.serial(async () => {
			if (!this.enabled) return { managed: false, execute: true };
			const config = this.getConfig();
			let policyArgs = await canonicalPolicyArgs(toolName, args, this.cwd);
			let terminalBuffer: ActivePolicyCall["terminalBuffer"];
			let terminalInputOverflow = false;
			let terminalInputUnknown = false;
			let terminalInputCleanup = false;
			if (toolName === "terminal_send" && typeof args === "object" && args !== null && !Array.isArray(args)) {
				const record = args as Record<string, unknown>;
				if (typeof record.terminalId === "string" && typeof record.input === "string") {
					const unknownBefore = this.unknownTerminalBuffers.has(record.terminalId);
					const clearsRecoveredInput = /[\u0003\u0004\u0015]/.test(record.input);
					terminalInputCleanup =
						record.input.length > 0 &&
						[...record.input].every(
							(character) => character === "\u0003" || character === "\u0004" || character === "\u0015",
						);
					terminalInputUnknown = unknownBefore && !clearsRecoveredInput;
					const before = unknownBefore ? "" : (this.terminalBuffers.get(record.terminalId) ?? "");
					const state = terminalInputState(before, record.input);
					terminalBuffer = { terminalId: record.terminalId, before, after: state.next, unknownBefore };
					terminalInputOverflow = state.overflow;
					policyArgs = { ...record, input: terminalInputCleanup ? record.input : state.analysisText };
				}
			}
			const classified = classifyPolicyOperation({
				toolName,
				args: policyArgs,
				cwd: this.cwd,
				availableTools,
				config,
			});
			if (!classified) return { managed: false, execute: true };
			const analysis = await applyCanonicalShellBoundary(classified, toolName, args, this.cwd, config);
			const descriptor = analysis.descriptor;
			const targetRevisionBefore = this.targetRevisions.get(descriptor.target) ?? 0;
			const createdAt = this.now().toISOString();
			const advisories: PolicyAdvisory[] = [];
			const advise = (kind: PolicyAdvisory["kind"], message: string): void => {
				advisories.push({ version: 1, kind, message, createdAt });
			};
			const activeCall = this.active.get(toolCallId);
			if (activeCall) {
				const advisory: PolicyAdvisory = {
					version: 1,
					kind: "repeated_operation",
					message: "Reused an active Tool call id.",
					createdAt,
				};
				activeCall.advisories.push(advisory);
				this.emit({ type: "advisory", toolCallId, advisory });
				return { managed: true, execute: true };
			}
			if (descriptor.privileged) {
				advise("privileged_operation", `Detected ${descriptor.summary.toLowerCase()}.`);
			}
			if (terminalInputUnknown && !terminalInputCleanup) {
				advise("terminal_state", "Restored terminal input state is unknown.");
			}
			if (terminalInputOverflow && !terminalInputCleanup) {
				advise("terminal_state", "Terminal input exceeds the Policy inspection window.");
			}
			const terminalId =
				typeof args === "object" && args !== null && !Array.isArray(args)
					? (args as Record<string, unknown>).terminalId
					: undefined;
			if (
				toolName === "terminal_bash" &&
				typeof terminalId === "string" &&
				(this.terminalBuffers.has(terminalId) || this.unknownTerminalBuffers.has(terminalId))
			) {
				advise("terminal_state", "Terminal has pending interactive input.");
			}
			if (analysis.networkFallback && this.hasFailedDedicatedNetworkFact()) {
				advise("network_fallback", "Network fallback follows a failed dedicated Search operation.");
			}
			if (analysis.replacementTool) {
				advise("dedicated_tool_available", `Dedicated Tool available: ${analysis.replacementTool}.`);
			}
			const activate = (decision: PolicyDecision): void => {
				this.active.set(toolCallId, {
					analysis,
					decision,
					createdAt,
					advisories,
					targetRevisionBefore,
					terminalBuffer,
				});
				for (const advisory of advisories) this.emit({ type: "advisory", toolCallId, advisory });
				if (terminalBuffer) {
					this.unknownTerminalBuffers.delete(terminalBuffer.terminalId);
					if (terminalBuffer.after) this.terminalBuffers.set(terminalBuffer.terminalId, terminalBuffer.after);
					else this.terminalBuffers.delete(terminalBuffer.terminalId);
				}
			};
			if (!analysis.controlPlane) {
				const activeDuplicate =
					descriptor.readOnly &&
					[...this.active.values()].some(
						(active) =>
							active.analysis.descriptor.readOnly &&
							active.analysis.descriptor.equivalenceSignature === descriptor.equivalenceSignature &&
							active.targetRevisionBefore === targetRevisionBefore,
					);
				let completedDuplicate = false;
				for (let index = this.facts.length - 1; index >= 0; index--) {
					const fact = this.facts[index];
					if (
						fact?.executed &&
						fact.status === "succeeded" &&
						fact.operation.readOnly &&
						fact.operation.equivalenceSignature === descriptor.equivalenceSignature &&
						fact.targetRevisionAfter === targetRevisionBefore
					) {
						completedDuplicate = true;
						break;
					}
				}
				if (activeDuplicate || completedDuplicate) {
					advise("repeated_operation", `Repeated ${descriptor.summary.toLowerCase()}.`);
				}

				const equivalentFailures = this.facts.filter(
					(fact) =>
						fact.executed &&
						fact.failure !== undefined &&
						fact.failure.category !== "user_cancelled" &&
						fact.operation.equivalenceSignature === descriptor.equivalenceSignature,
				).length;
				if (equivalentFailures >= config.budget.maxEquivalentFailures) {
					advise(
						"equivalent_failures",
						`Equivalent failure budget reached for ${descriptor.summary.toLowerCase()}.`,
					);
				}

				const fallbackFacts = this.facts.filter(
					(fact) =>
						fact.executed &&
						fact.failure !== undefined &&
						fact.failure.category !== "user_cancelled" &&
						fact.operation.fallbackFamily === descriptor.fallbackFamily &&
						(descriptor.fallbackFamily === "network" || fact.operation.target === descriptor.target),
				);
				if (descriptor.fallbackFamily && fallbackFacts.length >= config.budget.maxFallbackAttempts) {
					advise("fallback_budget", `${descriptor.fallbackFamily} fallback budget reached.`);
				}
				const failureCategories = fallbackFacts
					.map((fact) => fact.failure?.category)
					.filter((category): category is NonNullable<typeof category> => category !== undefined);
				for (const category of new Set(failureCategories)) {
					const limit = policyFailureLimit(category, config);
					if (!limit) continue;
					const count = fallbackFacts.filter((fact) => fact.failure?.category === category).length;
					if (count >= limit) {
						advise("failure_budget", `${category.replaceAll("_", " ")} failure budget reached.`);
					}
				}
			}
			if (analysis.requiresConfirmation) {
				advise("sensitive_operation", `Detected ${descriptor.summary.toLowerCase()}.`);
			}
			const decision: PolicyDecision = { action: "allow" };
			activate(decision);
			return { managed: true, execute: true };
		});
	}

	async noteThrownError(toolCallId: string, toolName: string, error: unknown, signal?: AbortSignal): Promise<void> {
		await this.serial(async () => {
			const active = this.active.get(toolCallId);
			if (!active) return;
			active.notedFailure = classifyPolicyFailure({
				toolName,
				details: undefined,
				isError: true,
				thrownError: error,
				signal,
			});
		});
	}

	async finalizeTool(input: {
		toolCallId: string;
		toolName: string;
		details: unknown;
		isError: boolean;
		signal?: AbortSignal;
	}): Promise<PolicyToolDetails | undefined> {
		return await this.serial(async () => {
			const active = this.active.get(input.toolCallId);
			const existing = asPolicyDetails(input.details);
			if (!active && !existing) return undefined;
			if (existing && existing.executed === false) {
				this.recordFact(existing);
				const activeRequest = active
					? stableRequestId(this.sessionId, input.toolCallId, active.analysis.descriptor.signature)
					: undefined;
				if (activeRequest === existing.requestId) this.active.delete(input.toolCallId);
				return structuredClone(existing);
			}
			if (!active) return existing;
			let failure =
				active.notedFailure ??
				classifyPolicyFailure({
					toolName: input.toolName,
					details: input.details,
					isError: input.isError,
					signal: input.signal,
				});
			if (active.analysis.networkFallback && failure?.category === "command_exit") {
				failure = { ...failure, category: "network", retryable: true };
			}
			const cancelled = failure?.category === "user_cancelled";
			const failed = failure !== undefined && !cancelled;
			if (active.terminalBuffer && (failed || cancelled)) {
				const current = this.terminalBuffers.get(active.terminalBuffer.terminalId) ?? "";
				if (current === active.terminalBuffer.after) {
					if (active.terminalBuffer.before) {
						this.terminalBuffers.set(active.terminalBuffer.terminalId, active.terminalBuffer.before);
					} else this.terminalBuffers.delete(active.terminalBuffer.terminalId);
					if (active.terminalBuffer.unknownBefore) {
						this.unknownTerminalBuffers.add(active.terminalBuffer.terminalId);
					}
				}
			}
			if (!failed && !cancelled && input.toolName === "terminal_close") {
				const terminalId = active.analysis.descriptor.target.startsWith("terminal:")
					? active.analysis.descriptor.target.slice("terminal:".length)
					: undefined;
				if (terminalId) {
					this.terminalBuffers.delete(terminalId);
					this.unknownTerminalBuffers.delete(terminalId);
				}
			}
			const mutated = !failed && !cancelled && active.analysis.descriptor.workspaceMutation;
			const targetRevisionAfter = mutated
				? (this.targetRevisions.get(active.analysis.descriptor.target) ?? active.targetRevisionBefore) + 1
				: active.targetRevisionBefore;
			if (mutated) this.targetRevisions.set(active.analysis.descriptor.target, targetRevisionAfter);
			const details = this.detailsFor(
				input.toolCallId,
				active.analysis,
				active.decision,
				cancelled ? "cancelled" : failed ? "failed" : "succeeded",
				active.createdAt,
				true,
				active.targetRevisionBefore,
				targetRevisionAfter,
				failure,
				active.advisories,
			);
			if (active.terminalBuffer) {
				details.terminalInputPending =
					failed || cancelled
						? active.terminalBuffer.unknownBefore || Boolean(active.terminalBuffer.before)
						: Boolean(active.terminalBuffer.after);
			}
			this.recordFact(details);
			this.active.delete(input.toolCallId);
			return structuredClone(details);
		});
	}

	private detailsFor(
		toolCallId: string,
		analysis: PolicyOperationAnalysis,
		decision: PolicyDecision,
		status: PolicyToolDetails["status"],
		createdAt: string,
		executed: boolean,
		targetRevisionBefore: number,
		targetRevisionAfter: number,
		failure?: PolicyFailure,
		advisories?: PolicyAdvisory[],
	): PolicyToolDetails {
		return {
			version: POLICY_DETAILS_VERSION,
			requestId: stableRequestId(this.sessionId, toolCallId, analysis.descriptor.signature),
			toolCallId,
			decision,
			status,
			operation: analysis.descriptor,
			createdAt,
			completedAt: this.now().toISOString(),
			executed,
			failure,
			...(advisories && advisories.length > 0 ? { advisories: structuredClone(advisories) } : {}),
			targetRevisionBefore,
			targetRevisionAfter,
		};
	}

	private recordFact(details: PolicyToolDetails): void {
		const existingIndex = this.facts.findIndex((fact) => fact.requestId === details.requestId);
		if (existingIndex === -1) this.facts.push(structuredClone(details));
		else this.facts[existingIndex] = structuredClone(details);
	}

	private hasFailedDedicatedNetworkFact(): boolean {
		return this.facts.some(
			(fact) =>
				(fact.operation.kind === "network_search" || fact.operation.kind === "network_fetch") &&
				fact.executed &&
				fact.failure !== undefined &&
				fact.failure.category !== "user_cancelled",
		);
	}

	private emit(event: PolicyRuntimeEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(structuredClone(event));
			} catch {
				// Observers are non-authoritative.
			}
		}
	}

	private async serial<T>(operation: () => Promise<T> | T): Promise<T> {
		let resolve!: (value: T | PromiseLike<T>) => void;
		let reject!: (reason?: unknown) => void;
		const result = new Promise<T>((nextResolve, nextReject) => {
			resolve = nextResolve;
			reject = nextReject;
		});
		const previous = this.tail;
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		void previous.then(async () => {
			try {
				resolve(await operation());
			} catch (error) {
				reject(error);
			}
		});
		return await result;
	}
}

function asPolicyDetails(details: unknown): PolicyToolDetails | undefined {
	const record =
		typeof details === "object" && details !== null && !Array.isArray(details)
			? (details as Record<string, unknown>)
			: undefined;
	const policy = record?.policy;
	return typeof policy === "object" && policy !== null && !Array.isArray(policy)
		? (policy as PolicyToolDetails)
		: undefined;
}
