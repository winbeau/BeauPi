import {
	Container,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import {
	formatSkillSource,
	type SkillRegistryDiagnostic,
	type SkillRegistryProjection,
	type SkillRegistryRecord,
	type SkillRegistryScope,
} from "../../../core/skill-registry.ts";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export type SkillRegistryAction = "enable" | "disable" | "validate" | "remove";

export interface SkillRegistrySelectorOptions {
	snapshot: SkillRegistryProjection;
	records?: SkillRegistryRecord[];
	initialSearch?: string;
	onAction: (record: SkillRegistryRecord, action: SkillRegistryAction) => void | Promise<void>;
	onCancel: () => void;
	formatPath?: (path: string) => string;
}

function isSkillRegistryAction(value: string): value is SkillRegistryAction {
	return value === "enable" || value === "disable" || value === "validate" || value === "remove";
}

function uniqueDiagnostics(record: SkillRegistryRecord): SkillRegistryDiagnostic[] {
	const seen = new Set<string>();
	return [...record.entry.diagnostics, ...record.validation.diagnostics].filter((diagnostic) => {
		const key = `${diagnostic.code}\0${diagnostic.message}\0${diagnostic.path ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function hasCollision(record: SkillRegistryRecord, diagnostics: readonly SkillRegistryDiagnostic[]): boolean {
	return diagnostics.some(
		(diagnostic) =>
			diagnostic.code === "name_conflict" &&
			(diagnostic.entryId === record.entry.id || diagnostic.relatedEntryId === record.entry.id),
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

function getDiagnosticSummary(record: SkillRegistryRecord): string {
	const diagnostics = uniqueDiagnostics(record);
	if (diagnostics.length === 0) return "valid";
	const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
	const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
	const counts: string[] = [];
	if (errors > 0) counts.push(`${errors} error${errors === 1 ? "" : "s"}`);
	if (warnings > 0) counts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
	if (counts.length === 0) counts.push(`${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}`);
	return `${diagnostics[0]!.code} · ${counts.join(", ")}`;
}

function formatScope(scope: SkillRegistryScope): string {
	return scope;
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
		const recordDiagnostics = uniqueDiagnostics(record);
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
		actions.push({ value: "remove", label: "Remove", description: "Remove only the Registry reference by default" });

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(`${getStateMarker(state)} ${record.entry.name}`)), 1, 0));
		this.addChild(new Text(theme.fg("muted", `Scope: ${formatScope(record.entry.scope)} · State: ${state}`), 1, 0));
		this.addChild(new Text(theme.fg("muted", `Source: ${formatSkillSource(record.entry.source)}`), 1, 0));
		this.addChild(new Text(theme.fg("muted", `Path: ${formatPath(record.resolvedPath)}`), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Validation diagnostics")), 1, 0));
		if (recordDiagnostics.length === 0) {
			this.addChild(new Text(theme.fg("success", "  ✓ No diagnostics"), 1, 0));
		} else {
			for (const diagnostic of recordDiagnostics) {
				const color =
					diagnostic.severity === "error" ? "error" : diagnostic.severity === "warning" ? "warning" : "muted";
				this.addChild(new Text(theme.fg(color, `  ${diagnostic.severity}: ${diagnostic.message}`), 1, 0));
			}
		}
		this.addChild(new Spacer(1));
		this.selectList = new SelectList(actions, Math.min(actions.length, 6), getSelectListTheme());
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
	private readonly formatPath: (path: string) => string;

	constructor(options: SkillRegistrySelectorOptions) {
		super();
		this.formatPath = options.formatPath ?? ((path) => path);
		const records = options.records ?? options.snapshot.records;
		const items: SettingItem[] = records.map((record) => {
			const state = getState(record, options.snapshot.diagnostics);
			const marker = getStateMarker(state);
			return {
				id: record.entry.id,
				label: `${marker} ${record.entry.name}`,
				currentValue: `${state} · ${formatScope(record.entry.scope)} · ${formatSkillSource(record.entry.source)}`,
				description: `${this.formatPath(record.resolvedPath)} · ${getDiagnosticSummary(record)}`,
				submenu: (_currentValue, done) =>
					new SkillRegistryDetailsComponent(
						record,
						options.snapshot.diagnostics,
						(action) => options.onAction(record, action),
						() => done(),
						this.formatPath,
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
					`${records.length} registered · type to search by name · select for source, scope, diagnostics, and actions`,
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

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

export function formatSkillRegistryRecord(record: SkillRegistryRecord): string {
	const diagnostics = uniqueDiagnostics(record);
	const state = record.validation.valid ? (record.entry.enabled ? "enabled" : "disabled") : "invalid";
	return `${getStateMarker(state)} ${record.entry.name} ${record.entry.scope} ${formatSkillSource(record.entry.source)}${diagnostics.length > 0 ? ` (${getDiagnosticSummary(record)})` : ""}`;
}
