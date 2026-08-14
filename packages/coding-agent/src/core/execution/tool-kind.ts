// Neutral tool-kind facts for Dynamic Task progress tracking.
//
// These helpers classify whether a tool call is a workspace mutation (write,
// edit, shell command that modifies the workspace, browser screenshot file).
// They are execution facts only: they never gate, block, replace, or require
// confirmation for tool execution.

import {
	commandName,
	executableWordIndex,
	NETWORK_COMMANDS,
	PRIVILEGED_COMMANDS,
	SCRIPT_NETWORK_INTERPRETERS,
	SHELL_INTERPRETERS,
	type ShellToken,
	shellCommandScript,
	splitSimpleCommands,
	tokenizeShell,
	unwrapCommand,
} from "./shell-parse.ts";

const READ_ONLY_COMMANDS = new Set([
	"pwd",
	"ls",
	"dir",
	"find",
	"fd",
	"rg",
	"grep",
	"egrep",
	"fgrep",
	"cat",
	"head",
	"tail",
	"stat",
	"wc",
	"du",
	"df",
	"file",
	"readlink",
	"realpath",
	"which",
	"whereis",
	"type",
	"printenv",
	"uname",
	"hostname",
	"id",
	"whoami",
	"date",
	"ps",
	"pgrep",
	"test",
	"true",
	"false",
	"printf",
	"echo",
	"sort",
	"uniq",
	"cut",
	"tr",
	"jq",
	"sed",
	"awk",
]);
const MODIFY_COMMANDS = new Set([
	"rm",
	"rmdir",
	"mv",
	"cp",
	"install",
	"mkdir",
	"touch",
	"truncate",
	"tee",
	"chmod",
	"chown",
	"chgrp",
	"ln",
	"patch",
	"dd",
]);
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
	"status",
	"diff",
	"log",
	"show",
	"rev-parse",
	"version",
	"help",
	"ls-files",
	"ls-tree",
	"cat-file",
	"grep",
	"blame",
	"describe",
]);
const GIT_MODIFYING_SUBCOMMANDS = new Set([
	"add",
	"commit",
	"checkout",
	"switch",
	"restore",
	"reset",
	"clean",
	"merge",
	"rebase",
	"cherry-pick",
	"revert",
	"apply",
	"am",
	"stash",
	"worktree",
	"mv",
	"rm",
	"init",
	"clone",
	"fetch",
	"pull",
	"push",
]);

interface ShellMutationAnalysis {
	workspaceMutation: boolean;
	readOnly: boolean;
	unknown: boolean;
}

function gitSubcommandIndex(words: readonly string[]): number {
	let index = 1;
	const globalWithValue = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
	while (index < words.length) {
		const token = words[index]!;
		if (["--no-optional-locks", "--no-pager", "--literal-pathspecs"].includes(token)) {
			index++;
			continue;
		}
		const option = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
		if (globalWithValue.has(option)) {
			index += token.includes("=") ? 1 : 2;
			continue;
		}
		break;
	}
	return index;
}

function gitInspectionSubcommand(words: readonly string[], index: number): boolean {
	const subcommand = (words[index] ?? "").toLowerCase();
	const rest = words.slice(index + 1);
	if (subcommand === "branch") {
		return !rest.some(
			(word) =>
				!word.startsWith("-") ||
				["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy", "--edit-description"].includes(word),
		);
	}
	if (subcommand === "tag") {
		return !rest.some(
			(word) =>
				!word.startsWith("-") ||
				["-a", "-s", "-u", "-f", "-d", "--annotate", "--sign", "--local-user", "--force", "--delete"].includes(
					word,
				),
		);
	}
	if (subcommand === "remote") {
		const operation = rest.find((word) => !word.startsWith("-"));
		return operation === undefined || operation === "show" || operation === "get-url";
	}
	return false;
}

function commandFragments(command: string): Set<string> {
	return new Set(
		command
			.split(/[^A-Za-z0-9_./+-]+/)
			.map(commandName)
			.filter(Boolean),
	);
}

