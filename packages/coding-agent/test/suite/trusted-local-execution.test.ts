import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "../../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "./harness.ts";

const created: Harness[] = [];

async function createTrustedLocalHarness(): Promise<Harness> {
	const harness = await createHarness();
	created.push(harness);
	return harness;
}

afterEach(() => {
	for (const harness of created.splice(0)) harness.cleanup();
});

describe("trusted-local execution semantics", () => {
	it("executes an ordinary Bash call exactly once without any authorization wrapper", async () => {
		const harness = await createTrustedLocalHarness();
		const exec = vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 0 }));
		const result = await harness.session.executeBash("echo hello", undefined, { operations: { exec } });
		expect(exec).toHaveBeenCalledTimes(1);
		expect(result.exitCode).toBe(0);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "custom")).toBe(false);
	});

	it("does not block read access to sensitive paths or arbitrary commands", async () => {
		const harness = await createTrustedLocalHarness();
		const exec = vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 0 }));
		const result = await harness.session.executeBash("cat /root/.ssh/id_ed25519", undefined, {
			operations: { exec },
		});
		expect(exec).toHaveBeenCalledTimes(1);
		expect(result.exitCode).toBe(0);
	});

	it("exposes no policyConfirm method on the RPC extension UI contract", () => {
		type NoPolicyConfirmRequest = Extract<RpcExtensionUIRequest, { method: "policyConfirm" }>;
		type NoPolicyConfirmResponse = Extract<RpcExtensionUIResponse, { policyDecision: string }>;
		const noRequest: NoPolicyConfirmRequest extends never ? true : false = true;
		const noResponse: NoPolicyConfirmResponse extends never ? true : false = true;
		expect(noRequest).toBe(true);
		expect(noResponse).toBe(true);
	});

	it("records no beaupi.policy.fact custom entry for tool results", async () => {
		const harness = await createTrustedLocalHarness();
		harness.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }, { id: "bash-1" }), {
					stopReason: "toolUse",
				}),
			() => fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run a bash command");
		const entries = harness.sessionManager.getEntries();
		expect(entries.some((entry) => entry.type === "custom" && entry.customType === "beaupi.policy.fact")).toBe(false);
	});
});
