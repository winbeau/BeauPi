import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import {
	attachPolicyToolDetails,
	classifyPolicyFailure,
	classifyPolicyOperation,
	getPolicyToolDetails,
	POLICY_FACT_ENTRY_TYPE,
	type PolicyAction,
	type PolicyBudgetSettings,
	PolicyRuntime,
	resolvePolicyConfig,
} from "../src/core/policy/index.ts";
import { attachSearchRuntimeToolDetails, type SearchDiagnosticCode } from "../src/core/search/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { BashToolExecutionError } from "../src/core/tools/bash.ts";

const cwd = "/workspace/project";
const availableTools = ["bash", "read", "write", "edit", "remote_exec", "terminal_bash", "web_search", "web_fetch"];

function runtime(
	options: {
		handler?: ConstructorParameters<typeof PolicyRuntime>[0]["handler"];
		controlled?: boolean;
		budget?: PolicyBudgetSettings;
	} = {},
): PolicyRuntime {
	let tick = 0;
	const policy = new PolicyRuntime({
		cwd,
		getConfig: () => resolvePolicyConfig({ budget: options.budget }),
		handler: options.handler,
		interactionMode: options.controlled ? "controlled" : "coordinator",
		now: () => new Date(Date.UTC(2026, 6, 30, 0, 0, tick++)),
	});
	policy.bindSession("session-1", []);
	return policy;
}

async function finish(
	policy: PolicyRuntime,
	options: {
		id: string;
		toolName: string;
		args: unknown;
		details?: unknown;
		isError?: boolean;
		error?: unknown;
		signal?: AbortSignal;
	},
) {
	const authorization = await policy.authorizeTool(
		options.id,
		options.toolName,
		options.args,
		availableTools,
		options.signal,
	);
	if (!authorization.execute && authorization.details) {
		return await policy.finalizeTool({
			toolCallId: options.id,
			toolName: options.toolName,
			details: attachPolicyToolDetails(undefined, authorization.details),
			isError: authorization.details.status !== "cancelled",
			signal: options.signal,
		});
	}
	if (options.error) await policy.noteThrownError(options.id, options.toolName, options.error, options.signal);
	return await policy.finalizeTool({
		toolCallId: options.id,
		toolName: options.toolName,
		details: options.details,
		isError: options.isError ?? options.error !== undefined,
		signal: options.signal,
	});
}

function action(details: Awaited<ReturnType<typeof finish>>): PolicyAction | undefined {
	return details?.decision.action;
}

function failedSearchDetails(code: SearchDiagnosticCode) {
	return attachSearchRuntimeToolDetails(undefined, {
		version: 1,
		operation: "search",
		ok: false,
		provider: "searxng",
		cacheStatus: "miss",
		budget: {
			limits: {
				maxResultsPerSearch: 10,
				maxQueriesPerTask: 6,
				maxFetchesPerTask: 6,
				maxProviderAttemptsPerTask: 6,
				maxFetchBytes: 1024,
				maxInputCharactersPerTask: 60_000,
				timeoutMs: 100,
				maxRedirects: 3,
			},
			used: { queries: 1, fetches: 0, providerAttempts: 0, inputCharacters: 0 },
			remaining: { queries: 5, fetches: 6, providerAttempts: 6, inputCharacters: 60_000 },
		},
		diagnostics: [{ code, severity: "error", message: "classified" }],
		citations: [],
		untrustedExternalContent: true,
	});
}