function analyzeSimpleCommand(tokens: readonly ShellToken[]): ShellMutationAnalysis {
	const words = unwrapCommand(tokens.filter((token) => token.kind === "word").map((token) => token.value));
	const redirects = tokens.filter((token) => token.kind === "redirect").map((token) => token.value);
	const outputRedirect = redirects.some((redirect) => redirect.includes(">"));
	const name = commandName(words[0] ?? "");
	if (!name) {
		return { workspaceMutation: outputRedirect, readOnly: false, unknown: true };
	}
	if (SHELL_INTERPRETERS.has(name)) {
		const script = shellCommandScript(words);
		if (script !== undefined) {
			const nested = analyzeShell(script);
			return {
				workspaceMutation: nested.workspaceMutation || outputRedirect,
				readOnly: nested.readOnly,
				unknown: nested.opaque,
			};
		}
	}
	const nested = nestedCommandAnalysis(name, words, redirects);
	if (nested) {
		return {
			workspaceMutation: nested.workspaceMutation || nested.opaque || outputRedirect,
			readOnly: false,
			unknown: nested.opaque,
		};
	}
	if (PRIVILEGED_COMMANDS.has(name)) {
		return { workspaceMutation: false, readOnly: false, unknown: false };
	}
	if (name === "ssh" || name === "mosh") {
		return { workspaceMutation: false, readOnly: false, unknown: false };
	}
	const script = words.slice(1).join(" ").toLowerCase();
	const scriptFragments = commandFragments(script);
	const executesEmbeddedCommand =
		SCRIPT_NETWORK_INTERPRETERS.has(name) || name === "awk"
			? /(?:system|shell_exec|passthru|subprocess|child_process|spawn|exec|start-process|os\.)/i.test(script)
			: false;
	const scriptedNetwork =
		(SCRIPT_NETWORK_INTERPRETERS.has(name) &&
			/(https?:\/\/|urllib|requests\.|http\.client|fetch\s*\(|axios|https?\.get|net\/http|invoke-webrequest|invoke-restmethod)/i.test(
				script,
			)) ||
		(executesEmbeddedCommand && [...NETWORK_COMMANDS].some((command) => scriptFragments.has(command))) ||
		(SHELL_INTERPRETERS.has(name) && /\/dev\/tcp\//i.test(script));
	const dedicatedNetworkCommand =
		NETWORK_COMMANDS.has(name) ||
		(name === "openssl" && words[1]?.toLowerCase() === "s_client") ||
		(name === "gh" && words[1]?.toLowerCase() === "api");
	if (dedicatedNetworkCommand || scriptedNetwork) {
		const writesFile =
			outputRedirect ||
			(["curl", "wget", "aria2c"].includes(name) &&
				words.some((word) => word === "-o" || word === "-O" || word === "--output"));
		return { workspaceMutation: writesFile, readOnly: false, unknown: false };
	}
	if (name === "git") {
		const subcommandIndex = gitSubcommandIndex(words);
		const subcommand = words[subcommandIndex]?.toLowerCase();
		const explicitlyReadOnly =
			subcommand !== undefined &&
			(GIT_READ_ONLY_SUBCOMMANDS.has(subcommand) || gitInspectionSubcommand(words, subcommandIndex));
		const modifies = !explicitlyReadOnly || outputRedirect || GIT_MODIFYING_SUBCOMMANDS.has(subcommand ?? "");
		return { workspaceMutation: modifies, readOnly: !modifies, unknown: false };
	}
	if (["npm", "pnpm", "yarn", "bun"].includes(name)) {
		const subcommand = words[1]?.toLowerCase();
		const modifies =
			subcommand === "install" || subcommand === "add" || subcommand === "remove" || subcommand === "update";
		const readOnly =
			subcommand === "--version" || subcommand === "-v" || subcommand === "view" || subcommand === "info";
		return {
			workspaceMutation: modifies || outputRedirect,
			readOnly: readOnly && !outputRedirect,
			unknown: !modifies && !readOnly,
		};
	}
	const findModifies =
		(name === "find" || name === "fd") &&
		words.some((word) => ["-delete", "--exec", "-exec", "-execdir", "-ok", "-okdir", "-x"].includes(word));
	const modifies =
		MODIFY_COMMANDS.has(name) ||
		outputRedirect ||
		findModifies ||
		(name === "sed" && words.some((word) => /^-.*i/.test(word)));
	const readOnly = READ_ONLY_COMMANDS.has(name) && !modifies;
	return { workspaceMutation: modifies, readOnly, unknown: !modifies && !readOnly };
}

function nestedCommandAnalysis(
	name: string,
	words: readonly string[],
	redirects: readonly string[],
): ReturnType<typeof analyzeShell> | undefined {
	if (name === "eval") return analyzeShell(words.slice(1).join(" "));
	if (SHELL_INTERPRETERS.has(name) && redirects.includes("<<<")) return analyzeShell(words.slice(1).join(" "));
	if (
		name === "xargs" ||
		name === "parallel" ||
		name === "busybox" ||
		["strace", "ltrace", "watch", "ionice", "chrt", "taskset"].includes(name)
	) {
		const index = executableWordIndex(words, 1);
		return index === -1 ? undefined : analyzeShell(words.slice(index).join(" "));
	}
	if (name === "find" || name === "fd") {
		const marker = words.findIndex((word) => ["-exec", "-execdir", "-ok", "-okdir", "-x"].includes(word));
		if (marker !== -1) {
			const index = executableWordIndex(words, marker + 1);
			return index === -1 ? undefined : analyzeShell(words.slice(index).join(" "));
		}
	}
	if (name === "git") {
		const alias = words.find((word) => /^(?:alias\.[^=]+=|--config=alias\.[^=]+=)!/i.test(word));
		const marker = alias?.indexOf("!") ?? -1;
		if (alias && marker !== -1) return analyzeShell(alias.slice(marker + 1));
	}
	return undefined;
}

function analyzeShell(command: string): {
	workspaceMutation: boolean;
	readOnly: boolean;
	opaque: boolean;
	unknown: boolean;
} {
	const parsed = tokenizeShell(command);
	const simpleCommands = splitSimpleCommands(parsed.tokens);
	const commands = simpleCommands.map(analyzeSimpleCommand);
	const unknown = commands.length === 0 || commands.some((item) => item.unknown);
	const workspaceMutation = parsed.opaque || unknown || commands.some((item) => item.workspaceMutation);
	const readOnly = !parsed.opaque && !unknown && commands.length > 0 && commands.every((item) => item.readOnly);
	return { workspaceMutation, readOnly, opaque: parsed.opaque || unknown, unknown };
}

/** True when the shell command mutates the workspace (or cannot be proven read-only). */
export function shellCommandMutatesWorkspace(command: string): boolean {
	return analyzeShell(command).workspaceMutation;
}

/**
 * True when a tool call is a workspace mutation for Dynamic Task progress
 * tracking. Mirrors the previous managed-tool classification: write/edit tools
 * always mutate, terminal commands count as mutations, and shell tools only
 * mutate when the command analysis says so.
 */
export function isWorkspaceMutatingToolCall(toolName: string, args: unknown): boolean {
	const record =
		typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : undefined;
	if (toolName === "playwright") {
		return record?.action === "screenshot" && typeof record.savePath === "string";
	}
	if (["edit", "write", "remote_edit", "remote_write", "terminal_edit", "terminal_write"].includes(toolName)) {
		return true;
	}
	if (toolName === "terminal_bash") return true;
	if (toolName === "bash" || toolName === "remote_exec" || toolName === "remote_bash") {
		const command = record?.command;
		return typeof command === "string" && shellCommandMutatesWorkspace(command);
	}
	return false;
}
