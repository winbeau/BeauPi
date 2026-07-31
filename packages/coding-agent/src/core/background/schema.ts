import { Type } from "typebox";

const strict = { additionalProperties: false } as const;

export const BACKGROUND_TRIGGER_INPUT_SCHEMA = Type.Union([
	Type.Object({ type: Type.Literal("completed") }, strict),
	Type.Object({ type: Type.Literal("failed") }, strict),
	Type.Object({ type: Type.Literal("timeout") }, strict),
	Type.Object({ type: Type.Literal("stalled") }, strict),
	Type.Object(
		{
			type: Type.Literal("error-pattern"),
			pattern: Type.String({ minLength: 1, maxLength: 256 }),
			flags: Type.Optional(Type.String({ pattern: "^[im]*$", maxLength: 2 })),
		},
		strict,
	),
	Type.Object({ type: Type.Literal("progress-review") }, strict),
]);

export const BACKGROUND_PROGRESS_REVIEW_INPUT_SCHEMA = Type.Object(
	{
		enabled: Type.Boolean(),
		minimumIntervalMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400_000 })),
		maxReviews: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		maxInputCharacters: Type.Optional(Type.Integer({ minimum: 256, maximum: 100_000 })),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000 })),
		maxOutputTokens: Type.Optional(Type.Integer({ minimum: 64, maximum: 8_192 })),
	},
	strict,
);

export const BACKGROUND_START_SCHEMA = Type.Object(
	{
		executable: Type.String({ minLength: 1, maxLength: 4_096 }),
		args: Type.Optional(Type.Array(Type.String({ maxLength: 32_768 }), { maxItems: 256 })),
		cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
		name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
		goal: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
		stallTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
		triggers: Type.Optional(Type.Array(BACKGROUND_TRIGGER_INPUT_SCHEMA, { maxItems: 16 })),
		progressReview: Type.Optional(BACKGROUND_PROGRESS_REVIEW_INPUT_SCHEMA),
	},
	strict,
);

export const BACKGROUND_ATTACH_SCHEMA = Type.Object(
	{
		monitorId: Type.String({ minLength: 1, maxLength: 256 }),
		name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
		goal: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
		triggers: Type.Optional(Type.Array(BACKGROUND_TRIGGER_INPUT_SCHEMA, { maxItems: 16 })),
		progressReview: Type.Optional(BACKGROUND_PROGRESS_REVIEW_INPUT_SCHEMA),
	},
	strict,
);

export const BACKGROUND_STATUS_SCHEMA = Type.Object(
	{
		taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		includeTerminal: Type.Optional(Type.Boolean()),
	},
	strict,
);

export const BACKGROUND_LOGS_SCHEMA = Type.Object(
	{
		taskId: Type.String({ minLength: 1, maxLength: 256 }),
		cursor: Type.Optional(Type.Integer({ minimum: 0 })),
		hash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
		mode: Type.Optional(
			Type.Union([Type.Literal("tail"), Type.Literal("errors"), Type.Literal("summary"), Type.Literal("full")]),
		),
		maxCharacters: Type.Optional(Type.Integer({ minimum: 256, maximum: 50_000 })),
	},
	strict,
);

export const BACKGROUND_WAIT_SCHEMA = Type.Object(
	{
		taskId: Type.String({ minLength: 1, maxLength: 256 }),
		triggers: Type.Optional(Type.Array(BACKGROUND_TRIGGER_INPUT_SCHEMA, { maxItems: 16 })),
	},
	strict,
);

export const BACKGROUND_CANCEL_SCHEMA = Type.Object(
	{
		taskId: Type.String({ minLength: 1, maxLength: 256 }),
		graceMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000 })),
	},
	strict,
);

