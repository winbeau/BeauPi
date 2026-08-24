import { describe, expect, it } from "vitest";
import {
	AgentProtocolError,
	parseAgentMessage,
	targetFingerprint,
	validateExecStartRequest,
	validateHelloRequest,
} from "../src/core/remote-agent/index.ts";

describe("Remote Agent protocol", () => {
	it("validates hello and rejects extra or unsupported fields", () => {
		const hello = validateHelloRequest({
			protocolVersion: 1,
			clientVersion: "test",
			clientSessionId: "session-1",
			clientInstanceId: "client-1",
			targetId: "target-1",
			targetFingerprint: targetFingerprint({ sshAlias: "alias" }),
			capabilities: ["exec-v1"],
		});
		expect(hello.targetId).toBe("target-1");
		expect(() => validateHelloRequest({ ...hello, unexpected: true })).toThrow(AgentProtocolError);
		expect(() => validateHelloRequest({ ...hello, protocolVersion: 2 })).toThrow(/Unsupported protocol/);
	});

	it("preserves arbitrary command text but rejects NUL, empty, and oversized values", () => {
		expect(
			validateExecStartRequest({ operationId: "op-1", command: "printf 'sudo -i 中文'", cwd: "." }).command,
		).toContain("中文");
		expect(() => validateExecStartRequest({ operationId: "op-1", command: "", cwd: "." })).toThrow(
			AgentProtocolError,
		);
		expect(() => validateExecStartRequest({ operationId: "op-1", command: "printf\0x", cwd: "." })).toThrow(
			AgentProtocolError,
		);
	});

	it("correlates typed request, response, and event envelopes", () => {
		const request = parseAgentMessage({
			version: 1,
			type: "request",
			requestId: "req-1",
			method: "exec.cancel",
			payload: { operationId: "op-1" },
		});
		const response = parseAgentMessage({
			version: 1,
			type: "response",
			requestId: "req-1",
			ok: true,
			result: { operationId: "op-1", status: "completed" },
		});
		const event = parseAgentMessage({
			version: 1,
			type: "event",
			event: "exec.output",
			operationId: "op-1",
			sequence: 0,
			payload: {
				operationId: "op-1",
				sequence: 0,
				stream: "stdout",
				dataBase64: Buffer.from("ok\n").toString("base64"),
			},
		});
		expect(request.type).toBe("request");
		expect(response.type).toBe("response");
		expect(event.type).toBe("event");
		expect(() =>
			parseAgentMessage({ version: 1, type: "request", requestId: "req-1", method: "unknown", payload: {} }),
		).toThrow(AgentProtocolError);
	});
});
