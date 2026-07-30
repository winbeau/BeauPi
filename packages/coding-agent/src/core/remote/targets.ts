import type { SettingsManager } from "../settings-manager.ts";
import {
	EXECUTION_TARGET_VERSION,
	type ExecutionTargetConfig,
	type ExecutionTargetScope,
	RemoteExecutionError,
	type SelectedExecutionTarget,
} from "./types.ts";

const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SSH_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@:%+-]{0,255}$/;
const REMOTE_CWD_PATTERN = /^\/[A-Za-z0-9._~+@%:/-]*$/;

export interface ExecutionTargetRegistryOptions {
	settingsManager?: SettingsManager;
	projectTrusted?: () => boolean;
	sessionTargets?: readonly ExecutionTargetConfig[];
}

export interface ExecutionTargetValidationResult {
	ok: boolean;
	diagnostics: string[];
}

export function validateExecutionTarget(target: ExecutionTargetConfig): ExecutionTargetValidationResult {
	const diagnostics: string[] = [];
	if (!TARGET_ID_PATTERN.test(target.id)) diagnostics.push("Target id must use 1-64 safe characters");
	if (!SSH_ALIAS_PATTERN.test(target.sshAlias)) diagnostics.push("sshAlias must be an OpenSSH alias, not a command");
	if (target.scope !== "user" && target.scope !== "project" && target.scope !== "session") {
		diagnostics.push("Target scope must be user, project, or session");
	}
	if (target.user !== undefined && !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(target.user)) {
		diagnostics.push("Target user is invalid");
	}
	if (target.port !== undefined && (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)) {
		diagnostics.push("Target port must be between 1 and 65535");
	}
	if (target.remoteCwd !== undefined && !REMOTE_CWD_PATTERN.test(target.remoteCwd)) {
		diagnostics.push("remoteCwd must be an absolute POSIX path without shell metacharacters");
	}
	if (
		target.connectTimeoutMs !== undefined &&
		(!Number.isInteger(target.connectTimeoutMs) || target.connectTimeoutMs < 1 || target.connectTimeoutMs > 300_000)
	) {
		diagnostics.push("connectTimeoutMs must be between 1 and 300000");
	}
	if (
		target.controlPersistSeconds !== undefined &&
		(!Number.isInteger(target.controlPersistSeconds) ||
			target.controlPersistSeconds < 0 ||
			target.controlPersistSeconds > 86_400)
	) {
		diagnostics.push("controlPersistSeconds must be between 0 and 86400");
	}
	return { ok: diagnostics.length === 0, diagnostics };
}

function cloneTarget(target: ExecutionTargetConfig): ExecutionTargetConfig {
	return structuredClone({ version: EXECUTION_TARGET_VERSION, ...target });
}

function targetScopeRank(scope: ExecutionTargetScope): number {
	return scope === "session" ? 3 : scope === "project" ? 2 : 1;
}

/**
 * Resolves user/project/session target declarations without storing credentials.
 * Project declarations are read through SettingsManager so the existing project
 * trust gate remains authoritative.
 */
export class ExecutionTargetRegistry {
	private readonly settingsManager?: SettingsManager;
	private readonly projectTrusted: () => boolean;
	private readonly sessionTargets = new Map<string, ExecutionTargetConfig>();
	private selected?: SelectedExecutionTarget;

	constructor(options: ExecutionTargetRegistryOptions = {}) {
		this.settingsManager = options.settingsManager;
		this.projectTrusted = options.projectTrusted ?? (() => options.settingsManager?.isProjectTrusted() ?? true);
		for (const target of options.sessionTargets ?? []) this.addSessionTarget(target);
	}

	addSessionTarget(target: ExecutionTargetConfig): void {
		const normalized = this.validateAndClone({ ...target, scope: "session" });
		this.sessionTargets.set(normalized.id, normalized);
	}

	removeSessionTarget(targetId: string): void {
		this.sessionTargets.delete(targetId);
		if (this.selected?.id === targetId) this.selected = undefined;
	}

