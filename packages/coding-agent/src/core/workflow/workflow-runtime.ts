import { randomUUID } from "node:crypto";
import type { AgentPool } from "../agents/agent-pool.ts";
import type { AgentProgressEvent, AgentTaskResult, DelegateTaskInput } from "../agents/index.ts";
import { WorkflowMonitorAdapter, type WorkflowMonitorSource } from "../monitor/adapters.ts";
import type {
	MonitorAdapterSnapshot,
	MonitorEventReason,
	MonitorRecord,
	MonitorRuntime,
	MonitorStatus,
} from "../monitor/index.ts";
import type { SessionEntry, SessionManager } from "../session-manager.ts";
import { evaluateWorkflowCondition } from "./condition.ts";
import { workflowSnapshotsFromEntries } from "./details.ts";
import {
	materializeWorkflowTask,
	parseWorkflowDefinition,
	validateWorkflowDefinition,
	WorkflowValidationError,
} from "./schema.ts";
import {
	isWorkflowNodeTerminal,
	isWorkflowTerminal,
	type NormalizedWorkflowDefinition,
	type NormalizedWorkflowNodeDefinition,
	WORKFLOW_DETAILS_VERSION,
	type WorkflowCancelResult,
	type WorkflowNodeSnapshot,
	type WorkflowNodeStatus,
	type WorkflowRunInput,
	type WorkflowSnapshot,
	type WorkflowStatus,
} from "./types.ts";
import { type WorkflowWorktreeLease, WorkflowWorktreeManager } from "./worktree.ts";

export interface WorkflowRuntimeOptions {
	cwd: string;
	sessionManager: SessionManager;
	agentPool: AgentPool;
	monitorRuntime: MonitorRuntime;
	now?: () => Date;
	worktreeRoot?: string;
}

export type WorkflowProgressListener = (snapshot: WorkflowSnapshot) => void;

interface ActiveWorkflow {
	definition: NormalizedWorkflowDefinition;
	snapshot: WorkflowSnapshot;
	controller: AbortController;
	nodeControllers: Map<string, AbortController>;
	completion: Promise<WorkflowSnapshot>;
	resolveCompletion: (snapshot: WorkflowSnapshot) => void;
	cancelRequested: boolean;
	failureNodeId?: string;
	onProgress?: WorkflowProgressListener;
}

function taskSummary(task: string): string {
	const firstLine = task.split(/\r\n|\r|\n/, 1)[0]?.trim() ?? "";
	return firstLine.length > 160 ? `${firstLine.slice(0, 159)}…` : firstLine;
}

function workflowAgentId(workflowId: string, nodeId: string): string {
	return `${workflowId}:${nodeId}`;
}

function elapsed(start: string | undefined, end: string | undefined, now: Date): number {
	if (!start) return 0;
	const startMs = Date.parse(start);
	const endMs = end ? Date.parse(end) : now.getTime();
	return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
}

function workflowNodeStatusFromMonitor(record: MonitorRecord): WorkflowNodeStatus {
	if (record.status === "completed") return "completed";
	if (record.status === "failed") return record.exitReason === "timed_out" ? "timed_out" : "failed";
	if (record.status === "cancelled") return record.exitReason === "condition_false" ? "skipped" : "cancelled";
	return "lost";
}

function workflowStatusFromMonitor(record: MonitorRecord): WorkflowStatus {
	if (record.status === "completed") return "completed";
	if (record.status === "failed") return "failed";
	if (record.status === "cancelled") return "cancelled";
	return "lost";
}

function nodeFailureStatus(status: WorkflowNodeStatus): boolean {
	return status === "failed" || status === "timed_out" || status === "lost";
}

