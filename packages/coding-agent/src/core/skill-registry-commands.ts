import { isLocalPath } from "../utils/paths.ts";
import type { SkillRegistryScope } from "./skill-registry.ts";

export type SkillRegistryCommand =
	| { type: "list"; search?: string }
	| { type: "import"; source: string; scope: SkillRegistryScope }
	| { type: "enable"; name: string }
	| { type: "disable"; name: string }
	| { type: "validate"; name?: string }
	| { type: "remove"; name: string }
	| { type: "error"; message: string };

const COMMAND_NAMES = new Set([
	"skills",
	"skill-import",
	"skill-enable",
	"skill-disable",
	"skill-validate",
	"skill-remove",
]);

function tokenizeArguments(input: string): string[] | undefined {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	const trimmed = input.trim();

	for (let index = 0; index < trimmed.length; index++) {
		const character = trimmed[index]!;
		if (character === "\\") {
			const next = trimmed[index + 1];
			const escapesQuotedCharacter = quote !== undefined && (next === quote || next === "\\");
			const escapesUnquotedCharacter = quote === undefined && next !== undefined && /[\s'"]/.test(next);
			if (escapesQuotedCharacter || escapesUnquotedCharacter) {
				current += next;
				index += 1;
			} else {
				current += character;
			}
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += character;
	}
	if (quote) return undefined;
	if (current) tokens.push(current);
	return tokens;
}

function requireName(command: string, args: string[]): SkillRegistryCommand {
	if (args.length !== 1 || !args[0]?.trim()) {
		return { type: "error", message: `Usage: /${command} <name>` };
	}
	const type = command.slice("skill-".length) as "enable" | "disable" | "remove";
	return { type, name: args[0] };
}

export function parseSkillRegistryCommand(input: string): SkillRegistryCommand | undefined {
	if (!input.startsWith("/")) return undefined;
	const spaceIndex = input.search(/\s/);
	const commandName = (spaceIndex === -1 ? input.slice(1) : input.slice(1, spaceIndex)).trim();
	if (!COMMAND_NAMES.has(commandName)) return undefined;
	const rawArguments = spaceIndex === -1 ? "" : input.slice(spaceIndex + 1);
	const args = tokenizeArguments(rawArguments);
	if (!args) return { type: "error", message: `Unterminated quote in /${commandName}` };

	switch (commandName) {
		case "skills": {
			const search = rawArguments.trim();
			return search ? { type: "list", search } : { type: "list" };
		}
		case "skill-import": {
			if (args.length < 1 || args.length > 2) {
				return { type: "error", message: "Usage: /skill-import <local-path> [user|project]" };
			}
			const source = args[0];
			if (!source) return { type: "error", message: "Usage: /skill-import <local-path> [user|project]" };
			const scope = args[1] ?? "user";
			if (scope !== "user" && scope !== "project") {
				return { type: "error", message: "Skill import scope must be user or project" };
			}
			if (!isLocalPath(source)) {
				return { type: "error", message: "Stage 2a only supports existing local or Claude/Codex directories" };
			}
			return { type: "import", source, scope };
		}
		case "skill-enable":
		case "skill-disable":
		case "skill-remove":
			return requireName(commandName, args);
		case "skill-validate":
			return args.length <= 1
				? { type: "validate", ...(args[0] ? { name: args[0] } : {}) }
				: { type: "error", message: "Usage: /skill-validate [name]" };
	}
}
