import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	AgentProtocolError,
	ContentLengthFrameParser,
	decodeJsonFrame,
	encodeJsonFrame,
	FrameWriter,
} from "../src/core/remote-agent/index.ts";

function split(buffer: Buffer, sizes: number[]): Buffer[] {
	const chunks: Buffer[] = [];
	let offset = 0;
	for (const size of sizes) {
		chunks.push(buffer.subarray(offset, offset + size));
		offset += size;
	}
	if (offset < buffer.length) chunks.push(buffer.subarray(offset));
	return chunks;
}

describe("Remote Agent Content-Length framing", () => {
	it("reassembles split and coalesced JSON frames", () => {
		const first = encodeJsonFrame({
			version: 1,
			type: "request",
			requestId: "a",
			method: "system.ping",
			payload: {},
		});
		const second = encodeJsonFrame({
			version: 1,
			type: "request",
			requestId: "b",
			method: "system.ping",
			payload: {},
		});
		const parser = new ContentLengthFrameParser();
		const frames = split(Buffer.concat([first, second]), [1, 2, 3, 5, 8, 13]).flatMap((chunk) => parser.push(chunk));
		expect(frames).toEqual([
			first.subarray(first.indexOf(Buffer.from("\r\n\r\n")) + 4),
			second.subarray(second.indexOf(Buffer.from("\r\n\r\n")) + 4),
		]);
	});

	it("rejects duplicate, missing, zero, and oversized lengths", () => {
		for (const header of [
			"Content-Length: 1\r\nContent-Length: 1\r\n\r\na",
			"X-Test: 1\r\n\r\na",
			"Content-Length: 0\r\n\r\n",
			`Content-Length: ${1024 * 1024 + 1}\r\n\r\n`,
		]) {
			expect(() => new ContentLengthFrameParser().push(Buffer.from(header))).toThrow(AgentProtocolError);
		}
	});

	it("serializes concurrent writes and honors the writable callback", async () => {
		const stream = new PassThrough();
		const chunks: Buffer[] = [];
		stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
		const writer = new FrameWriter(stream);
		await Promise.all([
			writer.write({ version: 1, type: "response", requestId: "one", ok: true }),
			writer.write({ version: 1, type: "response", requestId: "two", ok: true }),
		]);
		const parser = new ContentLengthFrameParser();
		const frames = chunks.flatMap((chunk) => parser.push(chunk));
		expect(frames).toHaveLength(2);
		expect(frames.map((frame) => JSON.parse(frame.toString("utf8")).requestId)).toEqual(["one", "two"]);
	});

	it("rejects invalid UTF-8 and truncated EOF", () => {
		expect(() => decodeJsonFrame(Buffer.from([0xff]))).toThrow(AgentProtocolError);
		const parser = new ContentLengthFrameParser();
		parser.push(Buffer.from("Content-Length: 2\r\n\r\n{", "ascii"));
		expect(() => parser.end()).toThrow(AgentProtocolError);
	});
});