function monitorStatusForNode(status: WorkflowNodeStatus): {
	status: MonitorStatus;
	reason: MonitorEventReason;
	exitReason?: string;
} {
	switch (status) {
		case "pending":
			return { status: "starting", reason: "attached" };
		case "running":
			return { status: "running", reason: "started" };
		case "completed":
			return { status: "completed", reason: "completed" };
		case "failed":
			return { status: "failed", reason: "failed", exitReason: "workflow_node_failed" };
		case "timed_out":
			return { status: "failed", reason: "timeout", exitReason: "timed_out" };
		case "skipped":
			return { status: "cancelled", reason: "skipped", exitReason: "condition_false" };
		case "cancelled":
			return { status: "cancelled", reason: "cancelled", exitReason: "cancelled" };
		case "lost":
			return { status: "lost", reason: "target_lost", exitReason: "state_unconfirmed" };
	}
}

function monitorStatusForWorkflow(status: WorkflowStatus): {
	status: MonitorStatus;
	reason: MonitorEventReason;
	exitReason?: string;
} {
	if (status === "pending") return { status: "starting", reason: "attached" };
	if (status === "running") return { status: "running", reason: "started" };
	if (status === "completed") return { status: "completed", reason: "completed" };
	if (status === "cancelled") return { status: "cancelled", reason: "cancelled", exitReason: "cancelled" };
	if (status === "lost") return { status: "lost", reason: "target_lost", exitReason: "state_unconfirmed" };
	return { status: "failed", reason: "failed", exitReason: "workflow_failed" };
}

function dependencyPayload(
	node: NormalizedWorkflowNodeDefinition,
	snapshots: ReadonlyMap<string, WorkflowNodeSnapshot>,
) {
	return node.dependsOn.map((nodeId) => {
		const dependency = snapshots.get(nodeId)!;
		return {
			nodeId,
			status: dependency.status,
			output: dependency.output,
			error: dependency.error,
			diagnostics: dependency.diagnostics,
		};
	});
}

function nodePrompt(
	node: NormalizedWorkflowNodeDefinition,
	snapshots: ReadonlyMap<string, WorkflowNodeSnapshot>,
): string {
	if (node.dependsOn.length === 0) return node.task;
	return `${node.task}\n\n<workflow_dependencies version="1">\n${JSON.stringify(
		dependencyPayload(node, snapshots),
	)}\n</workflow_dependencies>\nUse only these structured dependency outputs; do not request or reconstruct child transcripts.`;
}

function cloneSnapshot(snapshot: WorkflowSnapshot, now: Date): WorkflowSnapshot {
	const result = structuredClone(snapshot);
	result.durationMs = elapsed(result.startedAt ?? result.createdAt, result.completedAt, now);
	for (const node of result.nodes) node.durationMs = elapsed(node.startedAt ?? node.createdAt, node.completedAt, now);
	return result;
}

export class WorkflowRuntime implements WorkflowMonitorSource {
	readonly cwd: string;
	private readonly sessionManager: SessionManager;
	private readonly agentPool: AgentPool;
	private readonly monitorRuntime: MonitorRuntime;
	private readonly now: () => Date;
	private readonly worktrees: WorkflowWorktreeManager;
	private readonly snapshots = new Map<string, WorkflowSnapshot>();
	private readonly active = new Map<string, ActiveWorkflow>();
	private readonly listeners = new Set<WorkflowProgressListener>();
	private readonly scheduleWaiters = new Set<() => void>();
	private disposed = false;

	constructor(options: WorkflowRuntimeOptions) {
		this.cwd = options.cwd;
		this.sessionManager = options.sessionManager;
		this.agentPool = options.agentPool;
		this.monitorRuntime = options.monitorRuntime;
		this.now = options.now ?? (() => new Date());
		this.worktrees = new WorkflowWorktreeManager({
			cwd: options.cwd,
			sessionId: options.sessionManager.getSessionId(),
			rootDir: options.worktreeRoot,
		});
		this.restoreSnapshots(options.sessionManager.getBranch());
		this.monitorRuntime.setAdapter("workflow", new WorkflowMonitorAdapter(this));
	}

	list(): WorkflowSnapshot[] {
		return [...this.snapshots.values()].map((snapshot) => cloneSnapshot(snapshot, this.now()));
	}

