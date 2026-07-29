import {
	Container,
	getKeybindings,
	Markdown,
	type MarkdownTheme,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	formatSkillSource,
	formatSkillSourceDetails,
	type SkillRegistryDiagnostic,
	type SkillRegistryProjection,
	type SkillRegistryRecord,
	type SkillRegistryScope,
} from "../../../core/skill-registry.ts";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export type SkillRegistryAction = "enable" | "disable" | "validate" | "open" | "update" | "remove";

export interface SkillRegistrySelectorOptions {
	snapshot: SkillRegistryProjection;
	records?: SkillRegistryRecord[];
	initialSearch?: string;
	onAction: (record: SkillRegistryRecord, action: SkillRegistryAction) => void | Promise<void>;
	onCancel: () => void;
	formatPath?: (path: string) => string;
}

function isSkillRegistryAction(value: string): value is SkillRegistryAction {
	return (
		value === "enable" ||
		value === "disable" ||
		value === "validate" ||
		value === "open" ||
		value === "update" ||
		value === "remove"
	);
}

function diagnosticBelongsToRecord(record: SkillRegistryRecord, diagnostic: SkillRegistryDiagnostic): boolean {
	const paths = new Set([record.resolvedPath, record.validation.skillFilePath, record.managedPath].filter(Boolean));
	return (
		diagnostic.entryId === record.entry.id ||
		diagnostic.relatedEntryId === record.entry.id ||
		(diagnostic.path !== undefined && paths.has(diagnostic.path)) ||
		(diagnostic.relatedPath !== undefined && paths.has(diagnostic.relatedPath))
	);
}

