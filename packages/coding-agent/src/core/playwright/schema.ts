import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

const strict = { additionalProperties: false } as const;
const pageId = Type.Optional(
	Type.String({
		minLength: 1,
		maxLength: 64,
		pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
		description: "Session-local page id. Omit to use the active page.",
	}),
);
const timeoutMs = Type.Optional(Type.Integer({ minimum: 100, maximum: 120_000 }));
const viewport = Type.Object(
	{
		width: Type.Integer({ minimum: 320, maximum: 3840 }),
		height: Type.Integer({ minimum: 240, maximum: 2160 }),
		deviceScaleFactor: Type.Optional(Type.Number({ minimum: 1, maximum: 3 })),
	},
	strict,
);
const nth = Type.Optional(Type.Integer({ minimum: 0, maximum: 999 }));
const exact = Type.Optional(Type.Boolean());

export const PLAYWRIGHT_TARGET_SCHEMA = Type.Union([
	Type.Object(
		{
			by: Type.Literal("role"),
			role: Type.String({ minLength: 1, maxLength: 64 }),
			name: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
			exact,
			nth,
		},
		strict,
	),
	Type.Object(
		{
			by: Type.Union([
				Type.Literal("text"),
				Type.Literal("label"),
				Type.Literal("placeholder"),
				Type.Literal("testId"),
			]),
			value: Type.String({ minLength: 1, maxLength: 2_000 }),
			exact,
			nth,
		},
		strict,
	),
	Type.Object(
		{
			by: Type.Literal("css"),
			value: Type.String({ minLength: 1, maxLength: 2_000 }),
			nth,
		},
		strict,
	),
]);

const actionBase = {
	pageId,
	timeoutMs,
};

const screenshotSchemas = [
	Type.Object(
		{
			action: Type.Literal("screenshot"),
			target: PLAYWRIGHT_TARGET_SCHEMA,
			viewport: Type.Optional(viewport),
			savePath: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
			...actionBase,
		},
		strict,
	),
	Type.Object(
		{
			action: Type.Literal("screenshot"),
			fullPage: Type.Optional(Type.Boolean()),
			viewport: Type.Optional(viewport),
			savePath: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
			...actionBase,
		},
		strict,
	),
] as const;

const actSchemas = [
	Type.Object(
		{
			action: Type.Literal("act"),
			kind: Type.Literal("click"),
			target: PLAYWRIGHT_TARGET_SCHEMA,
			button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
			modifiers: Type.Optional(
				Type.Array(
					Type.Union([
						Type.Literal("Alt"),
						Type.Literal("Control"),
						Type.Literal("ControlOrMeta"),
						Type.Literal("Meta"),
						Type.Literal("Shift"),
					]),
					{ maxItems: 5, uniqueItems: true },
				),
			),
			...actionBase,
		},
		strict,
	),
	Type.Object(
		{
			action: Type.Literal("act"),
			kind: Type.Union([Type.Literal("fill"), Type.Literal("type")]),
			target: PLAYWRIGHT_TARGET_SCHEMA,
			value: Type.String({ maxLength: 16_384 }),
			...actionBase,
		},
		strict,
	),
	Type.Object(
		{
			action: Type.Literal("act"),
			kind: Type.Literal("press"),
			target: PLAYWRIGHT_TARGET_SCHEMA,
			key: Type.String({ minLength: 1, maxLength: 128 }),
			...actionBase,
		},
		strict,
	),
	Type.Object(
		{
			action: Type.Literal("act"),
			kind: Type.Literal("select"),
			target: PLAYWRIGHT_TARGET_SCHEMA,
			values: Type.Array(Type.String({ maxLength: 2_000 }), { minItems: 1, maxItems: 20 }),
			...actionBase,
		},
		strict,
	),
	Type.Object(
		{
			action: Type.Literal("act"),
			kind: Type.Union([Type.Literal("check"), Type.Literal("uncheck"), Type.Literal("hover")]),
			target: PLAYWRIGHT_TARGET_SCHEMA,
			...actionBase,
		},
		strict,
	),
	Type.Object(
		{
			action: Type.Literal("act"),
			kind: Type.Literal("waitFor"),
			target: PLAYWRIGHT_TARGET_SCHEMA,
			state: Type.Union([
				Type.Literal("attached"),
				Type.Literal("detached"),
				Type.Literal("visible"),
				Type.Literal("hidden"),
			]),
			...actionBase,
		},
		strict,
	),
] as const;

const PLAYWRIGHT_ACTION_SCHEMA = Type.Union([
	Type.Object(
		{
			action: Type.Literal("navigate"),
			url: Type.String({ minLength: 1, maxLength: 8_192 }),
			waitUntil: Type.Optional(
				Type.Union([Type.Literal("commit"), Type.Literal("domcontentloaded"), Type.Literal("load")]),
			),
			viewport: Type.Optional(viewport),
			...actionBase,
		},
		strict,
	),
	Type.Object(
		{
			action: Type.Literal("snapshot"),
			target: Type.Optional(PLAYWRIGHT_TARGET_SCHEMA),
			depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
			boxes: Type.Optional(Type.Boolean()),
			maxCharacters: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 50 * 1024 })),
			...actionBase,
		},
		strict,
	),
	...actSchemas,
	...screenshotSchemas,
	Type.Object(
		{
			action: Type.Literal("evaluate"),
			expression: Type.String({ minLength: 1, maxLength: 16_384 }),
			argument: Type.Optional(Type.Unknown()),
			maxCharacters: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 50 * 1024 })),
			...actionBase,
		},
		strict,
	),
	Type.Object(
		{
			action: Type.Literal("events"),
			pageId,
			cursor: Type.Optional(Type.Integer({ minimum: 0 })),
			levels: Type.Optional(
				Type.Array(
					Type.Union([
						Type.Literal("debug"),
						Type.Literal("info"),
						Type.Literal("log"),
						Type.Literal("warning"),
						Type.Literal("error"),
					]),
					{ minItems: 1, maxItems: 5, uniqueItems: true },
				),
			),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		},
		strict,
	),
	Type.Object({ action: Type.Literal("pages"), operation: Type.Literal("list") }, strict),
	Type.Object(
		{ action: Type.Literal("pages"), operation: Type.Literal("new"), viewport: Type.Optional(viewport) },
		strict,
	),
	Type.Object({ action: Type.Literal("pages"), operation: Type.Literal("close"), pageId }, strict),
	Type.Object({ action: Type.Literal("pages"), operation: Type.Literal("reset") }, strict),
]);

export type PlaywrightSchemaInput = Static<typeof PLAYWRIGHT_ACTION_SCHEMA>;

// OpenAI-compatible providers require function parameter schemas to declare an
// object at the root. Type.Union emits only `anyOf`, so retain the strict union
// constraints while adding the provider-facing root type explicitly.
export const PLAYWRIGHT_PARAMETERS = Type.Unsafe<PlaywrightSchemaInput>({
	...PLAYWRIGHT_ACTION_SCHEMA,
	type: "object",
});

export const PLAYWRIGHT_INPUT_VALIDATOR = Compile(PLAYWRIGHT_PARAMETERS);

export function formatPlaywrightValidationErrors(value: unknown): string {
	return [...PLAYWRIGHT_INPUT_VALIDATOR.Errors(value)]
		.slice(0, 5)
		.map((error) => `${error.instancePath || "/"}: ${error.message}`)
		.join("; ");
}
