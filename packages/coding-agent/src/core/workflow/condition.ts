import type { WorkflowNodeSnapshot } from "./types.ts";

const MAX_CONDITION_LENGTH = 512;
const MAX_CONDITION_CLAUSES = 16;
const REFERENCE_PATTERN = /^deps\.([A-Za-z][A-Za-z0-9_-]{0,63})\.(status|output(?:\.[A-Za-z][A-Za-z0-9_-]{0,63})+)$/;
const WORKFLOW_NODE_STATUSES = new Set([
	"pending",
	"running",
	"completed",
	"failed",
	"skipped",
	"cancelled",
	"timed_out",
	"lost",
]);

export type WorkflowCondition =
	| { kind: "always" }
	| { kind: "all_succeeded" }
	| { kind: "any_failed" }
	| { kind: "expression"; groups: WorkflowConditionClause[][] };

export interface WorkflowConditionClause {
	nodeId: string;
	source: "status" | "output";
	path: string[];
	operator: "==" | "!=";
	value: string | number | boolean | null;
}

function splitOutsideStrings(input: string, operator: "&&" | "||"): string[] {
	const parts: string[] = [];
	let start = 0;
	let quote: '"' | undefined;
	let escaped = false;
	for (let index = 0; index < input.length; index++) {
		const character = input[index]!;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\" && quote) {
			escaped = true;
			continue;
		}
		if (character === '"') {
			quote = quote ? undefined : '"';
			continue;
		}
		if (!quote && index < input.length - 1 && input.slice(index, index + 2) === operator) {
			parts.push(input.slice(start, index).trim());
			start = index + 2;
			index++;
		}
	}
	if (quote) throw new Error("Workflow condition contains an unterminated string literal");
	parts.push(input.slice(start).trim());
	if (parts.some((part) => part.length === 0)) throw new Error("Workflow condition contains an empty expression");
	return parts;
}

function parseLiteral(value: string): string | number | boolean | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("Workflow condition values must be JSON string, number, boolean, or null literals");
	}
	if (parsed === null || typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") {
		return parsed;
	}
	throw new Error("Workflow condition values must be scalar JSON literals");
}

function parseClause(input: string): WorkflowConditionClause {
	const match = input.match(/^(.+?)\s*(==|!=)\s*(.+)$/);
	if (!match?.[1] || !match[2] || !match[3])
		throw new Error(`Invalid Workflow condition clause ${JSON.stringify(input)}`);
	const reference = match[1].trim().match(REFERENCE_PATTERN);
	if (!reference?.[1] || !reference[2]) {
		throw new Error(`Invalid Workflow condition reference ${JSON.stringify(match[1].trim())}`);
	}
	const referencePath = reference[2].split(".");
	return {
		nodeId: reference[1],
		source: referencePath[0] === "status" ? "status" : "output",
		path: referencePath.slice(1),
		operator: match[2] as "==" | "!=",
		value: parseLiteral(match[3].trim()),
	};
}

export function parseWorkflowCondition(input: string): WorkflowCondition {
	const normalized = input.trim();
	if (!normalized) throw new Error("Workflow condition must not be empty");
	if (normalized.length > MAX_CONDITION_LENGTH) {
		throw new Error(`Workflow condition exceeds ${MAX_CONDITION_LENGTH} characters`);
	}
	if (normalized === "always" || normalized === "all_succeeded" || normalized === "any_failed") {
		return { kind: normalized };
	}
	const groups = splitOutsideStrings(normalized, "||").map((group) =>
		splitOutsideStrings(group, "&&").map(parseClause),
	);
	const clauseCount = groups.reduce((total, group) => total + group.length, 0);
	if (clauseCount > MAX_CONDITION_CLAUSES) {
		throw new Error(`Workflow condition exceeds ${MAX_CONDITION_CLAUSES} clauses`);
	}
	return { kind: "expression", groups };
}

export function validateWorkflowCondition(condition: string, dependencies: ReadonlySet<string>): void {
	const parsed = parseWorkflowCondition(condition);
	if (parsed.kind !== "expression") return;
	for (const clause of parsed.groups.flat()) {
		if (!dependencies.has(clause.nodeId)) {
			throw new Error(
				`Workflow condition references ${JSON.stringify(clause.nodeId)}, which is not listed in dependsOn`,
			);
		}
		if (clause.source === "status") {
			if (typeof clause.value !== "string") {
				throw new Error("Workflow status conditions must compare against a JSON string literal");
			}
			if (!WORKFLOW_NODE_STATUSES.has(clause.value)) {
				throw new Error(`Unknown Workflow node status ${JSON.stringify(clause.value)}`);
			}
		}
	}
}

function outputValue(node: WorkflowNodeSnapshot, path: readonly string[]): unknown {
	let value: unknown = node.output;
	for (const segment of path) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		value = (value as Record<string, unknown>)[segment];
	}
	return value;
}

function evaluateClause(
	clause: WorkflowConditionClause,
	dependencies: ReadonlyMap<string, WorkflowNodeSnapshot>,
): boolean {
	const node = dependencies.get(clause.nodeId);
	if (!node) return false;
	const actual = clause.source === "status" ? node.status : outputValue(node, clause.path);
	const equal = actual === clause.value;
	return clause.operator === "==" ? equal : !equal;
}

export function evaluateWorkflowCondition(
	condition: string | undefined,
	dependencies: readonly WorkflowNodeSnapshot[],
): boolean {
	if (!condition) return true;
	const parsed = parseWorkflowCondition(condition);
	if (parsed.kind === "always") return true;
	if (parsed.kind === "all_succeeded") return dependencies.every((node) => node.status === "completed");
	if (parsed.kind === "any_failed") {
		return dependencies.some(
			(node) => node.status === "failed" || node.status === "timed_out" || node.status === "lost",
		);
	}
	const byId = new Map(dependencies.map((node) => [node.id, node]));
	return parsed.groups.some((group) => group.every((clause) => evaluateClause(clause, byId)));
}