function uniqueDiagnostics(
	record: SkillRegistryRecord,
	diagnostics: readonly SkillRegistryDiagnostic[] = [],
): SkillRegistryDiagnostic[] {
	const seen = new Set<string>();
	return [
		...record.entry.diagnostics,
		...record.validation.diagnostics,
		...diagnostics.filter((item) => diagnosticBelongsToRecord(record, item)),
	].filter((diagnostic) => {
		const key = `${diagnostic.code}\0${diagnostic.message}\0${diagnostic.path ?? ""}\0${diagnostic.relatedPath ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function hasCollision(record: SkillRegistryRecord, diagnostics: readonly SkillRegistryDiagnostic[]): boolean {
	return diagnostics.some(
		(diagnostic) =>
			diagnostic.code === "name_conflict" &&
			(diagnostic.entryId === record.entry.id ||
				diagnostic.relatedEntryId === record.entry.id ||
				diagnostic.path === record.resolvedPath ||
				diagnostic.relatedPath === record.resolvedPath),
	);
}

function getState(record: SkillRegistryRecord, diagnostics: readonly SkillRegistryDiagnostic[]): string {
	if (hasCollision(record, diagnostics)) return "collision";
	if (!record.validation.valid) return "invalid";
	return record.entry.enabled ? "enabled" : "disabled";
}

function getStateMarker(state: string): string {
	switch (state) {
		case "enabled":
			return "✓";
		case "disabled":
			return "○";
		default:
			return "!";
	}
}

function getDiagnosticSummary(record: SkillRegistryRecord, diagnostics: readonly SkillRegistryDiagnostic[]): string {
	const recordDiagnostics = uniqueDiagnostics(record, diagnostics);
	if (recordDiagnostics.length === 0) return "valid";
	const errors = recordDiagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
	const warnings = recordDiagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
	const counts: string[] = [];
	if (errors > 0) counts.push(`${errors} error${errors === 1 ? "" : "s"}`);
	if (warnings > 0) counts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
	if (counts.length === 0)
		counts.push(`${recordDiagnostics.length} diagnostic${recordDiagnostics.length === 1 ? "" : "s"}`);
	return `${recordDiagnostics[0]!.code} · ${counts.join(", ")}`;
}

function formatScope(scope: SkillRegistryScope): string {
	return scope;
}

function formatTimestamp(timestamp: number | undefined, emptyValue: string): string {
	if (timestamp === undefined) return emptyValue;
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? emptyValue : date.toISOString();
}

function formatPinStatus(record: SkillRegistryRecord): string {
	const pins = [
		record.entry.pinnedRef ? `ref ${record.entry.pinnedRef}` : undefined,
		record.entry.sha256 ? `sha256 ${record.entry.sha256}` : undefined,
		record.entry.source.type === "url" && record.entry.source.sha256
			? `source sha256 ${record.entry.source.sha256}`
			: undefined,
	].filter((value): value is string => value !== undefined);
	return pins.length > 0 ? pins.join(" · ") : "no";
}

function formatSourceDetailLine(line: string, formatPath: (path: string) => string): string {
	if (line.startsWith("path: ")) {
		return `path: ${formatPath(line.slice("path: ".length))}`;
	}
	return line;
}

function formatCollisionSides(
	record: SkillRegistryRecord,
	diagnostics: readonly SkillRegistryDiagnostic[],
	formatPath: (path: string) => string,
): string[] {
	const lines: string[] = [];
	for (const diagnostic of uniqueDiagnostics(record, diagnostics)) {
		if (diagnostic.code !== "name_conflict" || !diagnostic.relatedPath || !diagnostic.relatedSource) continue;
		const currentSource = diagnostic.source
			? formatSkillSource(diagnostic.source)
			: formatSkillSource(record.entry.source);
		lines.push(
			`  collision sides: ${currentSource} ${formatPath(diagnostic.path ?? record.resolvedPath)} ↔ ${formatSkillSource(diagnostic.relatedSource)} ${formatPath(diagnostic.relatedPath)}`,
		);
	}
	return lines;
}

class SkillRegistryDetailsComponent extends Container {
	private readonly selectList: SelectList;

	constructor(
		record: SkillRegistryRecord,
		diagnostics: readonly SkillRegistryDiagnostic[],
		onAction: (action: SkillRegistryAction) => void | Promise<void>,
		onCancel: () => void,
		formatPath: (path: string) => string,
	) {
		super();
		const recordDiagnostics = uniqueDiagnostics(record, diagnostics);
		const state = getState(record, diagnostics);
		const actions: SelectItem[] = [];
		if (record.entry.enabled) {
			actions.push({
				value: "disable",
				label: "Disable",
				description: "Keep the files but remove the skill from discovery",
			});
		} else {
			actions.push({ value: "enable", label: "Enable", description: "Make the skill available after reload" });
		}
		actions.push({
			value: "validate",
			label: "Validate",
			description: "Refresh persisted frontmatter and collision diagnostics",
		});
		if (
			record.entry.source.type === "git" ||
			record.entry.source.type === "npm" ||
			record.entry.source.type === "url"
		) {
			actions.push({
				value: "update",
				label: "Update",
				description: "Fetch, review, confirm, and atomically replace this remote Skill",
			});
		} else {
			actions.push({
				value: "update-unavailable",
				label: "Update (disabled)",
				description: `Disabled: ${record.entry.source.type} and external harness Skills do not have a remote update flow`,
			});
		}
		actions.push({
			value: "open",
			label: "Open SKILL.md",
			description: "View the current file without changing Registry state",
		});
		actions.push({ value: "remove", label: "Remove", description: "Remove only the Registry reference by default" });

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(`${getStateMarker(state)} ${record.entry.name}`)), 1, 0));
		this.addChild(new Text(theme.fg("muted", `Scope: ${formatScope(record.entry.scope)} · State: ${state}`), 1, 0));
		this.addChild(new Text(theme.fg("muted", `Registry: ${formatPath(record.registryPath)}`), 1, 0));
		this.addChild(new Text(theme.fg("muted", `Skill path: ${formatPath(record.resolvedPath)}`), 1, 0));
		this.addChild(
			new Text(
				theme.fg("muted", `Managed path: ${record.managedPath ? formatPath(record.managedPath) : "not managed"}`),
				1,
				0,
			),
		);
		this.addChild(
			new Text(theme.fg("muted", `Imported: ${formatTimestamp(record.entry.importedAt, "unknown")}`), 1, 0),
		);
		this.addChild(
			new Text(theme.fg("muted", `Updated: ${formatTimestamp(record.entry.updatedAt, "not updated")}`), 1, 0),
		);
		this.addChild(new Text(theme.fg("muted", `Pinned: ${formatPinStatus(record)}`), 1, 0));
		this.addChild(new Text(theme.fg("muted", `Source: ${formatSkillSource(record.entry.source)}`), 1, 0));
		for (const detail of formatSkillSourceDetails(record.entry.source)) {
			this.addChild(new Text(theme.fg("dim", `  ${formatSourceDetailLine(detail, formatPath)}`), 1, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Diagnostics")), 1, 0));
		if (recordDiagnostics.length === 0) {
			this.addChild(new Text(theme.fg("success", "  ✓ No diagnostics"), 1, 0));
		} else {
			for (const diagnostic of recordDiagnostics) {
				const color =
					diagnostic.severity === "error" ? "error" : diagnostic.severity === "warning" ? "warning" : "muted";
				const location = diagnostic.path ? ` [${formatPath(diagnostic.path)}]` : "";
				this.addChild(
					new Text(
						theme.fg(color, `  ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}${location}`),
						1,
						0,
					),
				);
			}
			for (const collisionSide of formatCollisionSides(record, diagnostics, formatPath)) {
				this.addChild(new Text(theme.fg("warning", collisionSide), 1, 0));
			}
		}
		this.addChild(new Spacer(1));
		this.selectList = new SelectList(actions, Math.min(actions.length, 7), getSelectListTheme());
		this.selectList.onSelect = (item) => {
			if (isSkillRegistryAction(item.value)) void onAction(item.value);
		};
		this.selectList.onCancel = onCancel;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to act · Esc to go back"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

export class SkillRegistrySelectorComponent extends Container {
	private readonly settingsList: SettingsList;

	constructor(options: SkillRegistrySelectorOptions) {
		super();
		const formatPath = options.formatPath ?? ((path: string) => path);
		const records = options.records ?? options.snapshot.records;
		const items: SettingItem[] = records.map((record) => {
			const state = getState(record, options.snapshot.diagnostics);
			const marker = getStateMarker(state);
			const source = formatSkillSource(record.entry.source);
			const diagnosticSummary = getDiagnosticSummary(record, options.snapshot.diagnostics);
			const searchText = [
				record.entry.name,
				record.entry.scope,
				record.entry.source.type,
				source,
				record.entry.path,
				record.resolvedPath,
				record.managedPath ?? "",
				record.entry.pinnedRef ?? "",
				record.entry.sha256 ?? "",
				...uniqueDiagnostics(record, options.snapshot.diagnostics).flatMap((diagnostic) => [
					diagnostic.code,
					diagnostic.message,
					diagnostic.path ?? "",
				]),
			].join(" ");
			return {
				id: record.entry.id,
				label: `${marker} ${record.entry.name}`,
				currentValue: `${state} · ${formatScope(record.entry.scope)} · ${record.entry.source.type}`,
				description: `Source: ${source} · Managed: ${record.managedPath ? formatPath(record.managedPath) : "not managed"} · Updated: ${formatTimestamp(record.entry.updatedAt, "not updated")} · Pinned: ${formatPinStatus(record)} · ${formatPath(record.resolvedPath)} · ${diagnosticSummary}`,
				searchText,
				submenu: (_currentValue, done) =>
					new SkillRegistryDetailsComponent(
						record,
						options.snapshot.diagnostics,
						(action) => options.onAction(record, action),
						() => done(),
						formatPath,
					),
			};
		});

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Skills")), 1, 0));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					`${records.length} registered · search name, source, scope, path, pins, or diagnostics · select for full details and actions`,
				),
				1,
				0,
			),
		);
		if (options.snapshot.diagnostics.length > 0) {
			this.addChild(
				new Text(
					theme.fg(
						"warning",
						`${options.snapshot.diagnostics.length} Registry/discovery diagnostic${options.snapshot.diagnostics.length === 1 ? "" : "s"}`,
					),
					1,
					0,
				),
			);
			for (const diagnostic of options.snapshot.diagnostics.filter((item) => !item.entryId).slice(0, 3)) {
				this.addChild(
					new Text(
						theme.fg(
							diagnostic.severity === "error" ? "error" : "warning",
							`${diagnostic.code}: ${diagnostic.message}`,
						),
						1,
						0,
					),
				);
			}
		}
		this.addChild(new Spacer(1));
		this.settingsList = new SettingsList(items, 10, getSettingsListTheme(), () => undefined, options.onCancel, {
			enableSearch: true,
		});
		for (const character of options.initialSearch ?? "") {
			this.settingsList.handleInput(character);
		}
		this.addChild(this.settingsList);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	getSearchQuery(): string {
		return this.settingsList.getSearchQuery();
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

export interface SkillRegistryFileViewerOptions {
	tui: TUI;
	path: string;
	content: string;
	markdownTheme: MarkdownTheme;
	onCancel: () => void;
}

export class SkillRegistryFileViewerComponent extends Container {
	private readonly tui: TUI;
	private readonly path: string;
	private readonly markdown: Markdown;
	private readonly onCancel: () => void;
	private scrollOffset = 0;

	constructor(options: SkillRegistryFileViewerOptions) {
		super();
		this.tui = options.tui;
		this.path = options.path;
		this.markdown = new Markdown(options.content, 1, 0, options.markdownTheme);
		this.onCancel = options.onCancel;
	}

	private getViewportHeight(): number {
		return Math.max(1, this.tui.terminal.rows - 8);
	}

	private getContentLines(width: number): string[] {
		return this.markdown.render(Math.max(1, width));
	}

	private clampScroll(width: number): void {
		const maxOffset = Math.max(0, this.getContentLines(width).length - this.getViewportHeight());
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
	}

	render(width: number): string[] {
		const contentLines = this.getContentLines(width);
		this.clampScroll(width);
		const viewportHeight = this.getViewportHeight();
		const visibleLines = contentLines.slice(this.scrollOffset, this.scrollOffset + viewportHeight);
		while (visibleLines.length < viewportHeight) visibleLines.push("");
		const end = Math.min(contentLines.length, this.scrollOffset + viewportHeight);
		const position = contentLines.length === 0 ? "empty" : `${this.scrollOffset + 1}-${end}/${contentLines.length}`;
		const lines = [
			"─".repeat(Math.max(1, width)),
			"",
			theme.fg("accent", theme.bold("SKILL.md")),
			theme.fg("muted", this.path),
			"",
			...visibleLines,
			"",
			theme.fg("dim", `${position} · ↑↓ scroll · page up/down · Esc close`),
			"─".repeat(Math.max(1, width)),
		];
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const pageSize = this.getViewportHeight();
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.scrollOffset -= 1;
		} else if (kb.matches(data, "tui.select.down")) {
			this.scrollOffset += 1;
		} else if (kb.matches(data, "tui.select.pageUp")) {
			this.scrollOffset -= pageSize;
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.scrollOffset += pageSize;
		} else {
			return;
		}
		this.clampScroll(this.tui.terminal.columns);
	}

	override invalidate(): void {
		this.markdown.invalidate();
	}
}

export function formatSkillRegistryRecord(record: SkillRegistryRecord): string {
	const diagnostics = uniqueDiagnostics(record);
	const state = record.validation.valid ? (record.entry.enabled ? "enabled" : "disabled") : "invalid";
	return `${getStateMarker(state)} ${record.entry.name} ${record.entry.scope} ${formatSkillSource(record.entry.source)}${diagnostics.length > 0 ? ` (${getDiagnosticSummary(record, diagnostics)})` : ""}`;
}
