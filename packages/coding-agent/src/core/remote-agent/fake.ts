import { PassThrough } from "node:stream";
import type { RemoteAgentTransport } from "./ssh-transport.ts";

export interface FakeRemoteAgentTransportPair {
	client: RemoteAgentTransport & { disconnect(): void };
	serverInput: PassThrough;
	serverOutput: PassThrough;
}

export class FakeRemoteAgentTransport implements RemoteAgentTransport {
	readonly stdin: PassThrough;
	readonly stdout: PassThrough;
	readonly stderr: PassThrough;
	readonly serverInput: PassThrough;
	readonly serverOutput: PassThrough;
	private closed = false;

	constructor(serverInput = new PassThrough(), serverOutput = new PassThrough()) {
		this.serverInput = serverInput;
		this.serverOutput = serverOutput;
		this.stdin = serverInput;
		this.stdout = serverOutput;
		this.stderr = new PassThrough();
	}

	close(): Promise<void> {
		if (!this.closed) {
			this.closed = true;
			this.stdin.end();
			this.stdout.end();
			this.stderr.end();
		}
		return Promise.resolve();
	}

	disconnect(): void {
		if (this.closed) return;
		this.closed = true;
		const error = new Error("fake transport disconnected");
		this.stdin.destroy(error);
		this.stdout.destroy(error);
		this.stderr.destroy();
	}
}

export function createFakeRemoteAgentTransportPair(): FakeRemoteAgentTransportPair {
	const transport = new FakeRemoteAgentTransport();
	return { client: transport, serverInput: transport.serverInput, serverOutput: transport.serverOutput };
}
