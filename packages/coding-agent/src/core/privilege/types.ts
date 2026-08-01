import type { TruncationResult } from "../tools/truncate.ts";

export const PRIVILEGE_VERSION = 1;
export const PRIVILEGE_DETAILS_KEY = "privilege";
export const PRIVILEGE_FACT_ENTRY_TYPE = "beaupi.privilege.fact";

export type PrivilegeRouteV1 = "explicit_tool" | "local_bash" | "terminal_bash";
export type PrivilegeExecutionV1 = "local" | "terminal";
export type PrivilegeRequestStateV1 =
	| "waiting_for_user"
	| "starting"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "blocked"
	| "interaction_required";
export type PrivilegeResultStatusV1 =
	| "succeeded"
	| "failed"
	| "cancelled"
	| "blocked"
	| "interaction_required"
	| "interaction_error";

export interface PrivilegeTargetV1 {
	execution: PrivilegeExecutionV1;
	targetId?: string;
	terminalId?: string;
	monitorId?: string;
}

export interface PrivilegeExecuteInputV1 {
	toolCallId: string;
	sourceTool: string;
	route: PrivilegeRouteV1;
	command: string;
	target: PrivilegeTargetV1;
	cwd: string;
	timeoutMs?: number;
}

export interface PrivilegeRequestV1 extends PrivilegeExecuteInputV1 {
	version: typeof PRIVILEGE_VERSION;
	requestId: string;
	auditId: string;
	createdAt: string;
	logPath: string;
}

export type PrivilegeDiagnosticCodeV1 =
	| "interaction_required"
	| "interaction_error"
	| "invalid_command"
	| "unsupported_privilege"
	| "sudo_stdin_forbidden"
	| "redundant_privilege"
	| "terminal_required"
	| "terminal_busy"
	| "terminal_lost"
	| "tmux_unavailable"
	| "audit_failed"
	| "cancelled"
	| "timeout"
	| "command_failed"
	| "echo_recovery_failed";

export interface PrivilegeDiagnosticV1 {
	code: PrivilegeDiagnosticCodeV1;
	message: string;
}

export interface PrivilegeCommandResultV1 {
	output: string;
	exitCode: number | null;
	startedAt: number;
	completedAt: number;
	cancelled?: boolean;
	timedOut?: boolean;
	monitorId?: string;
	logPath?: string;
	diagnostic?: PrivilegeDiagnosticV1;
}

export interface PrivilegeTerminalFrameV1 {
	content: string;
	cursor?: number;
	state: "starting" | "authenticating" | "running" | "complete" | "lost";
}

export function isPrivilegeAuthenticationPrompt(screen: string, cursorY: number | undefined): boolean {
	if (cursorY === undefined || !Number.isInteger(cursorY) || cursorY < 0) return false;
	const line = screen.replaceAll("\r", "").split("\n")[cursorY] ?? "";
	return /(?:password|passphrase)[^:\r\n]*:[ \t]*$/i.test(line);
}

export interface PrivilegeCommandSession {
	start(): Promise<void>;
	sendSensitive(input: Buffer): Promise<void>;
	capture(): Promise<PrivilegeTerminalFrameV1>;
	resize(columns: number, rows: number): Promise<void>;
	cancel(): Promise<void>;
	wait(): Promise<PrivilegeCommandResultV1>;
	dispose(): Promise<void>;
}

export interface PrivilegeTerminalAdapter {
	create(request: PrivilegeRequestV1, signal?: AbortSignal): Promise<PrivilegeCommandSession>;
	dispose?(): Promise<void>;
}

export interface PrivilegeTerminalControl {
	start(): Promise<void>;
	sendSensitive(input: Buffer): Promise<void>;
	capture(): Promise<PrivilegeTerminalFrameV1>;
	resize(columns: number, rows: number): Promise<void>;
	cancel(): Promise<void>;
	wait(): Promise<PrivilegeCommandResultV1>;
}

export interface PrivilegeInteractionRequest {
	requestId: string;
	sourceTool: string;
	route: PrivilegeRouteV1;
	command: string;
	target: PrivilegeTargetV1;
	cwd: string;
	timeoutMs?: number;
	auditPath: string;
	createdAt: string;
}

export type PrivilegeInteractionResponse =
	| { status: "completed" }
	| { status: "cancelled" }
	| { status: "rejected"; diagnostic?: string }
	| { status: "error"; diagnostic: string };

export type PrivilegeInteractionHandler = (
	request: PrivilegeInteractionRequest,
	control: PrivilegeTerminalControl,
	signal: AbortSignal | undefined,
) => Promise<PrivilegeInteractionResponse>;

export interface PendingPrivilegeInteraction extends PrivilegeInteractionRequest {
	state: PrivilegeRequestStateV1;
}

