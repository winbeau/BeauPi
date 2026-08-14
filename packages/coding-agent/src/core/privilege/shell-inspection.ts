// Neutral shell privilege inspection.
//
// Detects sudo/su/doas-style privilege-changing commands in shell command
// lines. This module performs no authorization and no routing: it exists so
// the controlled privilege terminal (M13) can decide when a command must go
// through its user-present staging flow instead of the ordinary executor.
//
// The tokenizer helpers are shared with core/execution/shell-parse.ts.

import {
	commandName,
	executableWordIndex,
	SHELL_INTERPRETERS,
	shellCommandScript,
	splitSimpleCommands,
	tokenizeShell,
	unwrapCommand,
} from "../execution/shell-parse.ts";

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
