import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolRenderResultOptions } from "../extensions/types.ts";
import { getTextOutput } from "../tools/render-utils.ts";
import { getPlaywrightRuntimeToolDetails } from "./details.ts";
import { formatPlaywrightTarget } from "./locator.ts";
import type { PlaywrightInput, PlaywrightToolDetails } from "./types.ts";

function pageId(args: PlaywrightInput): string {
	return "pageId" in args && args.pageId ? args.pageId : "active";
}

function actionSummary(args: PlaywrightInput): string {
	switch (args.action) {
		case "navigate":
			return `navigate ${args.url}`;
		case "snapshot":
			return args.target ? `snapshot ${formatPlaywrightTarget(args.target)}` : "snapshot";
		case "act":
			return `${args.kind} ${formatPlaywrightTarget(args.target)}`;
		case "screenshot":
			return args.target
				? `screenshot ${formatPlaywrightTarget(args.target)}`
				: args.fullPage
					? "screenshot full page"
					: "screenshot";
		case "evaluate":
			return `evaluate ${args.expression.slice(0, 80)}`;
		case "events":
			return `events${args.cursor === undefined ? "" : ` after ${args.cursor}`}`;
		case "pages":
			return `pages ${args.operation}`;
	}
}

export function renderPlaywrightCall(args: PlaywrightInput, theme: Theme, previous?: Text): Text {
	const text = previous ?? new Text("", 0, 0);
	text.setText(
		`${theme.fg("toolTitle", theme.bold("Playwright"))}${theme.fg("muted", `[${pageId(args)}]`)}(${theme.fg("accent", actionSummary(args))})`,
	);
	return text;
}

export function renderPlaywrightResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: PlaywrightToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	isError: boolean,
	previous?: Text,
): Text {
	const text = previous ?? new Text("", 0, 0);
	const details = getPlaywrightRuntimeToolDetails(result.details);
	if (isError || details?.ok === false) {
		text.setText(theme.fg("error", details?.diagnostic?.message ?? getTextOutput(result, showImages)));
		return text;
	}
	if (!details) {
		text.setText(theme.fg("toolOutput", getTextOutput(result, showImages)));
		return text;
	}
	if (options.expanded) {
		text.setText(theme.fg("toolOutput", getTextOutput(result, showImages)));
		return text;
	}
	let summary: string;
	switch (details.operation) {
		case "navigate":
			summary = `${details.title || "Untitled"}${details.navigation?.status === undefined ? "" : ` · ${details.navigation.status}`} · ${details.url ?? ""}`;
			break;
		case "snapshot":
			summary = `${details.snapshot?.outputCharacters ?? 0} characters${details.snapshot?.truncated ? " · truncated" : ""}`;
			break;
		case "act":
			summary = `${details.title || details.pageId || "Action completed"} · ${details.url ?? "URL unchanged"}`;
			break;
		case "screenshot":
			summary = details.screenshot
				? `Screenshot ${details.screenshot.width}×${details.screenshot.height} · ${details.pageId ?? "page"}${details.screenshot.savedPath ? " · saved" : ""}`
				: "Screenshot captured";
			break;
		case "evaluate":
			summary = `${details.evaluation?.outputCharacters ?? 0} characters${details.evaluation?.truncated ? " · truncated" : ""}`;
			break;
		case "events":
			summary = `${details.events?.count ?? 0} new events · cursor ${details.events?.nextCursor ?? details.eventCursor ?? 0}`;
			break;
		case "pages":
			summary = `${details.pages?.length ?? 0} browser pages · active ${details.pageId ?? "none"}`;
			break;
	}
	text.setText(theme.fg("muted", summary));
	return text;
}
