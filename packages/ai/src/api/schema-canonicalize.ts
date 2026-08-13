/**
 * Adapted from DeepSeek-Reasonix internal/provider/schema_canonicalize.go
 * (MIT, Copyright (c) 2026 Reasonix Contributors).
 * See docs/third-party/reasonix.md for the full notice and modification notes.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function schemaString(value: unknown): string {
	return JSON.stringify(value);
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sortSchemaArray(values: unknown[]): unknown[] {
	return [...values].sort((left, right) => compareStrings(schemaString(left), schemaString(right)));
}

function canonicalizeNamedSchemas(value: unknown): unknown {
	if (!isPlainObject(value)) {
		return canonicalizeValue(value);
	}

	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => compareStrings(left, right))
			.map(([name, schema]) => [name, canonicalizeValue(schema)]),
	);
}

function canonicalizeDependentRequired(value: unknown): unknown {
	if (!isPlainObject(value)) {
		return value;
	}

	const entries = Object.entries(value)
		.map(([name, required]) => [name, Array.isArray(required) ? sortSchemaArray(required) : undefined] as const)
		.filter((entry): entry is readonly [string, unknown[]] => entry[1] !== undefined)
		.sort(([left], [right]) => compareStrings(left, right));

	return Object.fromEntries(entries);
}

function canonicalizeObject(value: Record<string, unknown>): Record<string, unknown> {
	const entries: Array<readonly [string, unknown]> = [];

	for (const [key, inner] of Object.entries(value)) {
		if (key === "dependentRequired") {
			if (isPlainObject(inner)) {
				entries.push([key, canonicalizeDependentRequired(inner)]);
			}
			continue;
		}

		if (key === "required") {
			if (Array.isArray(inner)) {
				entries.push([key, sortSchemaArray(inner.map(canonicalizeValue))]);
			}
			continue;
		}

		if (
			key === "properties" ||
			key === "patternProperties" ||
			key === "$defs" ||
			key === "definitions" ||
			key === "dependentSchemas"
		) {
			entries.push([key, canonicalizeNamedSchemas(inner)]);
			continue;
		}

		entries.push([key, canonicalizeValue(inner)]);
	}

	return Object.fromEntries(entries.sort(([left], [right]) => compareStrings(left, right)));
}

function canonicalizeValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalizeValue);
	}
	if (isPlainObject(value)) {
		return canonicalizeObject(value);
	}
	return value;
}

function ensureRootObjectProperties(value: unknown): unknown {
	if (!isPlainObject(value)) {
		return value;
	}

	const root = { ...value };
	if (!("type" in root)) {
		root.type = "object";
	}
	if (root.type === "object" && !("properties" in root)) {
		root.properties = {};
	}
	return Object.fromEntries(Object.entries(root).sort(([left], [right]) => compareStrings(left, right)));
}

export function canonicalizeToolSchema(raw: unknown): unknown {
	if (raw === undefined || raw === null) {
		return { properties: {}, type: "object" };
	}

	return ensureRootObjectProperties(canonicalizeValue(raw));
}
