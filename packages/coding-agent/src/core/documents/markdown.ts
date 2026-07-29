import {
	type DocumentCitation,
	type DocumentReference,
	type IndexedDocument,
	type MarkdownCodeBlock,
	type MarkdownHeading,
	stableDocumentId,
} from "./types.ts";

const FENCE_PATTERN = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const ATX_PATTERN = /^\s{0,3}(#{1,6})(?:[ \t]+|$)(.*?)\s*$/;
const SETEXT_PATTERN = /^\s{0,3}(=+|-+)\s*$/;

function cleanHeadingTitle(title: string): string {
	return title.replace(/[ \t]+#+[ \t]*$/, "").trim();
}

function isFenceClose(line: string, marker: string): boolean {
	const match = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
	return match !== null && match[1]![0] === marker[0] && match[1]!.length >= marker.length;
}

function headingPathAt(headings: readonly MarkdownHeading[], line: number): string[] | undefined {
	let best: MarkdownHeading | undefined;
	for (const heading of headings) {
		if (heading.startLine <= line && (!best || heading.startLine > best.startLine)) best = heading;
	}
	return best?.path;
}

function buildHeadingEndLines(headings: MarkdownHeading[], totalLines: number): void {
	for (const heading of headings) {
		heading.endLine = totalLines;
		for (const candidate of headings) {
			if (candidate.startLine <= heading.startLine || candidate.level > heading.level) continue;
			if (candidate.startLine < heading.endLine) heading.endLine = candidate.startLine - 1;
		}
	}
}

export function indexMarkdownDocument(reference: DocumentReference, content: string): IndexedDocument {
	const normalizedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalizedContent.split("\n");
	const headings: MarkdownHeading[] = [];
	const codeBlocks: MarkdownCodeBlock[] = [];
	const fencedLines = new Set<number>();
	let activeFence: { marker: string; language?: string; startLine: number; contentStartLine: number } | undefined;

	for (let index = 0; index < lines.length; index++) {
		const lineNumber = index + 1;
		const line = lines[index] ?? "";
		if (activeFence) {
			fencedLines.add(lineNumber);
			if (isFenceClose(line, activeFence.marker)) {
				const contentStartIndex = activeFence.contentStartLine - 1;
				const endIndex = lineNumber - 2;
				codeBlocks.push({
					language: activeFence.language,
					startLine: activeFence.startLine,
					contentStartLine: activeFence.contentStartLine,
					endLine: lineNumber,
					lines: lines.slice(contentStartIndex, Math.max(contentStartIndex, endIndex + 1)),
					headingPath: headingPathAt(headings, activeFence.startLine),
				});
				activeFence = undefined;
			}
			continue;
		}

		const fence = line.match(FENCE_PATTERN);
		if (fence) {
			activeFence = {
				marker: fence[1]!,
				language: fence[2]!.trim().split(/\s+/, 1)[0] || undefined,
				startLine: lineNumber,
				contentStartLine: lineNumber + 1,
			};
			fencedLines.add(lineNumber);
			continue;
		}

		const atx = line.match(ATX_PATTERN);
		if (atx) {
			const level = atx[1]!.length;
			const title = cleanHeadingTitle(atx[2] ?? "");
			if (title.length > 0)
				headings.push({
					id: "",
					level,
					title,
					path: [],
					startLine: lineNumber,
					contentStartLine: lineNumber + 1,
					endLine: lines.length,
				});
			continue;
		}

		if (index + 1 < lines.length && !fencedLines.has(lineNumber + 1) && line.trim().length > 0) {
			const setext = lines[index + 1]?.match(SETEXT_PATTERN);
			if (setext) {
				headings.push({
					id: "",
					level: setext[1]![0] === "=" ? 1 : 2,
					title: line.trim(),
					path: [],
					startLine: lineNumber,
					contentStartLine: lineNumber + 2,
					endLine: lines.length,
				});
				fencedLines.add(lineNumber + 1);
				index++;
			}
		}
	}

	const stack: MarkdownHeading[] = [];
	for (const heading of headings) {
		while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) stack.pop();
		heading.path = [...stack.map((item) => item.title), heading.title];
		heading.id = stableDocumentId("heading", reference.id, heading.path.join("/"), String(heading.startLine));
		stack.push(heading);
	}
	buildHeadingEndLines(headings, lines.length);

	for (const block of codeBlocks) {
		block.headingPath = headingPathAt(headings, block.startLine);
	}

	return {
		reference,
		content: normalizedContent,
		lines,
		headings,
		codeBlocks,
		packageScripts: [],
	};
}

export function createDocumentCitation(
	document: DocumentReference,
	startLine: number,
	endLine: number,
	headingPath?: string[],
): DocumentCitation {
	const normalizedStart = Math.max(1, Math.floor(startLine));
	const normalizedEnd = Math.max(normalizedStart, Math.floor(endLine));
	return {
		id: stableDocumentId(
			"citation",
			document.id,
			document.hash,
			headingPath?.join("/") ?? "",
			String(normalizedStart),
			String(normalizedEnd),
		),
		documentId: document.id,
		path: document.path,
		displayPath: document.displayPath,
		headingPath: headingPath && headingPath.length > 0 ? [...headingPath] : undefined,
		startLine: normalizedStart,
		endLine: normalizedEnd,
		documentHash: document.hash,
	};
}

export function findHeading(
	document: IndexedDocument,
	headingPath: string,
): {
	heading?: MarkdownHeading;
	ambiguous: boolean;
} {
	const normalized = headingPath
		.split(/[/>]/)
		.map((part) => part.trim().toLocaleLowerCase())
		.filter(Boolean)
		.join("/");
	const matches = document.headings.filter((heading) => heading.path.join("/").toLocaleLowerCase() === normalized);
	if (matches.length > 1) return { heading: matches[0], ambiguous: true };
	if (matches.length === 1) return { heading: matches[0], ambiguous: false };
	const leafMatches = document.headings.filter((heading) => heading.title.toLocaleLowerCase() === normalized);
	return {
		heading: leafMatches[0],
		ambiguous: leafMatches.length > 1,
	};
}

export function getLineRange(document: IndexedDocument, startLine: number, endLine: number): string {
	const start = Math.max(1, Math.floor(startLine));
	const end = Math.min(document.lines.length, Math.max(start, Math.floor(endLine)));
	return document.lines.slice(start - 1, end).join("\n");
}

export function getHeadingRange(document: IndexedDocument, heading: MarkdownHeading): string {
	return getLineRange(document, heading.startLine, heading.endLine);
}

export function isLineInCodeBlock(document: IndexedDocument, lineNumber: number): boolean {
	return document.codeBlocks.some((block) => lineNumber >= block.startLine && lineNumber <= block.endLine);
}

export function headingForLine(document: IndexedDocument, lineNumber: number): MarkdownHeading | undefined {
	let result: MarkdownHeading | undefined;
	for (const heading of document.headings) {
		if (heading.startLine <= lineNumber && (!result || heading.startLine > result.startLine)) result = heading;
	}
	return result;
}
