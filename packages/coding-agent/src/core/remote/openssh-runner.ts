import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionTargetConfig } from "./types.ts";

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function targetKey(target: ExecutionTargetConfig): string {
	return JSON.stringify({ alias: target.sshAlias, user: target.user, port: target.port });
}

export function controlPathFor(target: ExecutionTargetConfig): string {
	const digest = createHash("sha256").update(targetKey(target)).digest("hex").slice(0, 24);
	return join(tmpdir(), "beaupi-ssh", `ctl-${digest}`);
}

export function targetArgs(target: ExecutionTargetConfig, controlPath = controlPathFor(target)): string[] {
	const persist = target.controlPersistSeconds ?? 60;
	const args = [
		"-o",
		"BatchMode=yes",
		"-o",
		`ConnectTimeout=${Math.max(1, Math.ceil((target.connectTimeoutMs ?? 15_000) / 1000))}`,
		"-o",
		"ControlMaster=auto",
		"-o",
		`ControlPersist=${persist}s`,
		"-o",
		`ControlPath=${controlPath}`,
	];
	if (target.user) args.push("-l", target.user);
	if (target.port) args.push("-p", String(target.port));
	args.push(target.sshAlias);
	return args;
}