	list(): ExecutionTargetConfig[] {
		const merged = new Map<string, ExecutionTargetConfig>();
		for (const target of this.readSettingsTargets(this.settingsManager?.getGlobalSettings().executionTargets ?? [])) {
			if (target.scope === "user") merged.set(target.id, target);
		}
		if (this.projectTrusted()) {
			for (const target of this.readSettingsTargets(
				this.settingsManager?.getProjectSettings().executionTargets ?? [],
			)) {
				if (target.scope === "project") merged.set(target.id, target);
			}
		}
		for (const target of this.sessionTargets.values()) merged.set(target.id, cloneTarget(target));
		return [...merged.values()].sort(
			(left, right) => targetScopeRank(right.scope) - targetScopeRank(left.scope) || left.id.localeCompare(right.id),
		);
	}

	get(targetId: string): ExecutionTargetConfig | undefined {
		return this.list().find((target) => target.id === targetId);
	}

	getSelected(): SelectedExecutionTarget | undefined {
		return this.selected ? structuredClone(this.selected) : undefined;
	}

	select(targetId: string, now = Date.now()): SelectedExecutionTarget {
		const target = this.get(targetId);
		if (!target) {
			throw new RemoteExecutionError({
				code: "target_not_found",
				message: `Execution target ${JSON.stringify(targetId)} is not configured`,
				targetId,
			});
		}
		if (target.scope === "project" && !this.projectTrusted()) {
			throw new RemoteExecutionError({
				code: "target_untrusted",
				message: `Project execution target ${JSON.stringify(targetId)} is not trusted`,
				targetId,
			});
		}
		this.selected = { ...cloneTarget(target), selectedAt: now };
		return structuredClone(this.selected);
	}

	assertSelected(targetId?: string): SelectedExecutionTarget {
		const selected = this.selected;
		if (!selected) {
			throw new RemoteExecutionError({
				code: "target_not_selected",
				message: "Select a trusted execution target before remote operations",
			});
		}
		if (targetId !== undefined && targetId !== selected.id) {
			throw new RemoteExecutionError({
				code: "target_mismatch",
				message: "The requested target is not the selected target",
				targetId,
			});
		}
		if (selected.scope === "project" && !this.projectTrusted()) {
			throw new RemoteExecutionError({
				code: "target_untrusted",
				message: `Project execution target ${JSON.stringify(selected.id)} is no longer trusted`,
				targetId: selected.id,
			});
		}
		return structuredClone(selected);
	}

	setPersistedTarget(target: ExecutionTargetConfig): void {
		const normalized = this.validateAndClone(target);
		if (!this.settingsManager) throw new Error("Execution target persistence requires SettingsManager");
		if (normalized.scope === "session") throw new Error("Session targets cannot be persisted");
		if (normalized.scope === "project") {
			if (!this.projectTrusted())
				throw new RemoteExecutionError({
					code: "target_untrusted",
					message: "Project is not trusted; refusing to write execution target",
					targetId: normalized.id,
				});
			const targets = this.settingsManager.getProjectSettings().executionTargets ?? [];
			this.settingsManager.setProjectExecutionTargets(replaceTarget(targets, normalized));
			return;
		}
		const targets = this.settingsManager.getGlobalSettings().executionTargets ?? [];
		this.settingsManager.setExecutionTargets(replaceTarget(targets, normalized));
	}

	private readSettingsTargets(targets: readonly ExecutionTargetConfig[]): ExecutionTargetConfig[] {
		const result: ExecutionTargetConfig[] = [];
		for (const target of targets) {
			try {
				const normalized = this.validateAndClone(target);
				result.push(normalized);
			} catch {
				// Invalid persisted targets are ignored by the registry and surfaced by
				// the settings diagnostics path rather than becoming executable state.
			}
		}
		return result;
	}

	private validateAndClone(target: ExecutionTargetConfig): ExecutionTargetConfig {
		const normalized = cloneTarget(target);
		const result = validateExecutionTarget(normalized);
		if (!result.ok) {
			throw new RemoteExecutionError({
				code: "target_invalid",
				message: result.diagnostics.join("; "),
				targetId: target.id,
			});
		}
		return normalized;
	}
}

function replaceTarget(
	targets: readonly ExecutionTargetConfig[],
	replacement: ExecutionTargetConfig,
): ExecutionTargetConfig[] {
	const next = targets.filter((target) => target.id !== replacement.id);
	next.push(replacement);
	return next.map((target) => structuredClone(target));
}
