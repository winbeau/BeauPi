export interface TerminalProcessOptions {
	onData?: (data: Buffer) => void;
	signal?: AbortSignal;
	timeoutMs?: number;
	stdin?: Buffer;
}

export interface TerminalProcessResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	startedAt: number;
	completedAt: number;
}

export interface TerminalPaneStatus {
	exists: boolean;
	paneId?: string;
	currentCommand?: string;
	cursorY?: number;
	dead?: boolean;
	exitCode?: number;
}

export class TerminalTransportError extends Error {
	readonly operation: string;
	readonly exitCode?: number | null;

	constructor(operation: string, message: string, exitCode?: number | null) {
		super(message);
		this.name = "TerminalTransportError";
		this.operation = operation;
		this.exitCode = exitCode;
	}
}