	subscribe(listener: WorkflowProgressListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	status(workflowId: string): WorkflowSnapshot | undefined {
		const snapshot = this.snapshots.get(workflowId);
		return snapshot ? cloneSnapshot(snapshot, this.now()) : undefined;
	}

	get defaultProfileId(): string {
		return this.agentPool.defaultProfileId;
	}

	getProfileIds(): string[] {
		return this.agentPool.getProfileIds();
	}

	async run(
		input: WorkflowRunInput,
		signal?: AbortSignal,
		onProgress?: WorkflowProgressListener,
	): Promise<WorkflowSnapshot> {
		const started = this.start(input, signal, onProgress);
		const active = this.active.get(started.workflowId);
		return active ? await active.completion : (this.status(started.workflowId) ?? started);
	}

	start(input: WorkflowRunInput, signal?: AbortSignal, onProgress?: WorkflowProgressListener): WorkflowSnapshot {
		if (this.disposed) throw new Error("Workflow Runtime is disposed");
		const definition = validateWorkflowDefinition(
			parseWorkflowDefinition(input.workflow),
			(profile) => this.agentPool.hasProfile(profile),
			{
				defaultProfile: this.agentPool.defaultProfileId,
				availableProfiles: this.agentPool.getProfileIds(),
			},
		);
		materializeWorkflowTask(definition, input.task);
		const createdAt = this.now();
		const workflowId = `wf-${randomUUID()}`;
		const parentMonitor = this.monitorRuntime.attach({
			target: { kind: "workflow", workflowId, definitionId: definition.id },
			name: `Workflow(${definition.id})`,
			taskSummary: definition.description ?? definition.id,
			createdAt: createdAt.getTime(),
		});
		const nodes = definition.nodes.map((node): WorkflowNodeSnapshot => {
			const agentId = workflowAgentId(workflowId, node.id);
			const monitor = this.monitorRuntime.attach({
				target: {
					kind: "workflow",
					workflowId,
					nodeId: node.id,
					definitionId: definition.id,
					profile: node.profile,
					dependsOn: [...node.dependsOn],
					condition: node.condition,
					writePolicy: node.writePolicy,
					failurePolicy: node.failurePolicy,
				},
				name: `Workflow(${definition.id}:${node.id})`,
				taskSummary: taskSummary(node.task),
				createdAt: createdAt.getTime(),
			});
			return {
				id: node.id,
				agentId,
				profile: node.profile,
				taskSummary: taskSummary(node.task),
				dependsOn: [...node.dependsOn],
				condition: node.condition,
				writePolicy: node.writePolicy,
				failurePolicy: node.failurePolicy,
				status: "pending",
				createdAt: createdAt.toISOString(),
				durationMs: 0,
				monitorId: monitor.id,
				diagnostics: [],
			};
		});
		const snapshot: WorkflowSnapshot = {
			version: WORKFLOW_DETAILS_VERSION,
			workflowId,
			definitionId: definition.id,
			description: definition.description,
			status: "pending",
			createdAt: createdAt.toISOString(),
			durationMs: 0,
			maxConcurrency: definition.maxConcurrency,
			monitorId: parentMonitor.id,
			nodes,
			diagnostics: [],
		};
		let resolveCompletion!: (snapshot: WorkflowSnapshot) => void;
		const completion = new Promise<WorkflowSnapshot>((resolve) => {
			resolveCompletion = resolve;
		});
		const active: ActiveWorkflow = {
			definition,
			snapshot,
			controller: new AbortController(),
			nodeControllers: new Map(),
			completion,
			resolveCompletion,
			cancelRequested: false,
			onProgress,
		};
		this.snapshots.set(workflowId, snapshot);
		this.active.set(workflowId, active);
		const onAbort = (): void => this.requestCancel(active);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) this.requestCancel(active);
		void this.execute(active).finally(() => signal?.removeEventListener("abort", onAbort));
		return cloneSnapshot(active.snapshot, this.now());
	}

