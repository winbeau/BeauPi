import type {
	PrivilegeCommandResultV1,
	PrivilegeCommandSession,
	PrivilegeRequestV1,
	PrivilegeTerminalAdapter,
	PrivilegeTerminalFrameV1,
} from "./types.ts";

export class FakePrivilegeTerminalAdapter implements PrivilegeTerminalAdapter {
	private result: PrivilegeCommandResultV1 = {
		output: "ok\n",
		exitCode: 0,
		startedAt: 1,
		completedAt: 2,
	};
	private frame: PrivilegeTerminalFrameV1 = { content: "Password: ", state: "authenticating" };
	private readonly receivedInput: Buffer[] = [];
	private waitPending = false;
	createCalls = 0;
	startCalls = 0;
	executeCalls = 0;
	cancelCalls = 0;
	resizeCalls: Array<{ columns: number; rows: number }> = [];
	requests: PrivilegeRequestV1[] = [];

	setResult(result: Partial<PrivilegeCommandResultV1>): void {
		this.result = { ...this.result, ...result };
	}

	setFrame(frame: PrivilegeTerminalFrameV1): void {
		this.frame = structuredClone(frame);
	}

	setWaitPending(pending: boolean): void {
		this.waitPending = pending;
	}

	getReceivedInputForTest(): Buffer {
		return Buffer.concat(this.receivedInput.map((value) => Buffer.from(value)));
	}

	async create(request: PrivilegeRequestV1, signal?: AbortSignal): Promise<PrivilegeCommandSession> {
		this.createCalls++;
		this.requests.push(structuredClone(request));
		let started = false;
		let executed = false;
		let cancelled = false;
		let resolveWait: ((result: PrivilegeCommandResultV1) => void) | undefined;
		const pendingWait = new Promise<PrivilegeCommandResultV1>((resolve) => {
			resolveWait = resolve;
		});
		const cancelledResult = (): PrivilegeCommandResultV1 => ({
			...this.result,
			exitCode: null,
			cancelled: true,
			completedAt: Math.max(this.result.startedAt, this.result.completedAt),
		});
		const cancel = async (): Promise<void> => {
			if (cancelled) return;
			cancelled = true;
			this.cancelCalls++;
			resolveWait?.(cancelledResult());
		};
		const onAbort = (): void => {
			void cancel();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		return {
			start: async () => {
				if (started) throw new Error("Fake privilege session already started");
				started = true;
				this.startCalls++;
			},
			execute: async () => {
				if (!started || executed) throw new Error("Fake privilege session is not waiting for execution");
				executed = true;
				this.executeCalls++;
			},
			sendSensitive: async (input) => {
				if (!executed) throw new Error("Fake privilege session has not started");
				this.receivedInput.push(Buffer.from(input));
			},
			capture: async () =>
				structuredClone(
					cancelled
						? { content: "", state: "complete" as const }
						: executed
							? this.frame
							: { content: `$ ${request.command}`, state: "waiting_for_user" as const },
				),
			resize: async (columns, rows) => {
				this.resizeCalls.push({ columns, rows });
			},
			cancel,
			wait: async (onOutput) => {
				if (!executed) throw new Error("Fake privilege session has not started");
				if (cancelled) return cancelledResult();
				if (!this.waitPending) onOutput?.(this.result.output);
				return this.waitPending ? pendingWait : structuredClone(this.result);
			},
			dispose: async () => {
				signal?.removeEventListener("abort", onAbort);
			},
		};
	}
}
