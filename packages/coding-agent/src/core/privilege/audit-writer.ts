import { constants } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PrivilegeAuditEventV1, PrivilegeAuditWriter } from "./types.ts";

const writes = new Map<string, Promise<void>>();

export function redactPrivilegeText(value: string): string {
	return value
		.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted-key]")
		.replace(/(password|passphrase|token|secret|authorization|identityfile)[ \t]*[=:][ \t]*[^\s]+/gi, "$1=[redacted]")
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
}

export class JsonlPrivilegeAuditWriter implements PrivilegeAuditWriter {
	private readonly root: string;

	constructor(agentDir: string) {
		this.root = join(agentDir, "audit", "privileged");
	}

	pathFor(timestamp: Date): string {
		return join(this.root, `${timestamp.toISOString().slice(0, 10)}.jsonl`);
	}

	async append(event: PrivilegeAuditEventV1): Promise<void> {
		const path = this.pathFor(new Date(event.timestamp));
		const safeEvent: PrivilegeAuditEventV1 = {
			...event,
			command: redactPrivilegeText(event.command),
		};
		const previous = writes.get(path) ?? Promise.resolve();
		const next = previous.then(async () => {
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await chmod(dirname(path), 0o700);
			const handle = await open(
				path,
				constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
				0o600,
			);
			try {
				await handle.chmod(0o600);
				await handle.appendFile(`${JSON.stringify(safeEvent)}\n`, { encoding: "utf8" });
			} finally {
				await handle.close();
			}
		});
		writes.set(path, next);
		try {
			await next;
		} finally {
			if (writes.get(path) === next) writes.delete(path);
		}
	}
}