	async cancelWorkflow(workflowId: string): Promise<WorkflowCancelResult> {
		const active = this.active.get(workflowId);
		if (!active) {
			const workflow = this.status(workflowId);
			return workflow
				? { accepted: false, reason: "already_terminal", workflow }
				: { accepted: false, reason: "workflow_not_found" };
		}
		this.requestCancel(active);
		return { accepted: true, reason: "cancel_requested", workflow: await active.completion };
	}

	requestCancelById(workflowId: string): boolean {
		const active = this.active.get(workflowId);
		if (!active) return false;
		this.requestCancel(active);
		return true;
	}

	poll(workflowId: string, nodeId: string | undefined): MonitorAdapterSnapshot {
		const active = this.active.get(workflowId);
		if (!active) return { availability: "unknown" };
		if (!nodeId) return this.adapterSnapshot(active.snapshot.status);
		const node = active.snapshot.nodes.find((candidate) => candidate.id === nodeId);
		return node
			? this.adapterSnapshot(node.status)
			: { availability: "missing", exitReason: "workflow_node_missing" };
	}

	cancel(workflowId: string): boolean {
		return this.requestCancelById(workflowId);
	}

	async cancelActiveWorkflows(): Promise<void> {
		for (const active of this.active.values()) this.requestCancel(active);
		await Promise.all([...this.active.values()].map((workflow) => workflow.completion));
	}

	async rebuild(entries: readonly SessionEntry[] = this.sessionManager.getBranch()): Promise<void> {
		await this.cancelActiveWorkflows();
		this.snapshots.clear();
		this.restoreSnapshots(entries);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.cancelActiveWorkflows();
		await this.worktrees.dispose();
		this.listeners.clear();
	}

	private restoreSnapshots(entries: readonly SessionEntry[]): void {
		for (const restored of workflowSnapshotsFromEntries(entries)) {
			const snapshot = structuredClone(restored);
			if (!isWorkflowTerminal(snapshot.status)) {
				snapshot.status = "lost";
				snapshot.completedAt = this.now().toISOString();
				snapshot.error = {
					code: "state_unconfirmed",
					message: "Workflow state could not be confirmed after restore",
				};
				for (const node of snapshot.nodes) {
					if (node.status === "pending" || node.status === "running") {
						node.status = "lost";
						node.completedAt = snapshot.completedAt;
						node.error = {
							code: "state_unconfirmed",
							message: "Node state could not be confirmed after restore",
						};
					}
				}
			}
			this.snapshots.set(snapshot.workflowId, snapshot);
		}
		this.restoreMonitorOnlySnapshots();
	}

