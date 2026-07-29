export interface ResourceCollision {
	resourceType: "extension" | "skill" | "prompt" | "theme";
	name: string; // skill name, command/tool/flag name, prompt name, theme name
	winnerPath: string;
	loserPath: string;
	winnerSource?: string; // e.g., "npm:foo", "git:...", "local"
	loserSource?: string;
}

export type SkillPolicyDiagnosticReason =
	| "missing"
	| "not-allowed"
	| "denied"
	| "disabled"
	| "invalid"
	| "untrusted-project";

export interface ResourceDiagnostic {
	type: "warning" | "error" | "collision";
	message: string;
	path?: string;
	code?: string;
	name?: string;
	policy?: "allow" | "deny";
	reason?: SkillPolicyDiagnosticReason;
	collision?: ResourceCollision;
}
