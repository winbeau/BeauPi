// Neutral shell command parsing helpers.
//
// These helpers tokenize and unwrap shell command lines for execution-fact
// classification (workspace mutation detection). They perform no
// authorization and no privilege routing.

export interface ShellToken {
	kind: "word" | "operator" | "redirect";
	value: string;
}

interface ShellParseResult {
	tokens: ShellToken[];
	opaque: boolean;
}

export const PRIVILEGED_COMMANDS = new Set(["sudo", "su", "doas", "pkexec"]);
export const NETWORK_COMMANDS = new Set([
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
export const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "fish"]);
export const SCRIPT_NETWORK_INTERPRETERS = new Set([
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

export function commandName(value: string): string {
	const normalized = value.replace(/\\/g, "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

export function tokenizeShell(command: string): ShellParseResult {
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

export function splitSimpleCommands(tokens: readonly ShellToken[]): ShellToken[][] {
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

export function shellWords(script: string): string[] {
	return tokenizeShell(script)
		.tokens.filter((token) => token.kind === "word")
		.map((token) => token.value);
}

export function unwrapCommand(words: string[], depth = 0): string[] {
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

export function shellCommandScript(words: readonly string[]): string | undefined {
	for (let index = 1; index < words.length; index++) {
		const word = words[index]!;
		if (word === "--command") return words[index + 1];
		if (word.startsWith("--command=")) return word.slice("--command=".length);
		if (/^-[^-]*c[^-]*$/.test(word)) return words[index + 1];
	}
	return undefined;
}

export function executableWordIndex(words: readonly string[], start: number): number {
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