	private restoreMonitorOnlySnapshots(): void {
		const records = this.monitorRuntime.list({ kind: "workflow", includeTerminal: true });
		const workflowIds = new Set(
			records
				.filter((record) => record.target.kind === "workflow")
				.map((record) => (record.target.kind === "workflow" ? record.target.workflowId : "")),
		);
		for (const workflowId of workflowIds) {
			if (!workflowId || this.snapshots.has(workflowId)) continue;
			const workflowRecords = records.filter(
				(record) => record.target.kind === "workflow" && record.target.workflowId === workflowId,
			);
			const parent = workflowRecords.find(
				(record) => record.target.kind === "workflow" && record.target.nodeId === undefined,
			);
			const first = parent ?? workflowRecords[0];
			if (!first || first.target.kind !== "workflow") continue;
			const completedAt =
				first.completedAt === undefined ? this.now().toISOString() : new Date(first.completedAt).toISOString();
			const status = workflowStatusFromMonitor(first);
			const nodes = workflowRecords
				.filter((record) => record.target.kind === "workflow" && record.target.nodeId !== undefined)
				.map((record): WorkflowNodeSnapshot => {
					const target = record.target;
					if (target.kind !== "workflow" || !target.nodeId) throw new Error("Invalid Workflow monitor target");
					const nodeStatus = workflowNodeStatusFromMonitor(record);
					return {
						id: target.nodeId,
						agentId: workflowAgentId(workflowId, target.nodeId),
						profile: target.profile ?? "unknown",
						taskSummary: record.taskSummary,
						dependsOn: [...(target.dependsOn ?? [])],
						condition: target.condition,
						writePolicy: target.writePolicy ?? "none",
						failurePolicy: target.failurePolicy ?? "fail-workflow",
						status: nodeStatus,
						createdAt: new Date(record.createdAt).toISOString(),
						startedAt: record.startedAt === undefined ? undefined : new Date(record.startedAt).toISOString(),
						completedAt:
							record.completedAt === undefined ? completedAt : new Date(record.completedAt).toISOString(),
						durationMs: record.durationMs,
						monitorId: record.id,
						diagnostics: [
							...record.diagnostics.map((message) => ({
								code: "monitor_diagnostic",
								message,
								nodeId: target.nodeId,
							})),
							...(nodeStatus === "lost"
								? [
										{
											code: "state_unconfirmed",
											message: "Workflow node state could not be confirmed after restore",
											nodeId: target.nodeId,
										},
									]
								: []),
						],
						error:
							nodeStatus === "completed"
								? undefined
								: {
										code: record.exitReason ?? nodeStatus,
										message:
											record.diagnostics.at(-1) ??
											(nodeStatus === "lost"
												? "Node state could not be confirmed after restore"
												: nodeStatus),
									},
					};
				});
			this.snapshots.set(workflowId, {
				version: WORKFLOW_DETAILS_VERSION,
				workflowId,
				definitionId: first.target.definitionId ?? "restored-workflow",
				description: first.taskSummary,
				status,
				createdAt: new Date(first.createdAt).toISOString(),
				startedAt: first.startedAt === undefined ? undefined : new Date(first.startedAt).toISOString(),
				completedAt,
				durationMs: first.durationMs,
				maxConcurrency: 1,
				monitorId: first.id,
				nodes,
				diagnostics: [
					...first.diagnostics.map((message) => ({ code: "monitor_diagnostic", message })),
					...(status === "lost"
						? [{ code: "state_unconfirmed", message: "Workflow state could not be confirmed after restore" }]
						: []),
				],
				error:
					status === "completed"
						? undefined
						: {
								code: first.exitReason ?? status,
								message:
									first.diagnostics.at(-1) ??
									(status === "lost" ? "Workflow state could not be confirmed after restore" : status),
							},
			});
		}
	}

	private adapterSnapshot(status: WorkflowStatus | WorkflowNodeStatus): MonitorAdapterSnapshot {
		if (status === "pending") return { availability: "confirmed", running: true, healthy: false };
		if (status === "running") return { availability: "confirmed", running: true, healthy: true };
		if (status === "completed") return { availability: "confirmed", running: false, exitCode: 0 };
		if (status === "cancelled" || status === "skipped") {
			return { availability: "confirmed", running: false, cancelled: true, exitReason: status };
		}
		if (status === "lost") return { availability: "missing", exitReason: "state_unconfirmed" };
		return { availability: "confirmed", running: false, exitCode: 1, exitReason: status };
	}

	private requestCancel(active: ActiveWorkflow): void {
		if (active.cancelRequested || isWorkflowTerminal(active.snapshot.status)) return;
		active.cancelRequested = true;
		active.controller.abort();
		for (const controller of active.nodeControllers.values()) controller.abort();
		for (const node of active.snapshot.nodes) {
			if (node.status === "pending")
				this.finishNode(active, node, "cancelled", undefined, {
					code: "cancelled",
					message: "Workflow was cancelled before the node started",
				});
		}
		this.publish(active);
	}

