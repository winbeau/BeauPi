import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { getSearchRuntimeToolDetails } from "../search/types.ts";
import type {
	PolicyFailure,
	PolicyFailureCategory,
	PolicyOperationAccess,
	PolicyOperationDescriptor,
	PolicyOperationKind,
	ResolvedPolicyConfig,
} from "./types.ts";

interface ShellToken {
	kind: "word" | "operator" | "redirect";
	value: string;
}

interface ShellParseResult {
	tokens: ShellToken[];
	opaque: boolean;
}

interface SimpleCommandAnalysis {
	access: PolicyOperationAccess;
	readOnly: boolean;
	workspaceMutation: boolean;
	privileged: boolean;
	network: boolean;
	remoteFallback: boolean;
	unknown: boolean;
	canonicalWords: string[];
}

export interface PolicyOperationAnalysis {
	descriptor: PolicyOperationDescriptor;
	replacementTool?: string;
	replacementSuggestion?: string;
	requiresConfirmation: boolean;
	networkFallback: boolean;
	terminalCommandFallback: boolean;
	/** Terminal lifecycle, inspection, cleanup, or recovery that must remain available after command failures. */
	controlPlane?: boolean;
}

export interface ShellPrivilegeInspection {
	kind: "none" | "sudo" | "unsupported" | "opaque";
	sudo: boolean;
	unsupported: string[];
	executables: string[];
	opaque: boolean;
	sudoStdin: boolean;
	sudoAskpass: boolean;
	interactiveRootShell: boolean;
}

export interface PolicyOperationInput {
	toolName: string;
	args: unknown;
	cwd: string;
	availableTools: readonly string[];
	config: ResolvedPolicyConfig;
}

const POLICY_MANAGED_TOOLS = new Set([
	"bash",
	"read",
	"grep",
	"find",
	"ls",
	"write",
	"edit",
	"target_select",
	"remote_exec",
	"remote_bash",
	"remote_read",
	"remote_write",
	"remote_edit",
	"terminal_create",
	"terminal_bash",
	"terminal_send",
	"terminal_capture",
	"terminal_status",
	"terminal_close",
	"web_search",
	"web_fetch",
]);

