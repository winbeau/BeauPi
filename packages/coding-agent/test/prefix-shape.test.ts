import type { Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { capturePrefixShape, comparePrefixShape } from "../src/core/prefix-shape.ts";

function tool(name: string, parameters: Record<string, unknown> = { type: "object" }): Tool {
	return { name, description: `${name} tool`, parameters } as Tool;
}

describe("prefix shape", () => {
	it("capture is deterministic", () => {
		const first = capturePrefixShape("system", [tool("read")]);
		const second = capturePrefixShape("system", [tool("read")]);

		expect(second).toEqual(first);
	});

	it("tool order does not change toolsHash", () => {
		const first = capturePrefixShape("system", [tool("zeta"), tool("alpha")]);
		const second = capturePrefixShape("system", [tool("alpha"), tool("zeta")]);

		expect(second.toolsHash).toBe(first.toolsHash);
		expect(second.prefixHash).toBe(first.prefixHash);
	});

	it("system change reports system", () => {
		const previous = capturePrefixShape("system", [tool("read")]);
		const current = capturePrefixShape("changed", [tool("read")]);

		expect(comparePrefixShape(previous, current)).toEqual(["system"]);
	});

	it("tools change reports tools", () => {
		const previous = capturePrefixShape("system", [tool("read")]);
		const current = capturePrefixShape("system", [tool("write")]);

		expect(comparePrefixShape(previous, current)).toEqual(["tools"]);
	});

	it("first call has no reasons", () => {
		expect(comparePrefixShape(undefined, capturePrefixShape("system", []))).toEqual([]);
	});

	it("tool schema token estimate grows with schema bytes", () => {
		const short = capturePrefixShape("system", [tool("read", { type: "object" })]);
		const long = capturePrefixShape("system", [tool("read", { type: "object", description: "x".repeat(100) })]);

		expect(long.toolSchemaTokens).toBeGreaterThan(short.toolSchemaTokens);
	});
});