	private async execute(active: ActiveWorkflow): Promise<void> {
		const startedAt = this.now();
		active.snapshot.status = "running";
		active.snapshot.startedAt = startedAt.toISOString();
		this.updateWorkflowMonitor(active);
		this.publish(active);
		const running = new Map<string, Promise<void>>();
		try {
			while (active.snapshot.nodes.some((node) => !isWorkflowNodeTerminal(node.status))) {
				if (active.cancelRequested || active.failureNodeId) {
					for (const controller of active.nodeControllers.values()) controller.abort();
				}
				let started = false;
				for (const definition of active.definition.nodes) {
					const node = active.snapshot.nodes.find((candidate) => candidate.id === definition.id)!;
					if (node.status !== "pending") continue;
					const dependencies = definition.dependsOn.map(
						(dependency) => active.snapshot.nodes.find((candidate) => candidate.id === dependency)!,
					);
					if (!dependencies.every((dependency) => isWorkflowNodeTerminal(dependency.status))) continue;
					if (!evaluateWorkflowCondition(definition.condition, dependencies)) {
						this.finishNode(active, node, "skipped", undefined, {
							code: "condition_false",
							message: `Condition evaluated to false: ${definition.condition ?? "default"}`,
						});
						started = true;
						continue;
					}
					if (running.size >= active.definition.maxConcurrency || !this.canStart(node)) continue;
					const promise = this.runNode(active, definition, node).finally(() => running.delete(node.id));
					running.set(node.id, promise);
					started = true;
				}
				if (running.size > 0) {
					await Promise.race(running.values());
					continue;
				}
				if (!started) {
					const anotherWorkflowIsRunning = [...this.active.values()].some(
						(workflow) =>
							workflow !== active && workflow.snapshot.nodes.some((node) => node.status === "running"),
					);
					if (anotherWorkflowIsRunning) {
						await this.waitForScheduleChange();
						continue;
					}
					for (const node of active.snapshot.nodes) {
						if (node.status !== "pending") continue;
						this.finishNode(active, node, "lost", undefined, {
							code: "scheduler_deadlock",
							message: "Workflow scheduler could not make deterministic progress",
						});
					}
				}
			}
			await Promise.all(running.values());
			if (active.cancelRequested) active.snapshot.status = "cancelled";
			else if (active.snapshot.nodes.some((node) => nodeFailureStatus(node.status)))
				active.snapshot.status = "failed";
			else active.snapshot.status = "completed";
		} catch (error) {
			active.snapshot.status = active.cancelRequested ? "cancelled" : "failed";
			active.snapshot.error = {
				code: error instanceof WorkflowValidationError ? error.code : "workflow_error",
				message: error instanceof Error ? error.message : String(error),
			};
		} finally {
			const completedAt = this.now();
			active.snapshot.completedAt = completedAt.toISOString();
			active.snapshot.durationMs = elapsed(active.snapshot.startedAt, active.snapshot.completedAt, completedAt);
			if (active.snapshot.status !== "completed") await this.worktrees.cleanupWorkflow(active.snapshot.workflowId);
			for (const node of active.snapshot.nodes) {
				const lease = this.worktrees.get(active.snapshot.workflowId, node.id);
				if (!lease) continue;
				node.worktree = this.worktrees.toSnapshot(
					lease,
					active.snapshot.status === "completed" && lease.status === "active"
						? "session_end"
						: "workflow_terminal",
				);
				node.diagnostics.push(...lease.diagnostics);
			}
			this.updateWorkflowMonitor(active);
			this.publish(active);
			const finalSnapshot = cloneSnapshot(active.snapshot, completedAt);
			this.snapshots.set(finalSnapshot.workflowId, finalSnapshot);
			this.active.delete(finalSnapshot.workflowId);
			active.resolveCompletion(finalSnapshot);
		}
	}

	private canStart(candidate: WorkflowNodeSnapshot): boolean {
		const active = [...this.active.values()].flatMap((workflow) =>
			workflow.snapshot.nodes.filter((node) => node.status === "running"),
		);
		if (candidate.writePolicy === "isolated") return true;
		if (candidate.writePolicy === "shared") {
			return active.every((node) => node.writePolicy === "isolated");
		}
		return !active.some((node) => node.writePolicy === "shared");
	}