export interface PrivilegeToolDetailsV1 {
	version: typeof PRIVILEGE_VERSION;
	operation: "privileged_exec";
	execution: PrivilegeExecutionV1;
	status: PrivilegeResultStatusV1;
	ok: boolean;
	requestId: string;
	auditId: string;
	toolCallId: string;
	command: string;
	targetKey: string;
	route: PrivilegeRouteV1;
	sourceTool: string;
	createdAt: string;
	confirmedAt?: string;
	startedAt?: string;
	completedAt: string;
	terminalId?: string;
	targetId?: string;
	monitorId?: string;
	logPath: string;
	exitCode: number | null;
	durationMs: number;
	diagnostic?: PrivilegeDiagnosticV1;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export type PrivilegeAuditEventTypeV1 =
	| "requested"
	| "confirmed"
	| "started"
	| "completed"
	| "failed"
	| "cancelled"
	| "blocked";

export interface PrivilegeAuditEventV1 {
	version: typeof PRIVILEGE_VERSION;
	auditId: string;
	sessionId: string;
	requestId: string;
	toolCallId: string;
	sourceTool: string;
	route: PrivilegeRouteV1;
	timestamp: string;
	event: PrivilegeAuditEventTypeV1;
	command: string;
	target: PrivilegeTargetV1;
	cwd: string;
	confirmed?: boolean;
	exitCode?: number | null;
	durationMs?: number;
	monitorId?: string;
	logPath?: string;
	diagnosticCode?: PrivilegeDiagnosticCodeV1;
}

export interface PrivilegeAuditWriter {
	pathFor(timestamp: Date): string;
	append(event: PrivilegeAuditEventV1): Promise<void>;
}

const PRIVILEGE_DETAIL_VALUE_KEYS = new Set([
	"version",
	"operation",
	"execution",
	"status",
	"ok",
	"requestId",
	"auditId",
	"toolCallId",
	"command",
	"targetKey",
	"route",
	"sourceTool",
	"createdAt",
	"confirmedAt",
	"startedAt",
	"completedAt",
	"terminalId",
	"targetId",
	"monitorId",
	"logPath",
	"exitCode",
	"durationMs",
	"diagnostic",
	"truncation",
	"fullOutputPath",
]);
const PRIVILEGE_COMPOSITE_KEYS = new Set([
	"policy",
	"taskLedger",
	"documentRuntime",
	"searchRuntime",
	"workflow",
	"background",
]);
const PRIVILEGE_STATUSES = new Set<PrivilegeResultStatusV1>([
	"succeeded",
	"failed",
	"cancelled",
	"blocked",
	"interaction_required",
	"interaction_error",
]);
const PRIVILEGE_ROUTES = new Set<PrivilegeRouteV1>(["explicit_tool", "local_bash", "terminal_bash"]);
const PRIVILEGE_DIAGNOSTIC_CODES = new Set<PrivilegeDiagnosticCodeV1>([
	"interaction_required",
	"interaction_error",
	"invalid_command",
	"unsupported_privilege",
	"sudo_stdin_forbidden",
	"redundant_privilege",
	"terminal_required",
	"terminal_busy",
	"terminal_lost",
	"tmux_unavailable",
	"audit_failed",
	"cancelled",
	"timeout",
	"command_failed",
	"echo_recovery_failed",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function getPrivilegeToolDetails(details: unknown): PrivilegeToolDetailsV1 | undefined {
	const direct = asRecord(details);
	const record =
		direct?.version === PRIVILEGE_VERSION && direct.operation === "privileged_exec"
			? direct
			: asRecord(direct?.[PRIVILEGE_DETAILS_KEY]);
	const diagnostic = asRecord(record?.diagnostic);
	if (
		!record ||
		record.version !== PRIVILEGE_VERSION ||
		record.operation !== "privileged_exec" ||
		(record.execution !== "local" && record.execution !== "terminal") ||
		!PRIVILEGE_STATUSES.has(record.status as PrivilegeResultStatusV1) ||
		typeof record.ok !== "boolean" ||
		typeof record.requestId !== "string" ||
		typeof record.auditId !== "string" ||
		typeof record.toolCallId !== "string" ||
		typeof record.command !== "string" ||
		typeof record.targetKey !== "string" ||
		!PRIVILEGE_ROUTES.has(record.route as PrivilegeRouteV1) ||
		typeof record.sourceTool !== "string" ||
		typeof record.createdAt !== "string" ||
		(record.confirmedAt !== undefined && typeof record.confirmedAt !== "string") ||
		(record.startedAt !== undefined && typeof record.startedAt !== "string") ||
		typeof record.completedAt !== "string" ||
		(record.terminalId !== undefined && typeof record.terminalId !== "string") ||
		(record.targetId !== undefined && typeof record.targetId !== "string") ||
		(record.monitorId !== undefined && typeof record.monitorId !== "string") ||
		typeof record.logPath !== "string" ||
		!(typeof record.exitCode === "number" || record.exitCode === null) ||
		(typeof record.exitCode === "number" && !Number.isFinite(record.exitCode)) ||
		typeof record.durationMs !== "number" ||
		!Number.isFinite(record.durationMs) ||
		(record.fullOutputPath !== undefined && typeof record.fullOutputPath !== "string") ||
		(record.truncation !== undefined && asRecord(record.truncation) === undefined) ||
		(record.diagnostic !== undefined &&
			(!diagnostic ||
				!PRIVILEGE_DIAGNOSTIC_CODES.has(diagnostic.code as PrivilegeDiagnosticCodeV1) ||
				typeof diagnostic.message !== "string" ||
				Object.keys(diagnostic).some((key) => key !== "code" && key !== "message"))) ||
		Object.keys(record).some((key) => !PRIVILEGE_DETAIL_VALUE_KEYS.has(key) && !PRIVILEGE_COMPOSITE_KEYS.has(key))
	) {
		return undefined;
	}
	return Object.fromEntries(
		Object.entries(record).filter(([key]) => PRIVILEGE_DETAIL_VALUE_KEYS.has(key)),
	) as unknown as PrivilegeToolDetailsV1;
}

export function attachPrivilegeToolDetails(
	details: unknown,
	metadata: PrivilegeToolDetailsV1,
): Record<string, unknown> {
	const record = asRecord(details);
	return record ? { ...record, [PRIVILEGE_DETAILS_KEY]: metadata } : { [PRIVILEGE_DETAILS_KEY]: metadata };
}
