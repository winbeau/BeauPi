import type { SessionEntry } from "../session-manager.ts";

export const POLICY_DETAILS_KEY = "policy";
export const POLICY_DETAILS_VERSION = 1;
export const POLICY_CONFIRM_VERSION = 1;
export const POLICY_FACT_ENTRY_TYPE = "beaupi.policy.fact";

export type PolicyAction = "allow" | "block" | "confirm" | "replace" | "pause";

export interface PolicyDecision {
	action: PolicyAction;
	reason?: string;
	replacementTool?: string;
	suggestion?: string;
}

export type PolicyOperationKind =
	| "local_shell"
	| "remote_command"
	| "terminal_command"
	| "network_search"
	| "network_fetch"
	| "shell_network_fallback"
	| "read_only_check"
	| "workspace_write"
	| "sensitive_path"
	| "privileged"
	| "dedicated_tool_fallback"
	| "opaque";

export type PolicyOperationAccess = "read" | "write" | "network" | "privileged" | "unknown";

export interface PolicyOperationDescriptor {
	version: 1;
	toolName: string;
	kind: PolicyOperationKind;
	classes: PolicyOperationKind[];
	access: PolicyOperationAccess;
	target: string;
	signature: string;
	equivalenceSignature: string;
	fallbackFamily?: "local" | "remote" | "terminal" | "network";
	dedicatedTool?: string;
	sensitive: boolean;
	privileged: boolean;
	readOnly: boolean;
	workspaceMutation: boolean;
	summary: string;
}

export type PolicyFailureCategory =
	| "missing_dependency"
	| "permission"
	| "authentication"
	| "network"
	| "rate_limit"
	| "timeout"
	| "user_cancelled"
	| "command_exit"
	| "configuration"
	| "session_lost"
	| "budget_exhausted"
	| "unknown";

export interface PolicyFailure {
	category: PolicyFailureCategory;
	exitCode?: number | null;
	retryable: boolean;
}

export type PolicyConfirmStatus =
	| "allow_once"
	| "rejected"
	| "cancelled"
	| "interaction_required"
	| "interaction_error";

export interface PolicyConfirmRequest {
	version: typeof POLICY_CONFIRM_VERSION;
	requestId: string;
	toolCallId: string;
	toolName: string;
	operation: PolicyOperationDescriptor;
	reason: string;
	suggestion?: string;
	createdAt: string;
}

export type PolicyConfirmResponse =
	| { status: "allow_once" }
	| { status: "rejected"; diagnostic?: string }
	| { status: "cancelled" }
	| { status: "error"; diagnostic: string };

export interface PolicyConfirmResult {
	version: typeof POLICY_CONFIRM_VERSION;
	requestId: string;
	status: PolicyConfirmStatus;
	createdAt: string;
	diagnostic?: string;
}

export type PolicyInteractionHandler = (
	request: PolicyConfirmRequest,
	signal: AbortSignal | undefined,
) => Promise<PolicyConfirmResponse>;

export type PendingPolicyInteraction = PolicyConfirmRequest;

export type PolicyResultStatus =
	| "allowed"
	| "confirmed"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "blocked"
	| "replaced"
	| "paused";

export interface PolicyToolDetails {
	version: typeof POLICY_DETAILS_VERSION;
	requestId: string;
	toolCallId: string;
	decision: PolicyDecision;
	status: PolicyResultStatus;
	operation: PolicyOperationDescriptor;
	createdAt: string;
	completedAt: string;
	executed: boolean;
	confirmation?: PolicyConfirmResult;
	failure?: PolicyFailure;
	/** Non-secret terminal recovery fact; true means a partial interactive line remained after terminal_send. */
	terminalInputPending?: boolean;
	targetRevisionBefore: number;
	targetRevisionAfter: number;
}

export interface PolicySettings {
	budget?: PolicyBudgetSettings;
	sensitivePaths?: string[];
}