	private async runNode(
		active: ActiveWorkflow,
		definition: NormalizedWorkflowNodeDefinition,
		node: WorkflowNodeSnapshot,
	): Promise<void> {
		const controller = new AbortController();
		active.nodeControllers.set(node.id, controller);
		const onWorkflowAbort = (): void => controller.abort();
		active.controller.signal.addEventListener("abort", onWorkflowAbort, { once: true });
		let lease: WorkflowWorktreeLease | undefined;
		try {
			if (definition.writePolicy === "isolated") {
				lease = await this.worktrees.create(active.snapshot.workflowId, node.id, controller.signal);
				node.worktree = this.worktrees.toSnapshot(lease, "session_end");
			}
			node.status = "running";
			node.startedAt = this.now().toISOString();
			this.updateNodeMonitor(active, node, {
				kind: "workflow",
				timestamp: Date.parse(node.startedAt),
				outcome: "started",
				message: `Workflow node ${node.id} started`,
			});
			this.publish(active);
			const snapshots = new Map(active.snapshot.nodes.map((item) => [item.id, item]));
			const input: DelegateTaskInput = {
				task: nodePrompt(definition, snapshots),
				profile: definition.profile,
				taskId: node.agentId,
				budget: definition.budget,
				cancelStrategy: definition.cancelStrategy,
				hardTimeoutMs: definition.timeoutMs,
				cwd: lease?.path ?? this.cwd,
				allowFileModifications: definition.writePolicy !== "none",
			};
			const result = await this.agentPool.delegateTask(input, controller.signal, (progress) =>
				this.noteNodeProgress(active, node, progress),
			);
			const status: WorkflowNodeStatus =
				result.status === "completed"
					? "completed"
					: result.status === "cancelled"
						? "cancelled"
						: result.status === "timed_out"
							? "timed_out"
							: "failed";
			this.finishNode(active, node, status, result, result.error);
			if (nodeFailureStatus(status)) this.applyFailurePolicy(active, definition, node);
		} catch (error) {
			const cancelled = controller.signal.aborted || active.cancelRequested;
			this.finishNode(active, node, cancelled ? "cancelled" : "failed", undefined, {
				code: cancelled ? "cancelled" : "workflow_node_error",
				message: error instanceof Error ? error.message : String(error),
			});
			if (!cancelled) this.applyFailurePolicy(active, definition, node);
		} finally {
			active.controller.signal.removeEventListener("abort", onWorkflowAbort);
			active.nodeControllers.delete(node.id);
			if (lease && node.status !== "completed") {
				await this.worktrees.cleanupNode(active.snapshot.workflowId, node.id);
				node.worktree = this.worktrees.toSnapshot(lease, "node_terminal");
				node.diagnostics.push(...lease.diagnostics);
			}
			this.publish(active);
		}
	}

	private noteNodeProgress(active: ActiveWorkflow, node: WorkflowNodeSnapshot, progress: AgentProgressEvent): void {
		const timestamp = progress.timestamp;
		this.updateNodeMonitor(active, node, {
			kind: progress.toolName ? "tool" : "turn",
			timestamp,
			turn: progress.turn,
			toolName: progress.toolName,
			targetPath: progress.targetPath,
			outcome: progress.outcome,
			message: progress.message,
		});
		this.monitorRuntime.update(active.snapshot.monitorId, {
			status: "healthy",
			reason: "activity",
			timestamp,
			activity: {
				kind: "workflow",
				timestamp,
				outcome: progress.outcome,
				message: `${node.id}: ${progress.message}`,
			},
		});
		this.publish(active);
	}

	private finishNode(
		active: ActiveWorkflow,
		node: WorkflowNodeSnapshot,
		status: WorkflowNodeStatus,
		output?: AgentTaskResult,
		error?: { code: string; message: string },
	): void {
		if (isWorkflowNodeTerminal(node.status)) return;
		node.status = status;
		node.completedAt = this.now().toISOString();
		node.durationMs = elapsed(node.startedAt ?? node.createdAt, node.completedAt, this.now());
		if (output) node.output = structuredClone(output);
		if (error) {
			node.error = { ...error };
			node.diagnostics.push({ code: error.code, message: error.message, nodeId: node.id });
		}
		this.updateNodeMonitor(active, node, {
			kind: "workflow",
			timestamp: Date.parse(node.completedAt),
			outcome: status === "completed" ? "succeeded" : "failed",
			message: error?.message ?? `Workflow node ${node.id} ${status}`,
		});
	}