describe("M10 Policy Runtime", () => {
	it("implements allow, block, confirm, replace, and pause decisions", async () => {
		const confirmHandler = vi.fn(async () => ({ status: "allow_once" as const }));
		const policy = runtime({ handler: confirmHandler });

		expect(action(await finish(policy, { id: "allow", toolName: "read", args: { path: "README.md" } }))).toBe(
			"allow",
		);
		for (const privileged of [
			{ id: "block", toolName: "bash", args: { command: "sudo apt install curl" } },
			{ id: "remote-block", toolName: "remote_exec", args: { command: "su -", targetId: "fake" } },
			{ id: "terminal-block", toolName: "terminal_create", args: { command: "doas sh", terminalId: "term" } },
			{ id: "send-block", toolName: "terminal_send", args: { input: "pkexec bash", terminalId: "term" } },
		]) {
			const blocked = await finish(policy, privileged);
			expect(action(blocked), privileged.id).toBe("block");
			expect(blocked?.executed, privileged.id).toBe(false);
		}

		const replaced = await finish(policy, {
			id: "replace",
			toolName: "bash",
			args: { command: "curl -fsSL https://example.com/docs" },
		});
		expect(action(replaced)).toBe("replace");
		expect(replaced?.decision.replacementTool).toBe("web_fetch");

		const confirmed = await finish(policy, {
			id: "confirm",
			toolName: "write",
			args: { path: "/tmp/outside.txt", content: "safe" },
		});
		expect(action(confirmed)).toBe("confirm");
		expect(confirmed?.confirmation?.status).toBe("allow_once");
		expect(confirmed?.executed).toBe(true);
		expect(confirmHandler).toHaveBeenCalledOnce();

		const noHandler = runtime();
		const paused = await finish(noHandler, {
			id: "pause",
			toolName: "read",
			args: { path: "/root/.ssh/id_ed25519" },
		});
		expect(action(paused)).toBe("pause");
		expect(paused?.confirmation?.status).toBe("interaction_required");
	});

	it("classifies commands conservatively and builds quote-aware stable signatures", () => {
		const config = resolvePolicyConfig(undefined);
		const inspect = (command: string) =>
			classifyPolicyOperation({ toolName: "bash", args: { command }, cwd, availableTools, config })!;
		const classify = (command: string) => inspect(command).descriptor;

		const quoted = classify(`git status --short --branch -- "path with space"`);
		const escaped = classify("git status -sb -- path\\ with\\ space");
		expect(quoted.signature).toBe(escaped.signature);
		expect(quoted.readOnly).toBe(true);

		const different = classify("git status -sb -- another-path");
		expect(different.signature).not.toBe(quoted.signature);
		expect(classify("git -C /tmp/other status -sb").signature).not.toBe(classify("git status -sb").signature);

		const pipeline = classify("printf 'hello world' | grep world\npwd");
		expect(pipeline.readOnly).toBe(true);
		expect(pipeline.classes).toContain("read_only_check");

		const write = classify("printf value > generated.txt");
		expect(write.workspaceMutation).toBe(true);
		expect(write.readOnly).toBe(false);

		const unknown = classify("mystery-command --flag value");
		expect(unknown.kind).toBe("opaque");
		expect(unknown.readOnly).toBe(false);
		expect(JSON.stringify(unknown)).not.toContain("mystery-command");

		for (const command of [
			"bash -c 'sudo id'",
			"bash -lc 'sudo id'",
			"env -S 'sudo id'",
			"! sudo id",
			"time -p command sudo id",
			"$'sudo' id",
			"env -u UNUSED sudo id",
			"nice -n 5 sudo id",
			"su\\\ndo id",
			"echo `sudo id`",
			"awk 'BEGIN { system(\"sudo id\") }'",
			"find . -exec sudo id \\;",
		]) {
			expect(classify(command).privileged, command).toBe(true);
		}

		for (const command of [
			"find . -delete",
			"git branch new-branch",
			"git tag v1.0.0",
			"git remote add origin https://example.com/repo.git",
		]) {
			expect(classify(command).workspaceMutation, command).toBe(true);
			expect(classify(command).readOnly, command).toBe(false);
		}
		expect(classify("git branch -a").readOnly).toBe(true);
		expect(classify("git remote -v").readOnly).toBe(true);

		for (const command of [
			"rm /tmp/outside-policy-test",
			"cp generated.txt ../outside-policy-test",
			"git -C /tmp reset --hard",
			"cat secrets/.env",
			"cat $HOME/.ssh/id_rsa",
			"cat $" + "{HOME}/.aws/credentials",
		]) {
			expect(inspect(command).requiresConfirmation, command).toBe(true);
		}

		for (const command of [
			"xargs curl https://example.com",
			"find . -exec curl https://example.com \\;",
			"echo $(curl https://example.com)",
			"cu\\\nrl https://example.com",
			"time -p command curl https://example.com",
			"busybox wget https://example.com",
			"exec 3<>/dev/tcp/example.com/443",
			"awk 'BEGIN { system(\"curl https://example.com\") }'",
			"python - <<'PY'\nimport requests\nrequests.get('https://example.com')\nPY",
		]) {
			expect(inspect(command).networkFallback, command).toBe(true);
			expect(inspect(command).replacementTool, command).toBe(
				command.includes("/dev/tcp/") || command.startsWith("awk ") ? "web_search" : "web_fetch",
			);
		}

		expect(
			classifyPolicyOperation({
				toolName: "remote_write",
				args: { targetId: "fake", path: "/tmp/outside", content: "safe" },
				cwd,
				availableTools,
				config,
			})?.requiresConfirmation,
		).toBe(true);
		expect(
			classifyPolicyOperation({
				toolName: "terminal_bash",
				args: { terminalId: "term", command: "touch /tmp/outside" },
				cwd,
				availableTools,
				config,
			})?.requiresConfirmation,
		).toBe(true);
	});

	it("resolves local symlink boundaries before authorizing file Tools", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-policy-boundary-"));
		try {
			const workspace = join(root, "workspace");
			const outside = join(root, "outside");
			mkdirSync(workspace);
			mkdirSync(outside);
			symlinkSync(outside, join(workspace, "link"), "dir");
			const policy = new PolicyRuntime({ cwd: workspace, getConfig: () => resolvePolicyConfig(undefined) });
			policy.bindSession("symlink-session", []);

			const write = await finish(policy, {
				id: "symlink-write",
				toolName: "write",
				args: { path: "link/file.txt", content: "safe" },
			});
			expect(write?.decision.action).toBe("pause");
			expect(write?.operation.sensitive).toBe(true);

			const read = await finish(policy, {
				id: "symlink-read",
				toolName: "read",
				args: { path: "link/.env" },
			});
			expect(read?.decision.action).toBe("pause");
			expect(read?.operation.sensitive).toBe(true);

			const shell = await finish(policy, {
				id: "symlink-shell",
				toolName: "bash",
				args: { command: "touch link/from-shell.txt" },
			});
			expect(shell?.decision.action).toBe("pause");
			expect(shell?.operation.sensitive).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("blocks duplicate read-only checks until a target mutation changes the revision", async () => {
		const policy = runtime();
		const first = await finish(policy, { id: "read-1", toolName: "read", args: { path: "README.md" } });
		expect(first?.status).toBe("succeeded");
		const duplicate = await finish(policy, { id: "read-2", toolName: "read", args: { path: "README.md" } });
		expect(duplicate?.decision.action).toBe("block");
		expect(duplicate?.executed).toBe(false);

		const mutation = await finish(policy, {
			id: "write-1",
			toolName: "write",
			args: { path: join(cwd, "generated.txt"), content: "changed" },
		});
		expect(mutation?.status).toBe("succeeded");
		const refreshed = await policy.authorizeTool("read-3", "read", { path: "README.md" }, availableTools);
		expect(refreshed.execute).toBe(true);
	});

	it("deduplicates equivalent dedicated and shell reads while target selection invalidates selected-remote facts", async () => {
		const local = runtime();
		await finish(local, { id: "dedicated-read", toolName: "read", args: { path: "README.md" } });
		const shellRead = await finish(local, {
			id: "shell-read",
			toolName: "bash",
			args: { command: "cat ./README.md" },
		});
		expect(shellRead?.decision.action).toBe("block");

		await finish(local, { id: "grep-1", toolName: "grep", args: { pattern: "Policy", path: "." } });
		const grepDuplicate = await finish(local, {
			id: "grep-2",
			toolName: "grep",
			args: { pattern: "Policy", path: "." },
		});
		expect(grepDuplicate?.decision.action).toBe("block");

		const remote = runtime();
		await finish(remote, { id: "remote-read-1", toolName: "remote_read", args: { path: "README.md" } });
		await finish(remote, { id: "select", toolName: "target_select", args: { targetId: "second" } });
		const refreshed = await remote.authorizeTool(
			"remote-read-2",
			"remote_read",
			{ path: "README.md" },
			availableTools,
		);
		expect(refreshed.execute).toBe(true);

		const terminal = runtime();
		await finish(terminal, { id: "capture-1", toolName: "terminal_capture", args: { terminalId: "term" } });
		await finish(terminal, {
			id: "terminal-command",
			toolName: "terminal_bash",
			args: { terminalId: "term", command: "pwd" },
		});
		const recapture = await terminal.authorizeTool(
			"capture-2",
			"terminal_capture",
			{ terminalId: "term" },
			availableTools,
		);
		expect(recapture.execute).toBe(true);
	});

	it("never deduplicates modifying or opaque commands merely because their text repeats", async () => {
		const policy = runtime();
		for (const id of ["write-1", "write-2"]) {
			const authorization = await policy.authorizeTool(
				id,
				"write",
				{ path: join(cwd, "same.txt"), content: "same" },
				availableTools,
			);
			expect(authorization.execute).toBe(true);
			await policy.finalizeTool({ toolCallId: id, toolName: "write", details: {}, isError: false });
		}
		for (const id of ["opaque-1", "opaque-2"]) {
			const authorization = await policy.authorizeTool(
				id,
				"bash",
				{ command: "mystery-command --maybe-side-effect" },
				availableTools,
			);
			expect(authorization.execute).toBe(true);
			await policy.finalizeTool({ toolCallId: id, toolName: "bash", details: {}, isError: false });
		}

		const changedParameters = runtime();
		await finish(changedParameters, {
			id: "failed-write",
			toolName: "write",
			args: { path: join(cwd, "same.txt"), content: "first" },
			isError: true,
		});
		const changed = await changedParameters.authorizeTool(
			"changed-write",
			"write",
			{ path: join(cwd, "same.txt"), content: "second" },
			availableTools,
		);
		expect(changed.execute).toBe(true);
	});

	it("tracks bounded terminal input so split commands cannot bypass Policy", async () => {
		const policy = runtime();
		const partial = await finish(policy, {
			id: "terminal-partial",
			toolName: "terminal_send",
			args: { terminalId: "term", input: "s" },
		});
		expect(partial?.status).toBe("succeeded");
		expect(partial?.terminalInputPending).toBe(true);
		const privileged = await finish(policy, {
			id: "terminal-privileged",
			toolName: "terminal_send",
			args: { terminalId: "term", input: "udo id\n" },
		});
		expect(privileged?.decision.action).toBe("block");

		const pending = await finish(policy, {
			id: "terminal-pending",
			toolName: "terminal_bash",
			args: { terminalId: "term", command: "pwd" },
		});
		expect(pending?.decision.action).toBe("pause");
		await finish(policy, {
			id: "terminal-cancel-line",
			toolName: "terminal_send",
			args: { terminalId: "term", input: "\u0003" },
		});
		const cleared = await policy.authorizeTool(
			"terminal-cleared",
			"terminal_bash",
			{ terminalId: "term", command: "pwd" },
			availableTools,
		);
		expect(cleared.execute).toBe(true);

		const manager = SessionManager.inMemory(cwd);
		manager.appendCustomEntry(POLICY_FACT_ENTRY_TYPE, attachPolicyToolDetails(undefined, partial!));
		const restored = runtime();
		restored.bindSession(manager.getSessionId(), manager.getBranch());
		const unknown = await finish(restored, {
			id: "restored-terminal-suffix",
			toolName: "terminal_send",
			args: { terminalId: "term", input: "udo id\n" },
		});
		expect(unknown?.decision.action).toBe("pause");
		expect(unknown?.decision.reason).toContain("restored terminal");
		const recovered = await finish(restored, {
			id: "restored-terminal-clear",
			toolName: "terminal_send",
			args: { terminalId: "term", input: "\u0003" },
		});
		expect(recovered?.terminalInputPending).toBe(false);
	});

	it("uses deterministic failure and fallback budgets across local, remote, and terminal commands", async () => {
		for (const scenario of [
			{ toolName: "bash", args: (command: string) => ({ command }) },
			{ toolName: "remote_exec", args: (command: string) => ({ command, targetId: "fake" }) },
			{ toolName: "terminal_bash", args: (command: string) => ({ command, terminalId: "term" }) },
		]) {
			const policy = runtime({ budget: { maxFallbackAttempts: 1, maxEquivalentFailures: 2 } });
			await finish(policy, {
				id: `${scenario.toolName}-failure`,
				toolName: scenario.toolName,
				args: scenario.args("first-command"),
				error: new BashToolExecutionError("exit 2", "command_exit", 2),
			});
			const paused = await finish(policy, {
				id: `${scenario.toolName}-fallback`,
				toolName: scenario.toolName,
				args: scenario.args("different-command"),
			});
			expect(paused?.decision.action, scenario.toolName).toBe("pause");
		}

		const sharedNetwork = runtime({ budget: { maxFallbackAttempts: 1, maxEquivalentFailures: 2 } });
		const local = await sharedNetwork.authorizeTool(
			"local-network",
			"bash",
			{ command: "curl https://example.com" },
			[],
		);
		expect(local.execute).toBe(true);
		await sharedNetwork.noteThrownError("local-network", "bash", new BashToolExecutionError("network", "network"));
		await sharedNetwork.finalizeTool({ toolCallId: "local-network", toolName: "bash", details: {}, isError: true });
		const terminal = await sharedNetwork.authorizeTool(
			"terminal-network",
			"terminal_bash",
			{ terminalId: "term", command: "wget https://example.com" },
			[],
		);
		expect(terminal.execute).toBe(false);
		expect(terminal.details?.decision.action).toBe("pause");
	});

	it("blocks Shell network fallback after dedicated Search failure and replaces it before any such failure", async () => {
		const initial = runtime();
		const replacement = await finish(initial, {
			id: "initial-curl",
			toolName: "bash",
			args: { command: "wget -qO- https://example.com" },
		});
		expect(replacement?.decision).toMatchObject({ action: "replace", replacementTool: "web_fetch" });

		const policy = runtime();
		const limits = resolvePolicyConfig(undefined).budget;
		const searchFailure = failedSearchDetails("not_configured");
		await finish(policy, {
			id: "search-failure",
			toolName: "web_search",
			args: { query: "docs" },
			details: searchFailure,
			isError: true,
		});
		for (const fallback of [
			{
				id: "curl-after-search",
				toolName: "bash",
				args: { command: "python -c \"import requests; requests.get('https://example.com')\"" },
			},
			{
				id: "terminal-curl-after-search",
				toolName: "terminal_send",
				args: { input: "curl https://example.com", terminalId: "term" },
			},
		]) {
			const paused = await finish(policy, fallback);
			expect(paused?.decision.action, fallback.id).toBe("pause");
			expect(paused?.decision.reason, fallback.id).toContain("web_search/web_fetch");
		}

		const split = runtime();
		await finish(split, {
			id: "split-search-failure",
			toolName: "web_search",
			args: { query: "docs" },
			details: failedSearchDetails("not_configured"),
			isError: true,
		});
		await finish(split, {
			id: "split-network-prefix",
			toolName: "terminal_send",
			args: { input: "cu", terminalId: "term" },
		});
		const splitPaused = await finish(split, {
			id: "split-network-suffix",
			toolName: "terminal_send",
			args: { input: "rl https://example.com\n", terminalId: "term" },
		});
		expect(splitPaused?.decision.action).toBe("pause");
		expect(limits.maxConfigurationFailures).toBeGreaterThan(0);
	});

	it("keeps target revisions monotonic when reads and mutations finish out of authorization order", async () => {
		const policy = runtime();
		const read = await policy.authorizeTool("concurrent-read", "read", { path: "README.md" }, availableTools);
		const write = await policy.authorizeTool(
			"concurrent-write",
			"write",
			{ path: join(cwd, "generated.txt"), content: "changed" },
			availableTools,
		);
		expect(read.execute).toBe(true);
		expect(write.execute).toBe(true);
		await policy.finalizeTool({ toolCallId: "concurrent-write", toolName: "write", details: {}, isError: false });
		await policy.finalizeTool({ toolCallId: "concurrent-read", toolName: "read", details: {}, isError: false });
		const refreshed = await policy.authorizeTool("refreshed-read", "read", { path: "README.md" }, availableTools);
		expect(refreshed.execute).toBe(true);
		await policy.finalizeTool({ toolCallId: "refreshed-read", toolName: "read", details: {}, isError: false });

		const firstWrite = await policy.authorizeTool(
			"write-a",
			"write",
			{ path: join(cwd, "a.txt"), content: "a" },
			availableTools,
		);
		const secondWrite = await policy.authorizeTool(
			"write-b",
			"write",
			{ path: join(cwd, "b.txt"), content: "b" },
			availableTools,
		);
		expect(firstWrite.execute).toBe(true);
		expect(secondWrite.execute).toBe(true);
		const firstFact = await policy.finalizeTool({
			toolCallId: "write-a",
			toolName: "write",
			details: {},
			isError: false,
		});
		const secondFact = await policy.finalizeTool({
			toolCallId: "write-b",
			toolName: "write",
			details: {},
			isError: false,
		});
		expect(firstFact?.targetRevisionAfter).toBe(2);
		expect(secondFact?.targetRevisionAfter).toBe(3);
	});

	it("does not consume ordinary failure budget for cancellation and serializes concurrent duplicates", async () => {
		const policy = runtime();
		const controller = new AbortController();
		controller.abort();
		const cancelled = await finish(policy, {
			id: "cancelled",
			toolName: "bash",
			args: { command: "unknown-check" },
			signal: controller.signal,
		});
		expect(cancelled?.failure?.category).toBe("user_cancelled");
		const cancelledConfirm = await finish(policy, {
			id: "cancelled-confirm",
			toolName: "read",
			args: { path: "/root/.ssh/id_ed25519" },
			signal: controller.signal,
		});
		expect(cancelledConfirm?.status).toBe("cancelled");
		expect(cancelledConfirm?.confirmation?.status).toBe("cancelled");
		const retry = await policy.authorizeTool("retry", "bash", { command: "unknown-check" }, availableTools);
		expect(retry.execute).toBe(true);
		await policy.finalizeTool({ toolCallId: "retry", toolName: "bash", details: {}, isError: false });

		const concurrent = runtime();
		const [first, second] = await Promise.all([
			concurrent.authorizeTool("concurrent-1", "read", { path: "README.md" }, availableTools),
			concurrent.authorizeTool("concurrent-2", "read", { path: "README.md" }, availableTools),
		]);
		expect([first.execute, second.execute].sort()).toEqual([false, true]);

		const repeatedId = runtime();
		const original = await repeatedId.authorizeTool("same-id", "read", { path: "README.md" }, availableTools);
		const collision = await repeatedId.authorizeTool("same-id", "read", { path: "other.md" }, availableTools);
		expect(original.execute).toBe(true);
		expect(collision.execute).toBe(false);
		await repeatedId.finalizeTool({
			toolCallId: "same-id",
			toolName: "read",
			details: attachPolicyToolDetails(undefined, collision.details!),
			isError: true,
		});
		const completed = await repeatedId.finalizeTool({
			toolCallId: "same-id",
			toolName: "read",
			details: {},
			isError: false,
		});
		expect(completed?.executed).toBe(true);
	});

	it("restores only current-branch facts and keeps them across compaction", async () => {
		const manager = SessionManager.inMemory(cwd);
		const root = manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "task" }],
			timestamp: 1,
		});
		manager.appendMessage(
			fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }, { id: "read-call" }), {
				stopReason: "toolUse",
			}),
		);
		const source = runtime();
		const fact = await finish(source, { id: "read-call", toolName: "read", args: { path: "README.md" } });
		expect(fact).toBeDefined();
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "read-call",
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			details: attachPolicyToolDetails(undefined, fact!),
			isError: false,
			timestamp: 3,
		});

		const restored = runtime();
		restored.bindSession(manager.getSessionId(), manager.getBranch());
		expect(restored.getFacts()).toHaveLength(1);
		manager.appendCompaction("summary", root, 100);
		restored.rebuild(manager.getBranch());
		expect(restored.getFacts()).toHaveLength(1);

		manager.branch(root);
		restored.rebuild(manager.getBranch());
		expect(restored.getFacts()).toHaveLength(0);
	});

	it("recovers Policy facts from a persisted session file", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-policy-session-"));
		try {
			const manager = SessionManager.create(root, join(root, "sessions"));
			manager.appendMessage({ role: "user", content: [{ type: "text", text: "task" }], timestamp: 1 });
			manager.appendMessage(
				fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }, { id: "persisted-read" }), {
					stopReason: "toolUse",
				}),
			);
			const source = new PolicyRuntime({ cwd: root, getConfig: () => resolvePolicyConfig(undefined) });
			source.bindSession(manager.getSessionId(), manager.getBranch());
			const fact = await finish(source, {
				id: "persisted-read",
				toolName: "read",
				args: { path: "README.md" },
			});
			manager.appendMessage({
				role: "toolResult",
				toolCallId: "persisted-read",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				details: attachPolicyToolDetails(undefined, fact!),
				isError: false,
				timestamp: 3,
			});
			const sessionFile = manager.getSessionFile();
			expect(sessionFile).toBeDefined();

			const reopened = SessionManager.open(sessionFile!);
			const restored = new PolicyRuntime({ cwd: root, getConfig: () => resolvePolicyConfig(undefined) });
			restored.bindSession(reopened.getSessionId(), reopened.getBranch());
			expect(restored.getFacts()).toHaveLength(1);
			const duplicate = await restored.authorizeTool("new-read", "read", { path: "README.md" }, availableTools);
			expect(duplicate.execute).toBe(false);
			expect(duplicate.details?.decision.action).toBe("block");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("classifies structured errors without persisting secrets", async () => {
		for (const scenario of [
			{
				expected: "missing_dependency",
				input: {
					toolName: "bash",
					details: {},
					isError: true,
					thrownError: Object.assign(new Error("missing"), { code: "ENOENT" }),
				},
			},
			{
				expected: "permission",
				input: {
					toolName: "bash",
					details: {},
					isError: true,
					thrownError: Object.assign(new Error("denied"), { code: "EACCES" }),
				},
			},
			{
				expected: "timeout",
				input: {
					toolName: "bash",
					details: {},
					isError: true,
					thrownError: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
				},
			},
			{
				expected: "network",
				input: {
					toolName: "bash",
					details: {},
					isError: true,
					thrownError: Object.assign(new Error("network"), { code: "ECONNREFUSED" }),
				},
			},
			{
				expected: "authentication",
				input: { toolName: "remote_exec", details: { diagnostic: { code: "ssh_authentication" } }, isError: true },
			},
			{
				expected: "session_lost",
				input: {
					toolName: "remote_exec",
					details: { diagnostic: { code: "terminal_session_lost" } },
					isError: true,
				},
			},
			{
				expected: "permission",
				input: { toolName: "remote_exec", details: { diagnostic: { code: "target_untrusted" } }, isError: true },
			},
			{
				expected: "configuration",
				input: { toolName: "remote_exec", details: { diagnostic: { code: "target_mismatch" } }, isError: true },
			},
			{
				expected: "missing_dependency",
				input: {
					toolName: "remote_exec",
					details: { diagnostic: { code: "remote_command", exitCode: 127 } },
					isError: true,
				},
			},
			{
				expected: "permission",
				input: {
					toolName: "remote_exec",
					details: { diagnostic: { code: "remote_command", exitCode: 126 } },
					isError: true,
				},
			},
			{
				expected: "rate_limit",
				input: { toolName: "web_search", details: failedSearchDetails("rate_limited"), isError: true },
			},
			{
				expected: "budget_exhausted",
				input: { toolName: "web_search", details: failedSearchDetails("budget_exhausted"), isError: true },
			},
			{
				expected: "configuration",
				input: { toolName: "web_search", details: failedSearchDetails("not_configured"), isError: true },
			},
		] as const) {
			expect(classifyPolicyFailure(scenario.input)?.category, scenario.expected).toBe(scenario.expected);
		}

		const secret = "super-secret-token";
		const policy = runtime({
			handler: async () => ({ status: "error", diagnostic: `failed with ${secret}` }),
		});
		const replaced = await finish(policy, {
			id: "secret",
			toolName: "bash",
			args: { command: `curl -H 'Authorization: Bearer ${secret}' https://example.com` },
		});
		expect(JSON.stringify(replaced)).not.toContain(secret);
		expect(getPolicyToolDetails(attachPolicyToolDetails(undefined, replaced!))?.requestId).toBe(replaced?.requestId);

		const confirmed = await finish(policy, {
			id: "secret-diagnostic",
			toolName: "read",
			args: { path: "/root/.ssh/id_ed25519" },
		});
		expect(JSON.stringify(confirmed)).not.toContain(secret);
		expect(confirmed?.confirmation?.diagnostic).toBe("Policy interaction handler failed");
	});
});
