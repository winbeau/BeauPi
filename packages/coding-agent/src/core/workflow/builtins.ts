import { WORKFLOW_DEFINITION_VERSION, type WorkflowDefinition } from "./types.ts";

const research: WorkflowDefinition = {
	version: WORKFLOW_DEFINITION_VERSION,
	id: "research",
	description: "Parallel source discovery followed by a structured synthesis.",
	maxConcurrency: 3,
	nodes: [
		{
			id: "sources",
			profile: "researcher",
			task: "Research the following task using bounded search and return citations: {{task}}",
			writePolicy: "none",
			failurePolicy: "continue",
		},
		{
			id: "repository",
			profile: "reviewer",
			task: "Inspect repository-local evidence relevant to: {{task}}",
			writePolicy: "none",
			failurePolicy: "continue",
		},
		{
			id: "synthesize",
			profile: "reviewer",
			task: "Synthesize the dependency outputs into a concise answer for: {{task}}",
			dependsOn: ["sources", "repository"],
			condition: 'deps.sources.status == "completed" || deps.repository.status == "completed"',
			writePolicy: "none",
		},
	],
};

const implementReview: WorkflowDefinition = {
	version: WORKFLOW_DEFINITION_VERSION,
	id: "implement-review",
	description: "Apply requested changes in the shared workspace, then review the structured implementation result.",
	maxConcurrency: 2,
	nodes: [
		{
			id: "implement",
			profile: "implementer",
			task: "Implement the requested change and run focused verification: {{task}}",
			writePolicy: "shared",
		},
		{
			id: "review",
			profile: "reviewer",
			task: "Review the implementation and report concrete correctness or regression risks for: {{task}}",
			dependsOn: ["implement"],
			condition: "all_succeeded",
			writePolicy: "none",
		},
	],
};

const parallelReview: WorkflowDefinition = {
	version: WORKFLOW_DEFINITION_VERSION,
	id: "parallel-review",
	description: "Run two independent read-only reviewers concurrently.",
	maxConcurrency: 2,
	nodes: [
		{
			id: "correctness",
			profile: "reviewer",
			task: "Review correctness and test coverage for: {{task}}",
			writePolicy: "none",
			failurePolicy: "continue",
		},
		{
			id: "boundaries",
			profile: "reviewer",
			task: "Review architecture, security, and lifecycle boundaries for: {{task}}",
			writePolicy: "none",
			failurePolicy: "continue",
		},
	],
};

const debug: WorkflowDefinition = {
	version: WORKFLOW_DEFINITION_VERSION,
	id: "debug",
	description: "Diagnose, fix in the shared workspace, then verify the fix.",
	maxConcurrency: 2,
	nodes: [
		{
			id: "diagnose",
			profile: "reviewer",
			task: "Diagnose the failure and identify a focused fix: {{task}}",
			writePolicy: "none",
		},
		{
			id: "fix",
			profile: "implementer",
			task: "Implement the diagnosed fix and run focused checks: {{task}}",
			dependsOn: ["diagnose"],
			condition: "all_succeeded",
			writePolicy: "shared",
		},
		{
			id: "verify",
			profile: "reviewer",
			task: "Verify the fix against the original failure and dependency outputs: {{task}}",
			dependsOn: ["fix"],
			condition: "all_succeeded",
			writePolicy: "none",
		},
	],
};

const docsExecute: WorkflowDefinition = {
	version: WORKFLOW_DEFINITION_VERSION,
	id: "docs-execute",
	description: "Resolve repository requirements, execute them, then audit completion.",
	maxConcurrency: 2,
	nodes: [
		{
			id: "docs",
			profile: "reviewer",
			task: "Resolve the relevant repository documents and return the required execution contract for: {{task}}",
			writePolicy: "none",
		},
		{
			id: "execute",
			profile: "implementer",
			task: "Execute the requested work while following the dependency contract: {{task}}",
			dependsOn: ["docs"],
			condition: "all_succeeded",
			writePolicy: "shared",
		},
		{
			id: "audit",
			profile: "reviewer",
			task: "Audit the implementation and checks against the dependency contract: {{task}}",
			dependsOn: ["docs", "execute"],
			condition: "all_succeeded",
			writePolicy: "none",
		},
	],
};

export const BUILTIN_WORKFLOWS: Readonly<Record<string, WorkflowDefinition>> = Object.freeze({
	research,
	"implement-review": implementReview,
	"parallel-review": parallelReview,
	debug,
	"docs-execute": docsExecute,
});

export function getBuiltinWorkflow(name: string): WorkflowDefinition | undefined {
	const definition = BUILTIN_WORKFLOWS[name];
	return definition ? structuredClone(definition) : undefined;
}