	private applyFailurePolicy(
		active: ActiveWorkflow,
		definition: NormalizedWorkflowNodeDefinition,
		node: WorkflowNodeSnapshot,
	): void {
		if (definition.failurePolicy === "continue") return;
		if (definition.failurePolicy === "fail-workflow") {
			active.failureNodeId = node.id;
			active.snapshot.error = {
				code: node.error?.code ?? "workflow_node_failed",
				message: node.error?.message ?? `Workflow node ${node.id} failed`,
				nodeId: node.id,
			};
			for (const [nodeId, controller] of active.nodeControllers) {
				if (nodeId !== node.id) controller.abort();
			}
			for (const pending of active.snapshot.nodes) {
				if (pending.status === "pending") {
					this.finishNode(active, pending, "cancelled", undefined, {
						code: "upstream_failure",
						message: `Workflow stopped after node ${node.id} failed`,
					});
				}
			}
			return;
		}
		const dependents = new Set<string>();
		const queue = [node.id];
		while (queue.length > 0) {
			const failedNode = queue.shift()!;
			for (const candidate of active.definition.nodes) {
				if (!candidate.dependsOn.includes(failedNode) || dependents.has(candidate.id)) continue;
				dependents.add(candidate.id);
				queue.push(candidate.id);
			}
		}
		for (const dependentId of dependents) {
			const dependent = active.snapshot.nodes.find((candidate) => candidate.id === dependentId)!;
			if (dependent.status === "pending") {
				this.finishNode(active, dependent, "skipped", undefined, {
					code: "upstream_failure",
					message: `Skipped because dependency ${node.id} failed`,
				});
			}
		}
	}

	private updateNodeMonitor(
		_active: ActiveWorkflow,
		node: WorkflowNodeSnapshot,
		activity?: {
			kind: "turn" | "tool" | "agent" | "workflow";
			timestamp: number;
			turn?: number;
			toolName?: string;
			targetPath?: string;
			outcome: "started" | "succeeded" | "failed";
			message: string;
		},
	): void {
		const mapped = monitorStatusForNode(node.status);
		this.monitorRuntime.update(node.monitorId, {
			status: mapped.status,
			reason: mapped.reason,
			exitReason: mapped.exitReason ?? node.error?.code,
			timestamp: activity?.timestamp ?? this.now().getTime(),
			activity,
			diagnostic: node.error?.message,
		});
	}

	private updateWorkflowMonitor(active: ActiveWorkflow): void {
		const mapped = monitorStatusForWorkflow(active.snapshot.status);
		this.monitorRuntime.update(active.snapshot.monitorId, {
			status: mapped.status,
			reason: mapped.reason,
			exitReason: mapped.exitReason ?? active.snapshot.error?.code,
			timestamp: this.now().getTime(),
			diagnostic: active.snapshot.error?.message,
			activity: {
				kind: "workflow",
				timestamp: this.now().getTime(),
				outcome:
					active.snapshot.status === "completed"
						? "succeeded"
						: active.snapshot.status === "running"
							? "started"
							: "failed",
				message: `Workflow ${active.snapshot.definitionId} ${active.snapshot.status}`,
			},
		});
	}

	private waitForScheduleChange(): Promise<void> {
		return new Promise((resolve) => this.scheduleWaiters.add(resolve));
	}

	private publish(active: ActiveWorkflow): void {
		this.snapshots.set(active.snapshot.workflowId, active.snapshot);
		for (const resolve of this.scheduleWaiters) resolve();
		this.scheduleWaiters.clear();
		const snapshot = cloneSnapshot(active.snapshot, this.now());
		try {
			active.onProgress?.(snapshot);
		} catch {
			// Progress observers are non-authoritative.
		}
		for (const listener of this.listeners) {
			try {
				listener(structuredClone(snapshot));
			} catch {
				// Runtime observers are non-authoritative.
			}
		}
	}
}
