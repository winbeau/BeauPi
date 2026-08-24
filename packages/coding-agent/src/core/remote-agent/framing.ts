import type { Writable } from "node:stream";
import {
	AgentProtocolError,
	isRecord,
	REMOTE_AGENT_MAX_FRAME_BYTES,
	REMOTE_AGENT_MAX_HEADER_BYTES,
} from "./protocol.ts";

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "ascii");

export class ContentLengthFrameParser {
	private buffer = Buffer.alloc(0);

	push(chunk: Buffer | Uint8Array | string): Buffer[] {
		const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		if (next.length > 0) this.buffer = Buffer.concat([this.buffer, next]);
		const frames: Buffer[] = [];
		while (true) {
			const separatorIndex = this.buffer.indexOf(HEADER_SEPARATOR);
			if (separatorIndex < 0) {
				if (this.buffer.length > REMOTE_AGENT_MAX_HEADER_BYTES) {
					throw new AgentProtocolError("agent_protocol", "Content-Length header exceeds the size limit");
				}
				break;
			}
			const headerLength = separatorIndex + HEADER_SEPARATOR.length;
			if (headerLength > REMOTE_AGENT_MAX_HEADER_BYTES) {
				throw new AgentProtocolError("agent_protocol", "Content-Length header exceeds the size limit");
			}
			const header = this.buffer.subarray(0, separatorIndex);
			for (const byte of header) {
				if (byte > 0x7f) throw new AgentProtocolError("agent_protocol", "Content-Length header must be ASCII");
			}
			const length = parseContentLength(header.toString("ascii"));
			if (this.buffer.length < headerLength + length) break;
			frames.push(Buffer.from(this.buffer.subarray(headerLength, headerLength + length)));
			this.buffer = this.buffer.subarray(headerLength + length);
		}
		return frames;
	}

	end(): void {
		if (this.buffer.length > 0)
			throw new AgentProtocolError("agent_protocol", "Connection ended in the middle of a frame");
	}

	get bufferedBytes(): number {
		return this.buffer.length;
	}
}

export function parseContentLength(header: string): number {
	const lines = header.split("\r\n");
	let length: number | undefined;
	for (const line of lines) {
		if (!line) continue;
		const separator = line.indexOf(":");
		if (separator < 0) throw new AgentProtocolError("agent_protocol", "Malformed Content-Length header");
		const name = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();
		if (name !== "content-length") throw new AgentProtocolError("agent_protocol", "Unexpected frame header");
		if (length !== undefined) throw new AgentProtocolError("agent_protocol", "Duplicate Content-Length header");
		if (!/^[1-9][0-9]*$/.test(value))
			throw new AgentProtocolError("agent_protocol", "Content-Length must be a positive decimal integer");
		const parsed = Number(value);
		if (!Number.isSafeInteger(parsed) || parsed > REMOTE_AGENT_MAX_FRAME_BYTES)
			throw new AgentProtocolError("agent_protocol", "Frame exceeds the size limit");
		length = parsed;
	}
	if (length === undefined) throw new AgentProtocolError("agent_protocol", "Missing Content-Length header");
	return length;
}

export function encodeContentLengthFrame(payload: Buffer | Uint8Array | string): Buffer {
	const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
	if (body.length === 0) throw new AgentProtocolError("agent_protocol", "Frame payload cannot be empty");
	if (body.length > REMOTE_AGENT_MAX_FRAME_BYTES)
		throw new AgentProtocolError("agent_protocol", "Frame exceeds the size limit");
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

export function encodeJsonFrame(value: unknown): Buffer {
	if (!isRecord(value)) throw new AgentProtocolError("agent_protocol", "Framed JSON payload must be an object");
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch {
		throw new AgentProtocolError("agent_protocol", "Framed JSON payload is not serializable");
	}
	return encodeContentLengthFrame(Buffer.from(json, "utf8"));
}

export function decodeJsonFrame(frame: Buffer): unknown {
	let json: string;
	try {
		json = new TextDecoder("utf-8", { fatal: true }).decode(frame);
	} catch {
		throw new AgentProtocolError("agent_protocol", "Frame payload is not valid UTF-8");
	}
	try {
		return JSON.parse(json) as unknown;
	} catch {
		throw new AgentProtocolError("agent_protocol", "Frame payload is not valid JSON");
	}
}

export class FrameWriter {
	private queue: Promise<void> = Promise.resolve();
	private closed = false;
	private readonly stream: Writable;

	constructor(stream: Writable) {
		this.stream = stream;
	}

	write(value: unknown, onWriteStart?: () => void): Promise<void> {
		if (this.closed)
			return Promise.reject(
				new AgentProtocolError("agent_disconnected", "Frame writer is closed", { retryable: true }),
			);
		const frame = encodeJsonFrame(value);
		const task = this.queue.then(() => {
			onWriteStart?.();
			return this.writeFrame(frame);
		});
		this.queue = task.catch(() => undefined);
		return task;
	}

	async flush(): Promise<void> {
		await this.queue;
	}

	close(): void {
		this.closed = true;
	}

	private writeFrame(frame: Buffer): Promise<void> {
		return new Promise((resolve, reject) => {
			let callbackComplete = false;
			let drainComplete = false;
			let settled = false;
			const cleanup = (): void => {
				this.stream.removeListener("drain", onDrain);
				this.stream.removeListener("error", onError);
			};
			const finish = (error?: Error): void => {
				if (settled) return;
				if (error) {
					settled = true;
					cleanup();
					reject(error);
					return;
				}
				if (!callbackComplete || !drainComplete) return;
				settled = true;
				cleanup();
				resolve();
			};
			const onDrain = (): void => {
				drainComplete = true;
				finish();
			};
			const onError = (error: Error): void => finish(error);
			this.stream.once("error", onError);
			this.stream.once("drain", onDrain);
			try {
				const accepted = this.stream.write(frame, (error?: Error | null) => {
					if (error) {
						finish(error);
						return;
					}
					callbackComplete = true;
					finish();
				});
				if (accepted) {
					drainComplete = true;
					this.stream.removeListener("drain", onDrain);
				}
				finish();
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}
}

export { ContentLengthFrameParser as FrameParser, encodeContentLengthFrame as encodeFrame };