export interface PolicyBudgetSettings {
	maxEquivalentFailures?: number;
	maxFallbackAttempts?: number;
	maxMissingDependencyFailures?: number;
	maxPermissionFailures?: number;
	maxAuthenticationFailures?: number;
	maxNetworkFailures?: number;
	maxRateLimitFailures?: number;
	maxTimeoutFailures?: number;
	maxCommandExitFailures?: number;
	maxConfigurationFailures?: number;
	maxSessionLostFailures?: number;
}

export interface PolicyBudgetLimits {
	maxEquivalentFailures: number;
	maxFallbackAttempts: number;
	maxMissingDependencyFailures: number;
	maxPermissionFailures: number;
	maxAuthenticationFailures: number;
	maxNetworkFailures: number;
	maxRateLimitFailures: number;
	maxTimeoutFailures: number;
	maxCommandExitFailures: number;
	maxConfigurationFailures: number;
	maxSessionLostFailures: number;
}

export interface ResolvedPolicyConfig {
	budget: PolicyBudgetLimits;
	sensitivePaths: string[];
}

export type PolicyRuntimeEvent =
	| { type: "confirm_pending"; request: PendingPolicyInteraction }
	| { type: "confirm_resolved"; toolCallId: string; requestId: string; result: PolicyConfirmResult };

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function isPolicyAction(value: unknown): value is PolicyAction {
	return value === "allow" || value === "block" || value === "confirm" || value === "replace" || value === "pause";
}

function isPolicyStatus(value: unknown): value is PolicyResultStatus {
	return (
		value === "allowed" ||
		value === "confirmed" ||
		value === "succeeded" ||
		value === "failed" ||
		value === "cancelled" ||
		value === "blocked" ||
		value === "replaced" ||
		value === "paused"
	);
}

export function getPolicyToolDetails(details: unknown): PolicyToolDetails | undefined {
	const record = asRecord(asRecord(details)?.[POLICY_DETAILS_KEY]);
	const decision = asRecord(record?.decision);
	const operation = asRecord(record?.operation);
	if (
		!record ||
		record.version !== POLICY_DETAILS_VERSION ||
		typeof record.requestId !== "string" ||
		typeof record.toolCallId !== "string" ||
		!decision ||
		!isPolicyAction(decision.action) ||
		!isPolicyStatus(record.status) ||
		!operation ||
		operation.version !== 1 ||
		typeof operation.toolName !== "string" ||
		typeof operation.signature !== "string" ||
		typeof operation.equivalenceSignature !== "string" ||
		typeof operation.target !== "string" ||
		typeof operation.summary !== "string" ||
		typeof record.createdAt !== "string" ||
		typeof record.completedAt !== "string" ||
		typeof record.executed !== "boolean" ||
		(record.terminalInputPending !== undefined && typeof record.terminalInputPending !== "boolean") ||
		typeof record.targetRevisionBefore !== "number" ||
		typeof record.targetRevisionAfter !== "number"
	) {
		return undefined;
	}
	return record as unknown as PolicyToolDetails;
}

export function attachPolicyToolDetails(details: unknown, metadata: PolicyToolDetails): Record<string, unknown> {
	const record = asRecord(details);
	return record ? { ...record, [POLICY_DETAILS_KEY]: metadata } : { [POLICY_DETAILS_KEY]: metadata };
}

export function policyFactsFromEntries(entries: readonly SessionEntry[]): PolicyToolDetails[] {
	const facts = new Map<string, PolicyToolDetails>();
	for (const entry of entries) {
		let detail: PolicyToolDetails | undefined;
		if (entry.type === "message" && entry.message.role === "toolResult") {
			detail = getPolicyToolDetails(entry.message.details);
		} else if (entry.type === "custom" && entry.customType === POLICY_FACT_ENTRY_TYPE) {
			detail = getPolicyToolDetails(entry.data);
		}
		if (detail) facts.set(detail.requestId, structuredClone(detail));
	}
	return [...facts.values()];
}
