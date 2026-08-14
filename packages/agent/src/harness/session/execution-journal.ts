import type { PersistenceBackend, PersistenceEvent } from "./persistence-coordinator.ts";

// ============================================================================
// ExecutionJournal
//
// A typed execution fact journal for a session, stored through a
// PersistenceBackend (JSONL file for persisted sessions, memory otherwise).
//
// Contract:
// - completed tool calls are never re-executed after a restart (see
//   wasCompleted());
// - cancel intent is recorded BEFORE the AbortSignal is delivered;
// - executions whose final state is unknown are recorded as unknown and are
//   never automatically replayed;
// - reading the journal explains what happened; it never replays shell,
//   network, or file side effects.
// ============================================================================

export const EXECUTION_JOURNAL_SCHEMA_VERSION = 1;

/** Mirrors the coding-agent execution status union; kept local to avoid cross-package imports. */
export type JournalExecutionStatus = "completed" | "failed" | "cancelled" | "timed_out" | "killed" | "unknown";

export type ExecutionJournalEventType =
	| "run/created"
	| "run/started"
	| "tool/claimed"
	| "tool/started"
	| "tool/checkpoint"
	| "cancel/requested"
	| "tool/completed"
	| "tool/failed"
	| "tool/unknown"
	| "run/settled";

export type JournalToolStatus = "completed" | "failed" | "unknown";

export interface ExecutionJournalEvent {
	seq: number;
	eventId: string;
	schemaVersion: number;
	timestamp: string;
	type: ExecutionJournalEventType;
	sessionId: string;
	runId: string;
	toolCallId?: string;
	jobId?: string;
	attempt: number;
	owner: string;
	causationId?: string;
	idempotencyKey?: string;
	status?: JournalToolStatus;
	failureCategory?: string;
}

export interface ExecutionJournalOptions {
	sessionId: string;
	backend: PersistenceBackend;
}

export class ExecutionJournal {
	private readonly sessionId: string;
	private readonly backend: PersistenceBackend;

	constructor(options: ExecutionJournalOptions) {
		this.sessionId = options.sessionId;
		this.backend = options.backend;
	}

	private event(
		type: ExecutionJournalEventType,
		fields: Omit<ExecutionJournalEvent, "seq" | "eventId" | "schemaVersion" | "timestamp" | "type" | "sessionId">,
	): unknown {
		return {
			...fields,
			type,
			sessionId: this.sessionId,
		};
	}

	recordRunCreated(runId: string, owner: string): Promise<void> {
		return this.append(this.event("run/created", { runId, attempt: 1, owner }));
	}

	recordRunStarted(runId: string, owner: string, causationId?: string): Promise<void> {
		return this.append(this.event("run/started", { runId, attempt: 1, owner, causationId }));
	}

	recordToolClaimed(runId: string, toolCallId: string, owner: string, attempt = 1, jobId?: string): Promise<void> {
		return this.append(this.event("tool/claimed", { runId, toolCallId, jobId, attempt, owner }));
	}

	recordToolStarted(
		runId: string,
		toolCallId: string,
		owner: string,
		attempt = 1,
		causationId?: string,
	): Promise<void> {
		return this.append(this.event("tool/started", { runId, toolCallId, attempt, owner, causationId }));
	}

	recordToolCheckpoint(runId: string, toolCallId: string, owner: string, idempotencyKey?: string): Promise<void> {
		return this.append(this.event("tool/checkpoint", { runId, toolCallId, attempt: 1, owner, idempotencyKey }));
	}

	/** Cancel intent is recorded BEFORE the AbortSignal is delivered. */
	recordCancelRequested(runId: string, toolCallId: string | undefined, owner: string): Promise<void> {
		return this.append(this.event("cancel/requested", { runId, toolCallId, attempt: 1, owner }));
	}

	recordToolFinished(
		runId: string,
		toolCallId: string,
		status: JournalToolStatus,
		owner: string,
		failureCategory?: string,
	): Promise<void> {
		const type: ExecutionJournalEventType =
			status === "completed" ? "tool/completed" : status === "failed" ? "tool/failed" : "tool/unknown";
		return this.append(this.event(type, { runId, toolCallId, attempt: 1, owner, status, failureCategory }));
	}

	recordRunSettled(runId: string, status: JournalExecutionStatus, owner: string): Promise<void> {
		const settled: JournalToolStatus =
			status === "completed" || status === "failed" || status === "unknown" ? status : "unknown";
		return this.append(this.event("run/settled", { runId, attempt: 1, owner, status: settled }));
	}

	private append(event: unknown): Promise<void> {
		return this.backend.appendBatch([event]).then(() => undefined);
	}

	async readEvents(): Promise<ExecutionJournalEvent[]> {
		const events = await this.backend.readAfter(0);
		return events
			.map((event) => this.normalize(event))
			.filter((event): event is ExecutionJournalEvent => event !== undefined);
	}

	/** True when the tool call already recorded a completed outcome (never re-execute). */
	async wasCompleted(toolCallId: string): Promise<boolean> {
		const events = await this.readEvents();
		return events.some((event) => event.toolCallId === toolCallId && event.status === "completed");
	}

	async settledStatus(runId: string): Promise<JournalExecutionStatus | undefined> {
		const events = await this.readEvents();
		for (let index = events.length - 1; index >= 0; index--) {
			const event = events[index]!;
			if (event.runId === runId && event.type === "run/settled" && event.status) return event.status;
		}
		return undefined;
	}

	private normalize(event: PersistenceEvent): ExecutionJournalEvent | undefined {
		const record = event as unknown as Record<string, unknown>;
		if (typeof record.type !== "string" || typeof record.runId !== "string") return undefined;
		return event as unknown as ExecutionJournalEvent;
	}
}
