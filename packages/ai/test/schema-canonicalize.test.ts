import { describe, expect, it } from "vitest";
import { canonicalizeToolSchema } from "../src/api/schema-canonicalize.ts";

describe("canonicalizeToolSchema", () => {
	it("turns empty schemas into an object with empty properties", () => {
		const expected = { properties: {}, type: "object" };

		expect(canonicalizeToolSchema({})).toEqual(expected);
		expect(canonicalizeToolSchema(undefined)).toEqual(expected);
		expect(canonicalizeToolSchema(null)).toEqual(expected);
	});

	it("adds object type when the root type is missing", () => {
		expect(canonicalizeToolSchema({ properties: { a: { type: "string" } } })).toEqual({
			properties: { a: { type: "string" } },
			type: "object",
		});
	});

	it("sorts required arrays and removes invalid required values", () => {
		expect(
			canonicalizeToolSchema({
				type: "object",
				required: ["b", "a"],
				properties: { a: { type: "string" }, b: { type: "string" } },
			}),
		).toEqual({
			properties: { a: { type: "string" }, b: { type: "string" } },
			required: ["a", "b"],
			type: "object",
		});

		expect(canonicalizeToolSchema({ type: "object", required: true })).toEqual({
			properties: {},
			type: "object",
		});
	});

	it("sorts dependentRequired arrays and removes invalid entries", () => {
		expect(
			canonicalizeToolSchema({
				type: "object",
				dependentRequired: {
					cc: ["billing_address", "name"],
					bad: true,
				},
			}),
		).toEqual({
			dependentRequired: { cc: ["billing_address", "name"] },
			properties: {},
			type: "object",
		});
	});

	it('does not confuse a property named "required" with schema metadata', () => {
		expect(
			canonicalizeToolSchema({
				type: "object",
				properties: { required: { type: "string" } },
			}),
		).toEqual({
			properties: { required: { type: "string" } },
			type: "object",
		});
	});

	it("canonicalizes nested schema maps", () => {
		expect(
			canonicalizeToolSchema({
				dependentSchemas: { z: { required: ["b", "a"] } },
				patternProperties: { "^z": { properties: { z: { type: "number" }, a: { type: "string" } } } },
				definitions: { b: { type: "boolean" }, a: { type: "string" } },
				$defs: { item: { required: ["z", "a"] } },
				type: "object",
			}),
		).toEqual({
			$defs: { item: { required: ["a", "z"] } },
			definitions: { a: { type: "string" }, b: { type: "boolean" } },
			dependentSchemas: { z: { required: ["a", "b"] } },
			patternProperties: {
				"^z": {
					properties: { a: { type: "string" }, z: { type: "number" } },
				},
			},
			properties: {},
			type: "object",
		});
	});

	it("recurses legacy tuple items arrays", () => {
		expect(
			canonicalizeToolSchema({
				type: "object",
				properties: {
					pair: {
						type: "array",
						items: [{ properties: { b: { type: "string" }, a: { type: "number" } } }, { type: "boolean" }],
					},
				},
			}),
		).toEqual({
			properties: {
				pair: {
					items: [{ properties: { a: { type: "number" }, b: { type: "string" } } }, { type: "boolean" }],
					type: "array",
				},
			},
			type: "object",
		});
	});

	it("preserves explicit non-object root types", () => {
		expect(canonicalizeToolSchema({ type: "string" })).toEqual({ type: "string" });
	});

	it("passes boolean schemas through", () => {
		expect(canonicalizeToolSchema(true)).toBe(true);
		expect(canonicalizeToolSchema(false)).toBe(false);
	});

	it("is idempotent", () => {
		const schema = {
			type: "object",
			required: ["b", "a"],
			properties: { b: { type: "number" }, a: { type: "string" } },
		};
		const first = canonicalizeToolSchema(schema);
		expect(canonicalizeToolSchema(first)).toEqual(first);
	});

	it("is invariant to input key order", () => {
		const first = canonicalizeToolSchema({
			type: "object",
			required: ["b", "a"],
			properties: { b: { description: "bee", type: "string" }, a: { type: "integer" } },
		});
		const second = canonicalizeToolSchema({
			properties: { a: { type: "integer" }, b: { type: "string", description: "bee" } },
			required: ["a", "b"],
			type: "object",
		});
		expect(second).toEqual(first);
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	});

	it("passes primitives through", () => {
		expect(canonicalizeToolSchema("schema")).toBe("schema");
		expect(canonicalizeToolSchema(42)).toBe(42);
	});
});
