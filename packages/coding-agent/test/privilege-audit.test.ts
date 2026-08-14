import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlPrivilegeAuditWriter, type PrivilegeAuditEventV1 } from "../src/core/privilege/index.ts";

const cleanup: string[] = [];
afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function event(index: number): PrivilegeAuditEventV1 {
	return {
		version: 1,
		auditId: "audit",
		sessionId: "session",
		requestId: `request-${index}`,
		toolCallId: `tool-${index}`,
		sourceTool: "privileged_exec",
		route: "explicit_tool",
		timestamp: `2026-01-02T00:00:0${index}.000Z`,
		event: index === 0 ? "requested" : "completed",
		command: `sudo env token=secret-${index} id`,
		target: { execution: "local" },
		cwd: "/workspace",
	};
}

describe("JsonlPrivilegeAuditWriter", () => {
	it("serializes ordered redacted JSONL with private permissions", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "beaupi-privilege-audit-"));
		cleanup.push(agentDir);
		const writer = new JsonlPrivilegeAuditWriter(agentDir);
		await Promise.all([writer.append(event(0)), writer.append(event(1))]);
		const path = writer.pathFor(new Date("2026-01-02T00:00:00.000Z"));
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines.map((line) => JSON.parse(line).event)).toEqual(["requested", "completed"]);
		expect(lines.join("\n")).not.toContain("secret-0");
		expect(lines.join("\n")).not.toContain("secret-1");
		expect(lines.join("\n")).not.toContain('"input"');
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(agentDir, "audit", "privileged")).mode & 0o777).toBe(0o700);
	});

	it.skipIf(process.platform === "win32")("refuses to append through an audit-file symlink", async () => {
		const root = mkdtempSync(join(tmpdir(), "beaupi-privilege-audit-symlink-"));
		cleanup.push(root);
		const agentDir = join(root, "agent");
		const auditDir = join(agentDir, "audit", "privileged");
		mkdirSync(auditDir, { recursive: true, mode: 0o700 });
		const target = join(root, "target.txt");
		writeFileSync(target, "unchanged", { mode: 0o600 });
		const writer = new JsonlPrivilegeAuditWriter(agentDir);
		symlinkSync(target, writer.pathFor(new Date("2026-01-02T00:00:00.000Z")));

		await expect(writer.append(event(0))).rejects.toThrow();
		expect(readFileSync(target, "utf8")).toBe("unchanged");
	});
});