const PRIVILEGED_COMMANDS = new Set(["sudo", "su", "doas", "pkexec"]);
const UNSUPPORTED_PRIVILEGE_COMMANDS = new Set([
	"su",
	"doas",
	"pkexec",
	"runuser",
	"setpriv",
	"nsenter",
	"chroot",
	"machinectl",
	"sudoedit",
]);
const NETWORK_COMMANDS = new Set([
	"curl",
	"wget",
	"http",
	"https",
	"aria2c",
	"ftp",
	"lftp",
	"telnet",
	"nc",
	"ncat",
	"socat",
	"xh",
]);
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "fish"]);
const SCRIPT_NETWORK_INTERPRETERS = new Set([
	"python",
	"python3",
	"node",
	"deno",
	"bun",
	"ruby",
	"perl",
	"php",
	"pwsh",
	"powershell",
]);
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
const BRACED_HOME = "$" + "{HOME}";
const POLICY_FAILURE_CATEGORIES = new Set<PolicyFailureCategory>([
	"missing_dependency",
	"permission",
	"authentication",
	"network",
	"rate_limit",
	"timeout",
	"user_cancelled",
	"command_exit",
	"configuration",
	"session_lost",
	"budget_exhausted",
	"unknown",
]);
const SENSITIVE_BASENAMES = new Set([
	".env",
	".npmrc",
	".pypirc",
	".netrc",
	"credentials",
	"credentials.json",
	"auth.json",
	"id_rsa",
	"id_ed25519",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringArg(args: unknown, name: string): string | undefined {
	const value = asRecord(args)?.[name];
	return typeof value === "string" ? value : undefined;
}

function stableJson(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
	if (typeof value === "bigint") return JSON.stringify(value.toString());
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(String(value));
}

function hash(...parts: string[]): string {
	return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

function signature(prefix: string, ...parts: string[]): string {
	return `${prefix}_${hash(...parts)}`;
}

function commandName(value: string): string {
	const normalized = value.replace(/\\/g, "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function tokenizeShell(command: string): ShellParseResult {
	const tokens: ShellToken[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let opaque = command.includes("\0");
	const flush = (): void => {
		if (!current) return;
		tokens.push({ kind: "word", value: current });
		current = "";
	};
	for (let index = 0; index < command.length; index++) {
		const character = command[index]!;
		if (escaped) {
			if (character !== "\n") current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) {
				quote = undefined;
			} else {
				if (quote === '"' && (character === "`" || (character === "$" && command[index + 1] === "("))) {
					opaque = true;
				}
				current += character;
			}
			continue;
		}
		if (character === "'" || character === '"') {
			if (current.endsWith("$")) current = current.slice(0, -1);
			quote = character;
			continue;
		}
		if (character === "`" || (character === "$" && command[index + 1] === "(")) opaque = true;
		if (character === "\n") {
			flush();
			tokens.push({ kind: "operator", value: "\n" });
			continue;
		}
		if (/\s/.test(character)) {
			flush();
			continue;
		}
		const three = command.slice(index, index + 3);
		if (three === "<<<") {
			flush();
			tokens.push({ kind: "redirect", value: three });
			index += 2;
			continue;
		}
		const two = command.slice(index, index + 2);
		if (["&&", "||", ">>", "<<", ">&", "<&", "|&", ";;"].includes(two)) {
			flush();
			tokens.push({ kind: two.includes(">") || two.includes("<") ? "redirect" : "operator", value: two });
			index++;
			continue;
		}
		if ([";", "|", "&", "(", ")"].includes(character)) {
			flush();
			tokens.push({ kind: "operator", value: character });
			if (character === "(" || character === ")") opaque = true;
			continue;
		}
		if (character === ">" || character === "<") {
			flush();
			tokens.push({ kind: "redirect", value: character });
			continue;
		}
		current += character;
	}
	if (escaped) current += "\\";
	if (quote) opaque = true;
	flush();
	return { tokens, opaque };
}

function splitSimpleCommands(tokens: readonly ShellToken[]): ShellToken[][] {
	const commands: ShellToken[][] = [];
	let current: ShellToken[] = [];
	for (const token of tokens) {
		if (token.kind === "operator") {
			if (current.length > 0) commands.push(current);
			current = [];
			continue;
		}
		current.push(token);
	}
	if (current.length > 0) commands.push(current);
	return commands;
}

function shellWords(script: string): string[] {
	return tokenizeShell(script)
		.tokens.filter((token) => token.kind === "word")
		.map((token) => token.value);
}

function unwrapCommand(words: string[], depth = 0): string[] {
	if (depth > 4) return words;
	let index = 0;
	while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index++;
	if (commandName(words[index] ?? "") === "env") {
		index++;
		while (index < words.length) {
			const word = words[index]!;
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
				index++;
				continue;
			}
			if (word === "--") {
				index++;
				break;
			}
			if (word === "-S" || word === "--split-string") {
				const script = words[index + 1] ?? "";
				return unwrapCommand([...shellWords(script), ...words.slice(index + 2)], depth + 1);
			}
			if (word.startsWith("--split-string=")) {
				return unwrapCommand(
					[...shellWords(word.slice("--split-string=".length)), ...words.slice(index + 1)],
					depth + 1,
				);
			}
			if (word.startsWith("-S") && word.length > 2) {
				return unwrapCommand([...shellWords(word.slice(2)), ...words.slice(index + 1)], depth + 1);
			}
			if (["-u", "--unset", "-C", "--chdir"].includes(word)) {
				index += 2;
				continue;
			}
			if (word.startsWith("-")) {
				index++;
				continue;
			}
			break;
		}
	}
	while (
		["!", "if", "then", "elif", "while", "until", "do", "else", "{", "}"].includes(commandName(words[index] ?? ""))
	) {
		index++;
	}
	while (["command", "builtin", "exec", "nohup"].includes(commandName(words[index] ?? ""))) {
		index++;
		while (index < words.length && words[index]!.startsWith("-")) index++;
	}
	if (commandName(words[index] ?? "") === "time") {
		index++;
		while (index < words.length && words[index]!.startsWith("-")) {
			const option = words[index]!;
			if (["-f", "--format", "-o", "--output"].includes(option)) index += 2;
			else index++;
		}
	}
	const wrapper = commandName(words[index] ?? "");
	if (["nice", "setsid", "stdbuf"].includes(wrapper)) {
		index++;
		while (index < words.length && words[index]!.startsWith("-")) {
			const option = words[index]!;
			if (
				(["-n", "--adjustment"].includes(option) && wrapper === "nice") ||
				(["-i", "-o", "-e", "--input", "--output", "--error"].includes(option) && wrapper === "stdbuf")
			) {
				index += 2;
			} else index++;
		}
	}
	if (commandName(words[index] ?? "") === "timeout") {
		index++;
		while (index < words.length && words[index]!.startsWith("-")) {
			const option = words[index]!;
			if (["-s", "--signal", "-k", "--kill-after"].includes(option)) index += 2;
			else index++;
		}
		if (index < words.length) index++;
	}
	const unwrapped = words.slice(index);
	return index > 0 && unwrapped.length > 0 ? unwrapCommand(unwrapped, depth + 1) : unwrapped;
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

function shellCommandScript(words: readonly string[]): string | undefined {
	for (let index = 1; index < words.length; index++) {
		const word = words[index]!;
		if (word === "--command") return words[index + 1];
		if (word.startsWith("--command=")) return word.slice("--command=".length);
		if (/^-[^-]*c[^-]*$/.test(word)) return words[index + 1];
	}
	return undefined;
}

function shellCommandIsInteractive(words: readonly string[]): boolean {
	if (!SHELL_INTERPRETERS.has(commandName(words[0] ?? "")) || shellCommandScript(words) !== undefined) return false;
	const optionsWithValue = new Set([
		"-C",
		"--init-command",
		"-O",
		"+O",
		"--init-file",
		"--rcfile",
		"-o",
		"+o",
		"--debug",
		"--debug-output",
		"--features",
	]);
	for (let index = 1; index < words.length; index++) {
		const word = words[index]!;
		if (word === "--") return index + 1 >= words.length;
		if (!word.startsWith("-") && !word.startsWith("+")) return false;
		const option = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
		if (optionsWithValue.has(option) && !word.includes("=")) index++;
	}
	return true;
}

function canonicalGitStatus(words: string[]): string[] | undefined {
	if (commandName(words[0] ?? "") !== "git") return undefined;
	let index = 1;
	const globals: string[] = [];
	const globalWithValue = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
	while (index < words.length) {
		const token = words[index]!;
		if (["--no-optional-locks", "--no-pager", "--literal-pathspecs"].includes(token)) {
			globals.push(token.toLowerCase());
			index++;
			continue;
		}
		const equals = token.indexOf("=");
		const option = equals === -1 ? token : token.slice(0, equals);
		if (!globalWithValue.has(option)) break;
		if (equals === -1) {
			globals.push(option.toLowerCase(), words[index + 1] ?? "");
			index += 2;
		} else {
			globals.push(`${option.toLowerCase()}=${token.slice(equals + 1)}`);
			index++;
		}
	}
	if ((words[index] ?? "").toLowerCase() !== "status") return undefined;
	index++;
	const options: string[] = [];
	const paths: string[] = [];
	for (; index < words.length; index++) {
		const token = words[index]!;
		if (token === "--") {
			paths.push(...words.slice(index + 1));
			break;
		}
		if (token === "-s") options.push("--short");
		else if (token === "-b") options.push("--branch");
		else if (token === "-sb" || token === "-bs") options.push("--branch", "--short");
		else if (token.startsWith("-")) options.push(token.toLowerCase());
		else paths.push(token);
	}
	return ["git", ...globals, "status", ...[...new Set(options)].sort(), ...(paths.length ? ["--", ...paths] : [])];
}

function executableWordIndex(words: readonly string[], start: number): number {
	const recognized = new Set([
		...PRIVILEGED_COMMANDS,
		...NETWORK_COMMANDS,
		...SHELL_INTERPRETERS,
		...SCRIPT_NETWORK_INTERPRETERS,
		"ssh",
		"mosh",
	]);
	return words.findIndex((word, index) => index >= start && recognized.has(commandName(word)));
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

function analyzeSimpleCommand(tokens: readonly ShellToken[]): SimpleCommandAnalysis {
	const words = unwrapCommand(tokens.filter((token) => token.kind === "word").map((token) => token.value));
	const redirects = tokens.filter((token) => token.kind === "redirect").map((token) => token.value);
	const outputRedirect = redirects.some((redirect) => redirect.includes(">"));
	const name = commandName(words[0] ?? "");
	const canonicalWords = canonicalGitStatus(words) ?? [name, ...words.slice(1)];
	if (!name) {
		return {
			access: outputRedirect ? "write" : "unknown",
			readOnly: false,
			workspaceMutation: outputRedirect,
			privileged: false,
			network: false,
			remoteFallback: false,
			unknown: true,
			canonicalWords,
		};
	}
	if (SHELL_INTERPRETERS.has(name)) {
		const script = shellCommandScript(words);
		if (script !== undefined) {
			const nested = analyzeShell(script);
			return {
				access: nested.access,
				readOnly: nested.readOnly,
				workspaceMutation: nested.workspaceMutation || outputRedirect,
				privileged: nested.privileged,
				network: nested.networkFallback,
				remoteFallback: nested.remoteFallback,
				unknown: nested.opaque,
				canonicalWords: [name, "-c", nested.canonical],
			};
		}
	}
	const nested = nestedCommandAnalysis(name, words, redirects);
	if (nested) {
		return {
			access: nested.access,
			readOnly: false,
			workspaceMutation: nested.workspaceMutation || nested.opaque || outputRedirect,
			privileged: nested.privileged,
			network: nested.networkFallback,
			remoteFallback: nested.remoteFallback,
			unknown: nested.opaque,
			canonicalWords: [name, "embedded", nested.canonical],
		};
	}
	if (PRIVILEGED_COMMANDS.has(name)) {
		return {
			access: "privileged",
			readOnly: false,
			workspaceMutation: false,
			privileged: true,
			network: false,
			remoteFallback: false,
			unknown: false,
			canonicalWords,
		};
	}
	if (name === "ssh" || name === "mosh") {
		return {
			access: "network",
			readOnly: false,
			workspaceMutation: false,
			privileged: false,
			network: false,
			remoteFallback: true,
			unknown: false,
			canonicalWords,
		};
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
		return {
			access: "network",
			readOnly: false,
			workspaceMutation: writesFile,
			privileged: false,
			network: true,
			remoteFallback: false,
			unknown: false,
			canonicalWords,
		};
	}
	if (name === "git") {
		const subcommandIndex = gitSubcommandIndex(words);
		const subcommand = words[subcommandIndex]?.toLowerCase();
		const explicitlyReadOnly =
			subcommand !== undefined &&
			(GIT_READ_ONLY_SUBCOMMANDS.has(subcommand) || gitInspectionSubcommand(words, subcommandIndex));
		const modifies = !explicitlyReadOnly || outputRedirect || GIT_MODIFYING_SUBCOMMANDS.has(subcommand ?? "");
		return {
			access: modifies ? "write" : "read",
			readOnly: !modifies,
			workspaceMutation: modifies,
			privileged: false,
			network: false,
			remoteFallback: false,
			unknown: false,
			canonicalWords,
		};
	}
	if (["npm", "pnpm", "yarn", "bun"].includes(name)) {
		const subcommand = words[1]?.toLowerCase();
		const modifies =
			subcommand === "install" || subcommand === "add" || subcommand === "remove" || subcommand === "update";
		const readOnly =
			subcommand === "--version" || subcommand === "-v" || subcommand === "view" || subcommand === "info";
		return {
			access: modifies || outputRedirect ? "write" : readOnly ? "read" : "unknown",
			readOnly: readOnly && !outputRedirect,
			workspaceMutation: modifies || outputRedirect,
			privileged: false,
			network: false,
			remoteFallback: false,
			unknown: !modifies && !readOnly,
			canonicalWords,
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
	return {
		access: modifies ? "write" : readOnly ? "read" : "unknown",
		readOnly,
		workspaceMutation: modifies,
		privileged: false,
		network: false,
		remoteFallback: false,
		unknown: !modifies && !readOnly,
		canonicalWords,
	};
}

function commandFragments(command: string): Set<string> {
	return new Set(
		command
			.split(/[^A-Za-z0-9_./+-]+/)
			.map(commandName)
			.filter(Boolean),
	);
}

function analyzeShell(command: string): {
	access: PolicyOperationAccess;
	readOnly: boolean;
	workspaceMutation: boolean;
	privileged: boolean;
	networkFallback: boolean;
	remoteFallback: boolean;
	opaque: boolean;
	canonical: string;
} {
	const parsed = tokenizeShell(command);
	const simpleCommands = splitSimpleCommands(parsed.tokens);
	const commands = simpleCommands.map(analyzeSimpleCommand);
	const invokedNames = new Set(
		simpleCommands.map((tokens) =>
			commandName(
				unwrapCommand(tokens.filter((token) => token.kind === "word").map((token) => token.value))[0] ?? "",
			),
		),
	);
	const fragments = parsed.opaque ? commandFragments(command) : new Set<string>();
	const privileged = !parsed.opaque && commands.some((item) => item.privileged);
	const networkIntent =
		/(https?:\/\/|urllib|requests\.|http\.client|fetch\s*\(|axios|https?\.get|net\/http|invoke-webrequest|invoke-restmethod|\/dev\/tcp\/)/i;
	const opaqueScriptNetwork =
		parsed.opaque &&
		([...NETWORK_COMMANDS].some((name) => fragments.has(name)) ||
			([...SCRIPT_NETWORK_INTERPRETERS].some((name) => fragments.has(name)) && networkIntent.test(command)));
	const interpreterScriptNetwork =
		[...SCRIPT_NETWORK_INTERPRETERS, ...SHELL_INTERPRETERS].some((name) => invokedNames.has(name)) &&
		networkIntent.test(command);
	const shellDeviceNetwork = /\/dev\/(?:tcp|udp)\//i.test(command);
	const networkFallback =
		commands.some((item) => item.network) || opaqueScriptNetwork || interpreterScriptNetwork || shellDeviceNetwork;
	const remoteFallback =
		commands.some((item) => item.remoteFallback) ||
		(parsed.opaque && (fragments.has("ssh") || fragments.has("mosh")));
	const unknown = commands.length === 0 || commands.some((item) => item.unknown);
	const workspaceMutation = parsed.opaque || unknown || commands.some((item) => item.workspaceMutation);
	const readOnly = !parsed.opaque && !unknown && commands.length > 0 && commands.every((item) => item.readOnly);
	const access: PolicyOperationAccess = privileged
		? "privileged"
		: networkFallback || remoteFallback
			? "network"
			: workspaceMutation
				? "write"
				: readOnly
					? "read"
					: "unknown";
	const hasStructure = parsed.tokens.some((token) => token.kind !== "word");
	const canonical =
		!hasStructure && commands.length === 1
			? commands[0]!.canonicalWords.map((word) => `word:${word}`).join("\u001f")
			: parsed.tokens
					.map((token) => {
						if (token.kind !== "word") return `${token.kind}:${token.value}`;
						return `word:${token.value}`;
					})
					.join("\u001f");
	return {
		access,
		readOnly,
		workspaceMutation,
		privileged,
		networkFallback,
		remoteFallback,
		opaque: parsed.opaque || unknown,
		canonical,
	};
}

function sudoCommandIndex(words: readonly string[]): number {
	const optionsWithValue = new Set([
		"-u",
		"--user",
		"-g",
		"--group",
		"-h",
		"--host",
		"-p",
		"--prompt",
		"-C",
		"--close-from",
		"-R",
		"--chroot",
		"-D",
		"--chdir",
		"-r",
		"--role",
		"-t",
		"--type",
	]);
	let index = 1;
	while (index < words.length) {
		const word = words[index]!;
		if (word === "--") return index + 1;
		if (!word.startsWith("-") || word === "-") return index;
		const option = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
		index += optionsWithValue.has(option) && !word.includes("=") ? 2 : 1;
	}
	return index;
}

function collectShellPrivilege(
	command: string,
	depth = 0,
): {
	executables: string[];
	opaque: boolean;
	sudoStdin: boolean;
	sudoAskpass: boolean;
	interactiveRootShell: boolean;
} {
	if (depth > 6)
		return { executables: [], opaque: true, sudoStdin: false, sudoAskpass: false, interactiveRootShell: false };
	const parsed = tokenizeShell(command);
	if (parsed.opaque)
		return { executables: [], opaque: true, sudoStdin: false, sudoAskpass: false, interactiveRootShell: false };
	const executables: string[] = [];
	let sudoStdin = false;
	let sudoAskpass = false;
	let interactiveRootShell = false;
	let opaque = false;
	const merge = (nested: ReturnType<typeof collectShellPrivilege>): void => {
		executables.push(...nested.executables);
		sudoStdin ||= nested.sudoStdin;
		sudoAskpass ||= nested.sudoAskpass;
		interactiveRootShell ||= nested.interactiveRootShell;
		opaque ||= nested.opaque;
	};
	for (const tokens of splitSimpleCommands(parsed.tokens)) {
		const words = unwrapCommand(tokens.filter((token) => token.kind === "word").map((token) => token.value));
		const redirects = tokens.filter((token) => token.kind === "redirect").map((token) => token.value);
		const name = commandName(words[0] ?? "");
		if (!name) continue;
		if (name === "sudo") {
			executables.push(name);
			const commandIndex = sudoCommandIndex(words);
			const optionWords = words.slice(1, commandIndex);
			sudoStdin ||= optionWords.some(
				(word) => word === "-S" || word === "--stdin" || (/^-[^-]+$/.test(word) && word.slice(1).includes("S")),
			);
			sudoAskpass ||= optionWords.some(
				(word) =>
					word === "-A" ||
					word === "--askpass" ||
					word.startsWith("--askpass=") ||
					(/^-[^-]+$/.test(word) && word.slice(1).includes("A")),
			);
			interactiveRootShell ||=
				optionWords.some(
					(word) =>
						word === "--shell" || word === "--login" || (/^-[^-]+$/.test(word) && /[si]/.test(word.slice(1))),
				) || shellCommandIsInteractive(unwrapCommand(words.slice(commandIndex)));
			if (commandIndex < words.length) merge(collectShellPrivilege(words.slice(commandIndex).join(" "), depth + 1));
			continue;
		}
		if (UNSUPPORTED_PRIVILEGE_COMMANDS.has(name)) {
			executables.push(name);
			continue;
		}
		if (SHELL_INTERPRETERS.has(name)) {
			const script = shellCommandScript(words);
			if (script !== undefined) merge(collectShellPrivilege(script, depth + 1));
			continue;
		}
		if (name === "eval") {
			merge(collectShellPrivilege(words.slice(1).join(" "), depth + 1));
			continue;
		}
		if (SHELL_INTERPRETERS.has(name) && redirects.includes("<<<")) {
			merge(collectShellPrivilege(words.slice(1).join(" "), depth + 1));
			continue;
		}
		if (
			name === "xargs" ||
			name === "parallel" ||
			name === "busybox" ||
			["strace", "ltrace", "watch", "ionice", "chrt", "taskset"].includes(name)
		) {
			const index = executableWordIndex(words, 1);
			if (index !== -1) merge(collectShellPrivilege(words.slice(index).join(" "), depth + 1));
			continue;
		}
		if (name === "find" || name === "fd") {
			const marker = words.findIndex((word) => ["-exec", "-execdir", "-ok", "-okdir", "-x"].includes(word));
			if (marker !== -1) {
				const index = executableWordIndex(words, marker + 1);
				if (index !== -1) merge(collectShellPrivilege(words.slice(index).join(" "), depth + 1));
			}
		}
	}
	return { executables: [...new Set(executables)], opaque, sudoStdin, sudoAskpass, interactiveRootShell };
}

export function inspectShellPrivilege(command: string): ShellPrivilegeInspection {
	const collected = collectShellPrivilege(command);
	const unsupported = collected.executables.filter((name) => name !== "sudo");
	if (collected.sudoAskpass) unsupported.push("sudo-askpass");
	if (collected.interactiveRootShell) unsupported.push("interactive-root-shell");
	const sudo = collected.executables.includes("sudo");
	return {
		kind: collected.opaque ? "opaque" : unsupported.length > 0 ? "unsupported" : sudo ? "sudo" : "none",
		sudo,
		unsupported,
		executables: collected.executables,
		opaque: collected.opaque,
		sudoStdin: collected.sudoStdin,
		sudoAskpass: collected.sudoAskpass,
		interactiveRootShell: collected.interactiveRootShell,
	};
}

export function hasPotentialShellPrivilege(command: string): boolean {
	const inspection = inspectShellPrivilege(command);
	return (
		inspection.kind === "sudo" ||
		inspection.kind === "unsupported" ||
		(inspection.opaque &&
			/\b(?:sudo|sudoedit|su|doas|pkexec|runuser|setpriv|nsenter|chroot|machinectl)\b/i.test(command))
	);
}

function expandHomePath(value: string): string {
	if (value === "~" || value === "$HOME" || value === BRACED_HOME) return homedir();
	if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
	if (value.startsWith("$HOME/")) return resolve(homedir(), value.slice("$HOME/".length));
	if (value.startsWith(`${BRACED_HOME}/`)) return resolve(homedir(), value.slice(BRACED_HOME.length + 1));
	return value;
}

function normalizePolicyPath(value: string): string {
	return resolve(expandHomePath(value));
}

function shellPathCandidates(word: string): string[] {
	const candidates = [word];
	const equals = word.indexOf("=");
	if (equals !== -1 && equals < word.length - 1) candidates.push(word.slice(equals + 1));
	return candidates;
}

export function policyShellPathReferences(command: string): string[] {
	const parsed = tokenizeShell(command);
	const references: string[] = [];
	for (const simple of splitSimpleCommands(parsed.tokens)) {
		const words = unwrapCommand(simple.filter((token) => token.kind === "word").map((token) => token.value));
		if (SHELL_INTERPRETERS.has(commandName(words[0] ?? ""))) {
			const script = shellCommandScript(words);
			if (script !== undefined) references.push(...policyShellPathReferences(script));
		}
		for (const word of words.slice(1)) {
			for (const candidate of shellPathCandidates(word)) {
				if (!candidate || candidate.startsWith("-") || /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) continue;
				references.push(candidate);
			}
		}
	}
	return [...new Set(references)];
}

function isInsideCwd(path: string, cwd: string): boolean {
	const rel = relative(resolve(cwd), resolve(path));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sensitivePath(value: string, cwd: string, config: ResolvedPolicyConfig): boolean {
	const expanded = expandHomePath(value);
	const normalized = normalizePolicyPath(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
	if (SENSITIVE_BASENAMES.has(basename(normalized).toLowerCase())) return true;
	return config.sensitivePaths.some((configured) => {
		const expanded = expandHomePath(configured);
		const root = normalizePolicyPath(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
		return normalized === root || normalized.startsWith(`${root}${sep}`);
	});
}

export function policyPathRequiresConfirmation(
	value: string,
	cwd: string,
	config: ResolvedPolicyConfig,
	writes: boolean,
): boolean {
	return sensitivePath(value, cwd, config) || (writes && !isInsideCwd(value, cwd));
}

function shellMentionsSensitivePath(command: string, cwd: string, config: ResolvedPolicyConfig): boolean {
	const parsed = tokenizeShell(command);
	return parsed.tokens.some((token) => {
		if (token.kind !== "word") return false;
		return shellPathCandidates(token.value).some((value) => {
			const lower = value.toLowerCase();
			if (
				/(?:^|\/)(?:\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.config\/(?:gcloud|gh))(?:\/|$)/.test(lower) ||
				/(?:^|\/)(?:\.env|\.npmrc|\.pypirc|\.netrc|credentials(?:\.json)?|auth\.json|id_rsa|id_ed25519)(?:\/|$)/.test(
					lower,
				)
			) {
				return true;
			}
			return sensitivePath(value, cwd, config);
		});
	});
}

function shellWritesOutsideWorkspace(command: string, cwd: string): boolean {
	const parsed = tokenizeShell(command);
	return parsed.tokens.some((token) => {
		if (token.kind !== "word") return false;
		return shellPathCandidates(token.value).some((value) => {
			const expanded = expandHomePath(value);
			if (!isAbsolute(expanded) && !expanded.startsWith("..")) return false;
			const normalized = isAbsolute(expanded) ? normalizePolicyPath(expanded) : resolve(cwd, expanded);
			return !isInsideCwd(normalized, cwd);
		});
	});
}

function shellEscapesUnknownRemoteCwd(command: string): boolean {
	const parsed = tokenizeShell(command);
	return parsed.tokens.some((token) => {
		if (token.kind !== "word") return false;
		return shellPathCandidates(token.value).some(
			(value) =>
				posix.isAbsolute(value) ||
				value === "~" ||
				value.startsWith("~/") ||
				value === "$HOME" ||
				value.startsWith("$HOME/") ||
				value === BRACED_HOME ||
				value.startsWith(`${BRACED_HOME}/`) ||
				value.startsWith(".."),
		);
	});
}

function canonicalUrlFromCommand(command: string): string | undefined {
	const parsed = tokenizeShell(command);
	for (const token of parsed.tokens) {
		if (token.kind !== "word" || !/^https?:\/\//i.test(token.value)) continue;
		try {
			const url = new URL(token.value);
			url.username = "";
			url.password = "";
			url.hash = "";
			return url.toString();
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function shellReadEquivalence(command: string, cwd: string, remote: boolean): string[] | undefined {
	const parsed = tokenizeShell(command);
	if (parsed.opaque || parsed.tokens.some((token) => token.kind !== "word")) return undefined;
	const words = unwrapCommand(parsed.tokens.map((token) => token.value));
	if (commandName(words[0] ?? "") !== "cat") return undefined;
	const paths = words.slice(1).filter((word) => word !== "--");
	if (paths.length !== 1 || paths[0]!.startsWith("-")) return undefined;
	const path = remote ? posix.normalize(paths[0]!) : resolve(cwd, paths[0]!);
	return ["file_read", path, "{}"];
}

function operation(
	input: PolicyOperationInput,
	options: {
		kind: PolicyOperationKind;
		classes: PolicyOperationKind[];
		access: PolicyOperationAccess;
		target: string;
		signatureParts: string[];
		equivalenceParts?: string[];
		fallbackFamily?: PolicyOperationDescriptor["fallbackFamily"];
		dedicatedTool?: string;
		sensitive?: boolean;
		privileged?: boolean;
		readOnly?: boolean;
		workspaceMutation?: boolean;
		summary: string;
	},
): PolicyOperationDescriptor {
	return {
		version: 1,
		toolName: input.toolName,
		kind: options.kind,
		classes: [...new Set(options.classes)],
		access: options.access,
		target: options.target,
		signature: signature("policy", input.toolName, options.target, ...options.signatureParts),
		equivalenceSignature: signature(
			"policy_eq",
			options.target,
			...(options.equivalenceParts ?? options.signatureParts),
		),
		fallbackFamily: options.fallbackFamily,
		dedicatedTool: options.dedicatedTool,
		sensitive: options.sensitive ?? false,
		privileged: options.privileged ?? false,
		readOnly: options.readOnly ?? false,
		workspaceMutation: options.workspaceMutation ?? false,
		summary: options.summary,
	};
}

export function classifyPolicyOperation(input: PolicyOperationInput): PolicyOperationAnalysis | undefined {
	if (!POLICY_MANAGED_TOOLS.has(input.toolName)) return undefined;
	const available = new Set(input.availableTools);
	const args = asRecord(input.args);
	if (input.toolName === "web_search") {
		const query = stringArg(args, "query") ?? "";
		return {
			descriptor: operation(input, {
				kind: "network_search",
				classes: ["network_search"],
				access: "network",
				target: "web:search",
				signatureParts: [query.normalize("NFKC").trim().replace(/\s+/g, " ")],
				fallbackFamily: "network",
				summary: "Web search",
			}),
			requiresConfirmation: false,
			networkFallback: false,
			terminalCommandFallback: false,
		};
	}
	if (input.toolName === "web_fetch") {
		const url = stringArg(args, "url") ?? "";
		return {
			descriptor: operation(input, {
				kind: "network_fetch",
				classes: ["network_fetch"],
				access: "network",
				target: "web:fetch",
				signatureParts: [url],
				fallbackFamily: "network",
				summary: "Web content fetch",
			}),
			requiresConfirmation: false,
			networkFallback: false,
			terminalCommandFallback: false,
		};
	}
	if (
		["read", "grep", "find", "ls", "write", "edit", "remote_read", "remote_write", "remote_edit"].includes(
			input.toolName,
		)
	) {
		const path = stringArg(args, "path") ?? stringArg(args, "file_path") ?? "";
		const remote = input.toolName.startsWith("remote_");
		const writes = input.toolName.endsWith("write") || input.toolName.endsWith("edit");
		const normalizedPath = remote ? posix.normalize(path || ".") : resolve(input.cwd, path || ".");
		const isSensitive = path ? sensitivePath(path, input.cwd, input.config) : false;
		const outsideWorkspace =
			writes && path
				? remote
					? posix.isAbsolute(path) ||
						path === "~" ||
						path.startsWith("~/") ||
						path === "$HOME" ||
						path.startsWith("$HOME/") ||
						path === BRACED_HOME ||
						path.startsWith(`${BRACED_HOME}/`) ||
						path.startsWith("..")
					: !isInsideCwd(isAbsolute(path) ? path : resolve(input.cwd, path), input.cwd)
				: false;
		const classes: PolicyOperationKind[] = [writes ? "workspace_write" : "read_only_check"];
		if (isSensitive || outsideWorkspace) classes.push("sensitive_path");
		const target = remote ? `remote:${stringArg(args, "targetId") ?? "selected"}` : "local";
		const scope = remote ? "Remote" : "Local";
		const summary = outsideWorkspace
			? remote
				? "Remote write outside configured cwd"
				: "Local write outside workspace"
			: isSensitive
				? `${scope} ${writes ? "write to" : "read from"} sensitive path`
				: `${scope} ${writes ? "workspace modification" : "read-only check"}`;
		const operationArguments = writes
			? hash(stableJson(args ?? {}))
			: input.toolName === "read" || input.toolName === "remote_read"
				? stableJson({ offset: args?.offset, limit: args?.limit })
				: hash(stableJson(args ?? {}));
		const operationType = writes
			? "write"
			: input.toolName === "read" || input.toolName === "remote_read"
				? "file_read"
				: input.toolName;
		return {
			descriptor: operation(input, {
				kind: isSensitive || outsideWorkspace ? "sensitive_path" : writes ? "workspace_write" : "read_only_check",
				classes,
				access: writes ? "write" : "read",
				target,
				signatureParts: [operationType, normalizedPath, operationArguments],
				equivalenceParts: [operationType, normalizedPath, operationArguments],
				fallbackFamily: remote ? "remote" : "local",
				sensitive: isSensitive || outsideWorkspace,
				readOnly: !writes,
				workspaceMutation: writes,
				summary,
			}),
			requiresConfirmation: isSensitive || outsideWorkspace,
			networkFallback: false,
			terminalCommandFallback: false,
		};
	}
	if (input.toolName === "target_select") {
		return {
			descriptor: operation(input, {
				kind: "remote_command",
				classes: ["remote_command"],
				access: "write",
				target: "remote:selected",
				signatureParts: [stringArg(args, "targetId") ?? "unknown"],
				fallbackFamily: "remote",
				workspaceMutation: true,
				summary: "Remote target selection",
			}),
			requiresConfirmation: false,
			networkFallback: false,
			terminalCommandFallback: false,
		};
	}
	if (["terminal_capture", "terminal_status", "terminal_close"].includes(input.toolName)) {
		const terminalId = stringArg(args, "terminalId") ?? "unknown";
		const closes = input.toolName === "terminal_close";
		return {
			descriptor: operation(input, {
				kind: closes ? "terminal_command" : "read_only_check",
				classes: closes ? ["terminal_command"] : ["terminal_command", "read_only_check"],
				access: closes ? "write" : "read",
				target: `terminal:${terminalId}`,
				signatureParts: [input.toolName, stableJson(args ?? {})],
				readOnly: !closes,
				workspaceMutation: closes,
				summary:
					input.toolName === "terminal_capture"
						? "Inspect terminal output"
						: input.toolName === "terminal_status"
							? "Check terminal status"
							: "Close terminal",
			}),
			requiresConfirmation: false,
			networkFallback: false,
			terminalCommandFallback: false,
			controlPlane: true,
		};
	}
	const commandKey = input.toolName === "terminal_send" ? "input" : "command";
	const command = stringArg(args, commandKey) ?? "";
	if (input.toolName === "terminal_create" && command.trim() === "") {
		const terminalId = stringArg(args, "terminalId") ?? "unknown";
		return {
			descriptor: operation(input, {
				kind: "terminal_command",
				classes: ["terminal_command"],
				access: "write",
				target: `terminal:${terminalId}`,
				signatureParts: [input.toolName, stableJson(args ?? {})],
				workspaceMutation: true,
				summary: "Create terminal",
			}),
			requiresConfirmation: false,
			networkFallback: false,
			terminalCommandFallback: false,
			controlPlane: true,
		};
	}
	const shell = analyzeShell(command);
	const remote = input.toolName === "remote_exec" || input.toolName === "remote_bash";
	const terminal = input.toolName.startsWith("terminal_");
	const targetId = stringArg(args, "targetId") ?? "selected";
	const terminalId = stringArg(args, "terminalId") ?? "unknown";
	const target = terminal ? `terminal:${terminalId}` : remote ? `remote:${targetId}` : "local";
	const terminalRecoveryInput =
		input.toolName === "terminal_send" &&
		command.length > 0 &&
		[...command].every((character) => character === "\u0003" || character === "\u0004" || character === "\u0015");
	const fallbackFamily = terminal ? "terminal" : remote ? "remote" : "local";
	const mentionsSensitivePath = shellMentionsSensitivePath(command, input.cwd, input.config);
	const escapesWorkspaceBoundary =
		shell.workspaceMutation &&
		(remote || terminal ? shellEscapesUnknownRemoteCwd(command) : shellWritesOutsideWorkspace(command, input.cwd));
	const sensitive = mentionsSensitivePath || escapesWorkspaceBoundary;
	const ordinaryTerminalCommand =
		input.toolName === "terminal_send" &&
		/\r?\n$/.test(command) &&
		!shell.opaque &&
		(shell.readOnly || shell.workspaceMutation || shell.networkFallback);
	const networkFallback = shell.networkFallback;
	const remoteFallback = shell.remoteFallback && !remote;
	const dedicatedTool = networkFallback
		? canonicalUrlFromCommand(command) && available.has("web_fetch")
			? "web_fetch"
			: available.has("web_search")
				? "web_search"
				: undefined
		: remoteFallback && available.has("remote_exec")
			? "remote_exec"
			: ordinaryTerminalCommand && available.has("terminal_bash")
				? "terminal_bash"
				: undefined;
	const classes: PolicyOperationKind[] = [remote ? "remote_command" : terminal ? "terminal_command" : "local_shell"];
	if (shell.privileged) classes.push("privileged");
	if (networkFallback) classes.push("shell_network_fallback");
	if (dedicatedTool) classes.push("dedicated_tool_fallback");
	if (shell.readOnly) classes.push("read_only_check");
	if (shell.workspaceMutation) classes.push("workspace_write");
	if (sensitive) classes.push("sensitive_path");
	if (shell.opaque) classes.push("opaque");
	const kind: PolicyOperationKind = shell.privileged
		? "privileged"
		: networkFallback
			? "shell_network_fallback"
			: dedicatedTool
				? "dedicated_tool_fallback"
				: sensitive
					? "sensitive_path"
					: shell.readOnly
						? "read_only_check"
						: shell.opaque
							? "opaque"
							: shell.workspaceMutation
								? "workspace_write"
								: remote
									? "remote_command"
									: terminal
										? "terminal_command"
										: "local_shell";
	const signatureParts = shell.opaque ? ["opaque", hash(command)] : [shell.canonical];
	const descriptor = operation(input, {
		kind,
		classes,
		access: shell.access,
		target,
		signatureParts,
		equivalenceParts: shellReadEquivalence(command, input.cwd, remote) ?? signatureParts,
		fallbackFamily: terminalRecoveryInput ? undefined : networkFallback ? "network" : fallbackFamily,
		dedicatedTool,
		sensitive,
		privileged: shell.privileged,
		readOnly: shell.readOnly,
		workspaceMutation: shell.workspaceMutation || terminal,
		summary: terminalRecoveryInput
			? "Clear terminal input"
			: networkFallback
				? "Shell network fallback"
				: escapesWorkspaceBoundary
					? remote
						? "Remote write outside configured cwd"
						: terminal
							? "Terminal write outside working directory"
							: "Local write outside workspace"
					: mentionsSensitivePath
						? `${remote ? "Remote" : terminal ? "Terminal" : "Local"} sensitive-path ${shell.readOnly ? "read" : "command"}`
						: remote
							? "Remote command"
							: terminal
								? "Terminal command"
								: shell.readOnly
									? "Local read-only check"
									: shell.workspaceMutation
										? "Local workspace modification"
										: "Local shell command",
	});
	return {
		descriptor,
		replacementTool: dedicatedTool,
		replacementSuggestion:
			dedicatedTool === "web_fetch"
				? "Use web_fetch with the validated HTTP(S) URL."
				: dedicatedTool === "web_search"
					? "Use web_search for discovery, then web_fetch for selected pages."
					: dedicatedTool === "remote_exec"
						? "Use remote_exec on the selected trusted target."
						: dedicatedTool === "terminal_bash"
							? "Use terminal_bash for an ordinary command in the existing terminal."
							: undefined,
		requiresConfirmation: sensitive,
		networkFallback,
		terminalCommandFallback: ordinaryTerminalCommand,
		controlPlane: input.toolName === "terminal_create" || terminalRecoveryInput || undefined,
	};
}

function errorCodes(error: unknown): Set<string> {
	const codes = new Set<string>();
	let current: unknown = error;
	for (let depth = 0; depth < 5; depth++) {
		const record = asRecord(current);
		if (!record) break;
		if (typeof record.code === "string") codes.add(record.code);
		current = record.cause;
	}
	return codes;
}

function categoryLimitKey(category: PolicyFailureCategory): keyof ResolvedPolicyConfig["budget"] | undefined {
	switch (category) {
		case "missing_dependency":
			return "maxMissingDependencyFailures";
		case "permission":
			return "maxPermissionFailures";
		case "authentication":
			return "maxAuthenticationFailures";
		case "network":
			return "maxNetworkFailures";
		case "rate_limit":
			return "maxRateLimitFailures";
		case "timeout":
			return "maxTimeoutFailures";
		case "command_exit":
			return "maxCommandExitFailures";
		case "configuration":
		case "budget_exhausted":
			return "maxConfigurationFailures";
		case "session_lost":
			return "maxSessionLostFailures";
		case "user_cancelled":
		case "unknown":
			return undefined;
	}
}

export function policyFailureLimit(category: PolicyFailureCategory, config: ResolvedPolicyConfig): number | undefined {
	const key = categoryLimitKey(category);
	return key ? config.budget[key] : undefined;
}

export function classifyPolicyFailure(input: {
	toolName: string;
	details: unknown;
	isError: boolean;
	thrownError?: unknown;
	signal?: AbortSignal;
}): PolicyFailure | undefined {
	if (input.signal?.aborted) return { category: "user_cancelled", retryable: false };
	const existingPolicy = asRecord(asRecord(input.details)?.policy);
	if (existingPolicy && existingPolicy.executed === false) return undefined;
	const search = getSearchRuntimeToolDetails(input.details);
	if (search?.ok === false) {
		const code = search.diagnostics.find((item) => item.severity === "error")?.code;
		const category: PolicyFailureCategory =
			code === "cancelled"
				? "user_cancelled"
				: code === "authentication"
					? "authentication"
					: code === "rate_limited"
						? "rate_limit"
						: code === "timeout"
							? "timeout"
							: code === "dns" || code === "connection" || code === "tls" || code === "http"
								? "network"
								: code === "budget_exhausted"
									? "budget_exhausted"
									: "configuration";
		return { category, retryable: category === "network" || category === "timeout" };
	}
	const details = asRecord(input.details);
	const diagnostic = asRecord(details?.diagnostic);
	if (diagnostic && typeof diagnostic.code === "string") {
		const code = diagnostic.code;
		const exitCode =
			typeof diagnostic.exitCode === "number" || diagnostic.exitCode === null ? diagnostic.exitCode : undefined;
		const category: PolicyFailureCategory =
			code === "remote_cancelled"
				? "user_cancelled"
				: code === "ssh_authentication"
					? "authentication"
					: code === "remote_timeout" || code === "ssh_timeout"
						? "timeout"
						: code === "ssh_connection" || code === "ssh_disconnected" || code === "ssh_host_key"
							? "network"
							: code === "terminal_session_lost" || code === "terminal_not_found" || code === "terminal_closed"
								? "session_lost"
								: code === "target_untrusted"
									? "permission"
									: code === "target_invalid" ||
											code === "target_not_found" ||
											code === "target_not_selected" ||
											code === "target_mismatch" ||
											code === "terminal_invalid" ||
											code === "terminal_busy" ||
											code === "adapter_unavailable" ||
											code === "tmux_unavailable"
										? "configuration"
										: code === "remote_command" && exitCode === 127
											? "missing_dependency"
											: code === "remote_command" && exitCode === 126
												? "permission"
												: "command_exit";
		return {
			category,
			exitCode,
			retryable: diagnostic.retryable === true || category === "network" || category === "timeout",
		};
	}
	const thrown = asRecord(input.thrownError);
	if (thrown && typeof thrown.policyCategory === "string") {
		const category = thrown.policyCategory as PolicyFailureCategory;
		return {
			category,
			exitCode: typeof thrown.exitCode === "number" || thrown.exitCode === null ? thrown.exitCode : undefined,
			retryable: category === "network" || category === "timeout",
		};
	}
	const explicitCategory = details?.policyCategory;
	if (
		typeof explicitCategory === "string" &&
		POLICY_FAILURE_CATEGORIES.has(explicitCategory as PolicyFailureCategory)
	) {
		const category = explicitCategory as PolicyFailureCategory;
		return {
			category,
			exitCode: typeof details?.exitCode === "number" || details?.exitCode === null ? details.exitCode : undefined,
			retryable: category === "network" || category === "timeout",
		};
	}
	const codes = errorCodes(input.thrownError);
	if (codes.has("ENOENT")) return { category: "missing_dependency", retryable: false };
	if (codes.has("EACCES") || codes.has("EPERM")) return { category: "permission", retryable: false };
	if (codes.has("ETIMEDOUT") || codes.has("UND_ERR_CONNECT_TIMEOUT")) return { category: "timeout", retryable: true };
	if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH"].some((code) => codes.has(code))) {
		return { category: "network", retryable: true };
	}
	const exitCode = typeof details?.exitCode === "number" ? details.exitCode : undefined;
	if (exitCode !== undefined && exitCode !== 0) {
		return {
			category: exitCode === 127 ? "missing_dependency" : exitCode === 126 ? "permission" : "command_exit",
			exitCode,
			retryable: false,
		};
	}
	return input.isError ? { category: "command_exit", retryable: false } : undefined;
}
