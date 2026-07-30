const SKIP_TAGS = new Set([
	"script",
	"style",
	"nav",
	"header",
	"footer",
	"aside",
	"form",
	"noscript",
	"svg",
	"canvas",
	"iframe",
	"template",
]);

const BLOCK_TAGS = new Set([
	"address",
	"article",
	"blockquote",
	"br",
	"dd",
	"div",
	"dl",
	"dt",
	"figcaption",
	"figure",
	"hr",
	"li",
	"main",
	"ol",
	"p",
	"pre",
	"section",
	"table",
	"tbody",
	"td",
	"th",
	"thead",
	"tr",
	"ul",
]);

const ENTITIES: Readonly<Record<string, string>> = Object.freeze({
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	nbsp: " ",
	quot: '"',
	ndash: "–",
	mdash: "—",
	hellip: "…",
	copy: "©",
	reg: "®",
	trade: "™",
});

export interface ExtractedWebContent {
	title: string;
	markdown: string;
	summary: string;
}

function decodeEntities(value: string): string {
	return value.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi, (match, entity: string) => {
		if (entity.startsWith("#x") || entity.startsWith("#X")) {
			const codePoint = Number.parseInt(entity.slice(2), 16);
			return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
		}
		if (entity.startsWith("#")) {
			const codePoint = Number.parseInt(entity.slice(1), 10);
			return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
		}
		return ENTITIES[entity.toLowerCase()] ?? match;
	});
}

function cleanInlineText(value: string): string {
	return decodeEntities(value).replace(/\s+/g, " ").trim();
}

function tagName(token: string): string | undefined {
	const match = token.match(/^<\/?\s*([a-zA-Z][\w:-]*)/);
	return match?.[1]?.toLowerCase();
}

function isClosingTag(token: string): boolean {
	return /^<\//.test(token);
}

function isSelfClosingTag(token: string, name: string): boolean {
	return /\/\s*>$/.test(token) || ["br", "hr", "img", "meta", "link", "input", "source", "wbr"].includes(name);
}

function preferredBody(html: string): string {
	for (const tag of ["main", "article"]) {
		const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "i"));
		if (match?.[1]) return match[1];
	}
	const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
	return body?.[1] ?? html;
}

function normalizeMarkdown(value: string): string {
	const rawLines = value
		.replace(/\r/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.split("\n")
		.map((line) =>
			line
				.trim()
				.replace(/^(#{1,6})\s+/, "$1 ")
				.replace(/^([-*+]|\d+\.)\s+/, "$1 "),
		);
	const output: string[] = [];
	const seenComparable = new Set<string>();
	let previousComparable = "";
	for (const line of rawLines) {
		const trimmed = line.trim();
		if (!trimmed) {
			if (output.length > 0 && output.at(-1) !== "") output.push("");
			previousComparable = "";
			continue;
		}
		const comparable = trimmed.toLowerCase().replace(/\s+/g, " ");
		if (comparable.length > 20 && (comparable === previousComparable || seenComparable.has(comparable))) continue;
		output.push(line);
		if (comparable.length > 20) seenComparable.add(comparable);
		previousComparable = comparable;
	}
	while (output.at(-1) === "") output.pop();
	return output.join("\n").trim();
}

function summarize(markdown: string): string {
	const text = markdown
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^[-*+]\s+/gm, "")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

export function extractHtmlToMarkdown(html: string, fallbackTitle: string): ExtractedWebContent {
	const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
	const metadataTitle = html.match(
		/<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:title|twitter:title)["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/i,
	);
	const source = preferredBody(html.replace(/<!--[\s\S]*?-->/g, ""));
	const output: string[] = [];
	const skipStack: string[] = [];
	const listStack: string[] = [];
	let preDepth = 0;
	for (const token of source.match(/<[^>]*>|[^<]+/g) ?? []) {
		if (!token.startsWith("<")) {
			if (skipStack.length > 0) continue;
			if (preDepth > 0) {
				output.push(decodeEntities(token));
				continue;
			}
			const text = cleanInlineText(token);
			if (text) output.push(text);
			continue;
		}
		const name = tagName(token);
		if (!name) continue;
		const closing = isClosingTag(token);
		if (SKIP_TAGS.has(name)) {
			if (!closing && !isSelfClosingTag(token, name)) skipStack.push(name);
			else if (closing) {
				const index = skipStack.lastIndexOf(name);
				if (index !== -1) skipStack.splice(index, 1);
			}
			continue;
		}
		if (skipStack.length > 0) continue;
		if (name === "pre") {
			if (!closing) {
				preDepth++;
				output.push("\n```\n");
			} else {
				preDepth = Math.max(0, preDepth - 1);
				output.push("\n```\n");
			}
			continue;
		}
		if (name === "ul" || name === "ol") {
			if (closing) listStack.pop();
			else listStack.push(name);
			output.push("\n");
			continue;
		}
		if (!closing && name === "li") {
			output.push(listStack.at(-1) === "ol" ? "\n1. " : "\n- ");
			continue;
		}
		const headingMatch = name.match(/^h([1-6])$/);
		if (headingMatch) {
			if (!closing) output.push(`\n${"#".repeat(Number(headingMatch[1]))} `);
			else output.push("\n");
			continue;
		}
		if (name === "code" && !closing) output.push("`");
		else if (name === "code" && closing) output.push("`");
		else if (name === "strong" || name === "b") output.push("**");
		else if (name === "em" || name === "i") output.push("*");
		else if (BLOCK_TAGS.has(name)) output.push("\n");
	}
	const markdown = normalizeMarkdown(output.join(" "));
	const firstHeading = markdown.match(/^#{1,6}\s+(.+)$/m)?.[1];
	const title =
		cleanInlineText(titleMatch?.[1] ?? metadataTitle?.[1] ?? firstHeading ?? fallbackTitle) || fallbackTitle;
	return { title, markdown, summary: summarize(markdown) };
}

export function extractTextContent(text: string, fallbackTitle: string): ExtractedWebContent {
	const markdown = normalizeMarkdown(text.replace(/\u0000/g, ""));
	return { title: fallbackTitle, markdown, summary: summarize(markdown) };
}

export function extractJsonContent(text: string, fallbackTitle: string): ExtractedWebContent {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("invalid_json");
	}
	const markdown = JSON.stringify(parsed, null, 2);
	return { title: fallbackTitle, markdown, summary: summarize(markdown) };
}
