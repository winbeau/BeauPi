import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
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
	attachPolicyToolDetails,
	type PendingPolicyInteraction,
	POLICY_CONFIRM_VERSION,
	POLICY_DETAILS_VERSION,
	type PolicyConfirmRequest,
	type PolicyConfirmResponse,
	type PolicyConfirmResult,
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
	confirmation?: PolicyConfirmResult;
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
	handler?: PolicyInteractionHandler;
	interactionMode?: "coordinator" | "controlled";
	now?: () => Date;
}

function truncate(value: string, maximum = 2_000): string {
	return [...value.normalize("NFKC")].slice(0, maximum).join("");
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

function resultText(details: PolicyToolDetails): string {
	const replacement = details.decision.replacementTool ? ` Replacement: ${details.decision.replacementTool}.` : "";
	const suggestion = details.decision.suggestion ? ` ${details.decision.suggestion}` : "";
	switch (details.status) {
		case "blocked":
			return `Policy blocked this operation: ${details.decision.reason ?? "Operation is not allowed."}${replacement}${suggestion}`;
		case "replaced":
			return `Policy requires a dedicated Tool instead of this operation.${replacement}${suggestion}`;
		case "paused":
			return `Policy paused execution: ${details.decision.reason ?? "Execution cannot continue safely."}${suggestion}`;
		case "cancelled":
			return "Policy confirmation was cancelled; the operation was not executed.";
		default:
			return details.decision.reason ?? "Policy allowed the operation.";
	}
}

function confirmationResult(
	requestId: string,
	createdAt: string,
	status: PolicyConfirmResult["status"],
	diagnostic?: string,
): PolicyConfirmResult {
	return {
		version: POLICY_CONFIRM_VERSION,
		requestId,
		status,
		createdAt,
		...(diagnostic ? { diagnostic: truncate(diagnostic) } : {}),
	};
}

export class PolicyRuntime {
	private readonly cwd: string;
	private readonly getConfig: () => ResolvedPolicyConfig;
	private readonly enabled: boolean;
	private readonly interactionMode: "coordinator" | "controlled";
	private readonly now: () => Date;
	private handler: PolicyInteractionHandler | undefined;
	private sessionId = "unbound";
	private facts: PolicyToolDetails[] = [];
	private readonly factsByRequestId = new Map<string, PolicyToolDetails>();
	private readonly active = new Map<string, ActivePolicyCall>();
	private readonly targetRevisions = new Map<string, number>();
	private readonly terminalBuffers = new Map<string, string>();
	private readonly unknownTerminalBuffers = new Set<string>();
	private pending: PendingPolicyInteraction | undefined;
	private readonly listeners = new Set<(event: PolicyRuntimeEvent) => void>();
	private tail: Promise<void> = Promise.resolve();

	constructor(options: PolicyRuntimeOptions) {
		this.cwd = options.cwd;
		this.getConfig = options.getConfig;
		this.enabled = options.enabled ?? true;
		this.handler = options.handler;
		this.interactionMode = options.interactionMode ?? "coordinator";
		this.now = options.now ?? (() => new Date());
	}

	bindSession(sessionId: string, entries: readonly SessionEntry[]): void {
		this.sessionId = sessionId;
		this.rebuild(entries);
	}

	rebuild(entries: readonly SessionEntry[]): void {
		this.facts = policyFactsFromEntries(entries);
		this.factsByRequestId.clear();
		this.targetRevisions.clear();
		this.terminalBuffers.clear();
		this.unknownTerminalBuffers.clear();
		this.active.clear();
		this.pending = undefined;
		for (const fact of this.facts) {
			this.factsByRequestId.set(fact.requestId, structuredClone(fact));
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

	setHandler(handler: PolicyInteractionHandler | undefined): void {
		this.handler = handler;
	}

	getPending(): PendingPolicyInteraction | undefined {
		return this.pending ? structuredClone(this.pending) : undefined;
	}

	getFacts(): PolicyToolDetails[] {
		return this.facts.map((fact) => structuredClone(fact));
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
				const authorization = await this.authorizeTool(toolCallId, tool.name, params, getAvailableTools(), signal);
				if (!authorization.execute && authorization.details) return this.skippedResult(authorization.details);
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
		signal?: AbortSignal,
	): Promise<PolicyAuthorization> {
		return await this.serial(async () => {
			if (!this.enabled) return { managed: false, execute: true };
			const config = this.getConfig();
			let policyArgs = await canonicalPolicyArgs(toolName, args, this.cwd);
			let terminalBuffer: ActivePolicyCall["terminalBuffer"];
			let terminalInputOverflow = false;
			let terminalInputUnknown = false;
			if (toolName === "terminal_send" && typeof args === "object" && args !== null && !Array.isArray(args)) {
				const record = args as Record<string, unknown>;
				if (typeof record.terminalId === "string" && typeof record.input === "string") {
					const unknownBefore = this.unknownTerminalBuffers.has(record.terminalId);
					const clearsRecoveredInput = /[\u0003\u0004\u0015]/.test(record.input);
					terminalInputUnknown = unknownBefore && !clearsRecoveredInput;
					const before = unknownBefore ? "" : (this.terminalBuffers.get(record.terminalId) ?? "");
					const state = terminalInputState(before, record.input);
					terminalBuffer = { terminalId: record.terminalId, before, after: state.next, unknownBefore };
					terminalInputOverflow = state.overflow;
					policyArgs = { ...record, input: state.analysisText };
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
			const requestId = stableRequestId(this.sessionId, toolCallId, descriptor.signature);
			const completed = this.factsByRequestId.get(requestId);
			if (completed) {
				return { managed: true, execute: false, details: structuredClone(completed) };
			}
			const targetRevisionBefore = this.targetRevisions.get(descriptor.target) ?? 0;
			const createdAt = this.now().toISOString();
			const activate = (decision: PolicyDecision, confirmation?: PolicyConfirmResult): void => {
				this.active.set(toolCallId, {
					analysis,
					decision,
					createdAt,
					confirmation,
					targetRevisionBefore,
					terminalBuffer,
				});
				if (terminalBuffer) {
					this.unknownTerminalBuffers.delete(terminalBuffer.terminalId);
					if (terminalBuffer.after) this.terminalBuffers.set(terminalBuffer.terminalId, terminalBuffer.after);
					else this.terminalBuffers.delete(terminalBuffer.terminalId);
				}
			};
			const skip = (
				decision: PolicyDecision,
				status: "blocked" | "replaced" | "paused" | "cancelled",
				confirmation?: PolicyConfirmResult,
				trackActive = true,
			): PolicyAuthorization => {
				if (trackActive) {
					this.active.set(toolCallId, {
						analysis,
						decision,
						createdAt,
						confirmation,
						targetRevisionBefore,
					});
				}
				return {
					managed: true,
					execute: false,
					details: this.detailsFor(
						toolCallId,
						analysis,
						decision,
						status,
						createdAt,
						false,
						targetRevisionBefore,
						targetRevisionBefore,
						confirmation,
					),
				};
			};
			if (this.active.has(toolCallId)) {
				return skip(
					{
						action: "block",
						reason: "The Tool call id is already active with another Policy authorization.",
						suggestion: "Use one unique Tool call id per concurrent operation.",
					},
					"blocked",
					undefined,
					false,
				);
			}
			if (descriptor.privileged) {
				return skip(
					{
						action: "block",
						reason: "Privileged commands and root shells are not authorized in M10.",
						suggestion: "Continue as the normal user; controlled sudo is intentionally deferred to M13.",
					},
					"blocked",
				);
			}
			if (terminalInputUnknown) {
				return skip(
					{
						action: "pause",
						reason:
							"The restored terminal may contain a partial interactive line that Policy cannot reconstruct safely.",
						suggestion: "Send Ctrl+C or Ctrl+U alone to clear the line before providing more terminal input.",
					},
					"paused",
				);
			}
			if (terminalInputOverflow) {
				return skip(
					{
						action: "pause",
						reason: "The pending terminal input exceeds the bounded Policy inspection window.",
						suggestion: "Cancel the partial terminal line and use terminal_bash for an ordinary command.",
					},
					"paused",
				);
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
				return skip(
					{
						action: "pause",
						reason:
							"The terminal has pending interactive input that Policy cannot safely combine with terminal_bash.",
						suggestion:
							"Cancel or complete the partial interactive line before running an ordinary terminal command.",
					},
					"paused",
				);
			}
			if (analysis.networkFallback && this.hasFailedDedicatedNetworkFact()) {
				return skip(
					{
						action: "pause",
						reason: "A dedicated web_search/web_fetch operation already failed or exhausted its budget.",
						suggestion:
							"Fix Search Runtime configuration, wait for the limit to reset, or ask the user how to proceed.",
					},
					"paused",
				);
			}
			if (analysis.replacementTool) {
				return skip(
					{
						action: "replace",
						reason:
							"A dedicated Tool provides the same supported operation with stronger validation and diagnostics.",
						replacementTool: analysis.replacementTool,
						suggestion: analysis.replacementSuggestion,
					},
					"replaced",
				);
			}
			if (
				descriptor.readOnly &&
				[...this.active.values()].some(
					(active) =>
						active.analysis.descriptor.readOnly &&
						active.analysis.descriptor.equivalenceSignature === descriptor.equivalenceSignature &&
						active.targetRevisionBefore === targetRevisionBefore,
				)
			) {
				return skip(
					{
						action: "block",
						reason: "An equivalent read-only check is already in flight for the unchanged target.",
						suggestion: "Wait for the existing deterministic result instead of starting a duplicate check.",
					},
					"blocked",
				);
			}
			let duplicate: PolicyToolDetails | undefined;
			for (let index = this.facts.length - 1; index >= 0; index--) {
				const fact = this.facts[index];
				if (
					fact?.executed &&
					fact.status === "succeeded" &&
					fact.operation.readOnly &&
					fact.operation.equivalenceSignature === descriptor.equivalenceSignature &&
					fact.targetRevisionAfter === targetRevisionBefore
				) {
					duplicate = fact;
					break;
				}
			}
			if (duplicate) {
				return skip(
					{
						action: "block",
						reason: "An equivalent read-only check already succeeded and the relevant target has not changed.",
						suggestion: "Reuse the existing structured fact; rerun only after a workspace or target mutation.",
					},
					"blocked",
				);
			}
			const equivalentFailures = this.facts.filter(
				(fact) =>
					fact.executed &&
					fact.failure !== undefined &&
					fact.failure.category !== "user_cancelled" &&
					fact.operation.equivalenceSignature === descriptor.equivalenceSignature,
			).length;
			if (equivalentFailures >= config.budget.maxEquivalentFailures) {
				return skip(
					{
						action: "pause",
						reason: "The same equivalent operation already failed and its repeat budget is exhausted.",
						suggestion: "Change the underlying condition or ask the user before retrying.",
					},
					"paused",
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
			const activeFallbacks = [...this.active.values()].filter(
				(active) =>
					active.analysis.descriptor.fallbackFamily === descriptor.fallbackFamily &&
					(descriptor.fallbackFamily === "network" || active.analysis.descriptor.target === descriptor.target),
			).length;
			if (descriptor.fallbackFamily && fallbackFacts.length + activeFallbacks >= config.budget.maxFallbackAttempts) {
				return skip(
					{
						action: "pause",
						reason: `The ${descriptor.fallbackFamily} fallback budget is exhausted${descriptor.fallbackFamily === "network" ? " for this session" : " for this target"}.`,
						suggestion:
							"Resolve the recorded failure or request a new user decision instead of changing equivalent tools.",
					},
					"paused",
				);
			}
			const failureCategories = fallbackFacts
				.map((fact) => fact.failure?.category)
				.filter((category): category is NonNullable<typeof category> => category !== undefined);
			for (const category of new Set(failureCategories)) {
				const limit = policyFailureLimit(category, config);
				if (!limit) continue;
				const count = fallbackFacts.filter((fact) => fact.failure?.category === category).length;
				if (count >= limit) {
					return skip(
						{
							action: "pause",
							reason: `The ${category.replaceAll("_", " ")} failure budget is exhausted for this target.`,
							suggestion: "Fix the recorded condition or ask the user before continuing.",
						},
						"paused",
					);
				}
			}
			if (analysis.requiresConfirmation) {
				const reason = "This operation accesses a sensitive path or writes outside the current workspace boundary.";
				if (signal?.aborted) {
					return skip(
						{ action: "pause", reason: "The Policy request was cancelled before confirmation." },
						"cancelled",
						confirmationResult(requestId, createdAt, "cancelled"),
					);
				}
				if (this.interactionMode === "controlled") {
					return skip(
						{
							action: "pause",
							reason,
							suggestion:
								"Return this structured Policy request to the Coordinator; controlled sub-agents cannot prompt users.",
						},
						"paused",
						confirmationResult(
							requestId,
							createdAt,
							"interaction_required",
							"Controlled sub-agent interaction is disabled",
						),
					);
				}
				const request: PendingPolicyInteraction = {
					version: POLICY_CONFIRM_VERSION,
					requestId,
					toolCallId,
					toolName,
					operation: descriptor,
					reason,
					suggestion: "Allow only this stable request if the operation is expected and safe.",
					createdAt,
				};
				if (!this.handler) {
					return skip(
						{
							action: "pause",
							reason: "Policy confirmation is required, but this run mode has no interaction handler.",
							suggestion: "Retry in TUI/SDK/RPC with a Policy interaction handler.",
						},
						"paused",
						confirmationResult(
							requestId,
							createdAt,
							"interaction_required",
							"No Policy interaction handler is configured",
						),
					);
				}
				this.pending = request;
				this.emit({ type: "confirm_pending", request });
				const response = await this.resolveConfirmation(request, signal);
				const confirmation = this.normalizeConfirmation(requestId, createdAt, response);
				this.pending = undefined;
				this.emit({ type: "confirm_resolved", toolCallId, requestId, result: confirmation });
				if (confirmation.status === "allow_once") {
					const decision: PolicyDecision = { action: "confirm", reason };
					activate(decision, confirmation);
					return { managed: true, execute: true };
				}
				if (confirmation.status === "rejected") {
					return skip(
						{
							action: "block",
							reason: confirmation.diagnostic ?? "The user rejected this Policy request.",
							suggestion: "Choose a non-sensitive operation or ask the user for a different approach.",
						},
						"blocked",
						confirmation,
					);
				}
				return skip(
					{
						action: "pause",
						reason:
							confirmation.status === "cancelled"
								? "The user cancelled this Policy request."
								: "Policy confirmation could not be completed.",
						suggestion: "Resolve the interaction issue or ask the user before retrying.",
					},
					confirmation.status === "cancelled" ? "cancelled" : "paused",
					confirmation,
				);
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
				active.confirmation,
				failure,
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

	private skippedResult(details: PolicyToolDetails): AgentToolResult<unknown> {
		return {
			content: [{ type: "text", text: resultText(details) }],
			details: attachPolicyToolDetails(undefined, details),
			terminate: details.decision.action === "pause",
		};
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
		confirmation?: PolicyConfirmResult,
		failure?: PolicyFailure,
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
			confirmation,
			failure,
			targetRevisionBefore,
			targetRevisionAfter,
		};
	}

	private recordFact(details: PolicyToolDetails): void {
		const existingIndex = this.facts.findIndex((fact) => fact.requestId === details.requestId);
		if (existingIndex === -1) this.facts.push(structuredClone(details));
		else this.facts[existingIndex] = structuredClone(details);
		this.factsByRequestId.set(details.requestId, structuredClone(details));
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

	private async resolveConfirmation(
		request: PolicyConfirmRequest,
		signal: AbortSignal | undefined,
	): Promise<PolicyConfirmResponse> {
		if (signal?.aborted) return { status: "cancelled" };
		const handler = this.handler;
		if (!handler) return { status: "error", diagnostic: "No Policy interaction handler is configured" };
		try {
			return await Promise.race([
				handler(structuredClone(request), signal),
				new Promise<PolicyConfirmResponse>((resolve) => {
					if (signal?.aborted) {
						resolve({ status: "cancelled" });
						return;
					}
					signal?.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
				}),
			]);
		} catch (error) {
			return { status: "error", diagnostic: error instanceof Error ? error.message : String(error) };
		}
	}

	private normalizeConfirmation(
		requestId: string,
		createdAt: string,
		response: PolicyConfirmResponse,
	): PolicyConfirmResult {
		switch (response.status) {
			case "allow_once":
				return confirmationResult(requestId, createdAt, "allow_once");
			case "rejected":
				return confirmationResult(
					requestId,
					createdAt,
					"rejected",
					"Policy request rejected by interaction handler",
				);
			case "cancelled":
				return confirmationResult(requestId, createdAt, "cancelled");
			case "error":
				return confirmationResult(requestId, createdAt, "interaction_error", "Policy interaction handler failed");
			default:
				return confirmationResult(requestId, createdAt, "interaction_error", "Invalid Policy interaction response");
		}
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