const MONITOR_STATUS_SCHEMA = Type.Union([
	Type.Literal("starting"),
	Type.Literal("running"),
	Type.Literal("healthy"),
	Type.Literal("stalled"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("cancelled"),
	Type.Literal("lost"),
]);

const BACKGROUND_TRIGGER_SCHEMA = Type.Object(
	{
		version: Type.Literal(1),
		id: Type.String({ minLength: 1 }),
		type: Type.Union([
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("timeout"),
			Type.Literal("stalled"),
			Type.Literal("error-pattern"),
			Type.Literal("progress-review"),
		]),
		enabled: Type.Boolean(),
		pattern: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		flags: Type.Optional(Type.String({ pattern: "^[im]*$", maxLength: 2 })),
	},
	strict,
);

const PROGRESS_REVIEW_CONFIG_SCHEMA = Type.Object(
	{
		version: Type.Literal(1),
		enabled: Type.Boolean(),
		minimumIntervalMs: Type.Integer({ minimum: 1 }),
		maxReviews: Type.Integer({ minimum: 1 }),
		maxInputCharacters: Type.Integer({ minimum: 256 }),
		timeoutMs: Type.Integer({ minimum: 1 }),
		maxOutputTokens: Type.Integer({ minimum: 64 }),
	},
	strict,
);

export const PROGRESS_REVIEW_SCHEMA = Type.Object(
	{
		version: Type.Literal(1),
		state: Type.Union([
			Type.Literal("progressing"),
			Type.Literal("stalled"),
			Type.Literal("failed"),
			Type.Literal("needs-user"),
			Type.Literal("completed"),
		]),
		summary: Type.String({ minLength: 1, maxLength: 4_000 }),
		shouldWakeCoordinator: Type.Boolean(),
		suggestedAction: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
		reviewedAt: Type.Number(),
		logHash: Type.String(),
	},
	strict,
);

export const BACKGROUND_TASK_SCHEMA = Type.Object(
	{
		version: Type.Literal(1),
		id: Type.String({ minLength: 1 }),
		sessionId: Type.String({ minLength: 1 }),
		monitorId: Type.String({ minLength: 1 }),
		source: Type.Union([Type.Literal("started"), Type.Literal("attached")]),
		name: Type.String({ minLength: 1 }),
		goal: Type.Optional(Type.String()),
		executable: Type.Optional(Type.String()),
		args: Type.Array(Type.String()),
		cwd: Type.Optional(Type.String()),
		createdAt: Type.Number(),
		waitRequestedAt: Type.Optional(Type.Number()),
		triggers: Type.Array(BACKGROUND_TRIGGER_SCHEMA),
		logCursor: Type.Integer({ minimum: 0 }),
		logHash: Type.Optional(Type.String()),
		logPrefixHash: Type.Optional(Type.String()),
		lastLogActivityAt: Type.Optional(Type.Number()),
		lastReviewAt: Type.Optional(Type.Number()),
		reviewCount: Type.Integer({ minimum: 0 }),
		lastReviewHash: Type.Optional(Type.String()),
		lastReviewSummary: Type.Optional(Type.String()),
		progressReview: PROGRESS_REVIEW_CONFIG_SCHEMA,
		diagnostics: Type.Array(Type.String()),
	},
	strict,
);

const WAKE_LOG_SCHEMA = Type.Object(
	{
		cursor: Type.Integer({ minimum: 0 }),
		hash: Type.String(),
		summary: Type.String(),
		logPath: Type.Optional(Type.String()),
		truncated: Type.Boolean(),
		rotated: Type.Boolean(),
	},
	strict,
);

export const WAKE_EVENT_SCHEMA = Type.Object(
	{
		version: Type.Literal(1),
		id: Type.String({ minLength: 1 }),
		dedupeKey: Type.String({ minLength: 1 }),
		taskId: Type.String({ minLength: 1 }),
		monitorId: Type.String({ minLength: 1 }),
		reason: Type.Union([
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("timeout"),
			Type.Literal("stalled"),
			Type.Literal("error-pattern"),
			Type.Literal("progress-review"),
		]),
		monitorStatus: MONITOR_STATUS_SCHEMA,
		createdAt: Type.Number(),
		state: Type.Union([
			Type.Literal("queued"),
			Type.Literal("delivered"),
			Type.Literal("consumed"),
			Type.Literal("cancelled"),
		]),
		deliveredAt: Type.Optional(Type.Number()),
		consumedAt: Type.Optional(Type.Number()),
		log: Type.Optional(WAKE_LOG_SCHEMA),
		diagnostic: Type.Optional(Type.String()),
		progressReview: Type.Optional(PROGRESS_REVIEW_SCHEMA),
	},
	strict,
);

export const BACKGROUND_STORE_SNAPSHOT_SCHEMA = Type.Object(
	{
		version: Type.Literal(1),
		sessionId: Type.String({ minLength: 1 }),
		tasks: Type.Array(BACKGROUND_TASK_SCHEMA),
		wakeEvents: Type.Array(WAKE_EVENT_SCHEMA),
		consumedEventKeys: Type.Array(Type.String()),
		updatedAt: Type.Number(),
	},
	strict,
);

export const PROGRESS_REVIEW_OUTPUT_SCHEMA = Type.Object(
	{
		version: Type.Literal(1),
		state: Type.Union([
			Type.Literal("progressing"),
			Type.Literal("stalled"),
			Type.Literal("failed"),
			Type.Literal("needs-user"),
			Type.Literal("completed"),
		]),
		summary: Type.String({ minLength: 1, maxLength: 4_000 }),
		shouldWakeCoordinator: Type.Boolean(),
		suggestedAction: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
	},
	strict,
);
