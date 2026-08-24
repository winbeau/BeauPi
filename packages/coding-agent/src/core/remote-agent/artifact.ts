import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AgentProtocolError,
	REMOTE_AGENT_MIN_NODE_VERSION,
	REMOTE_AGENT_PROTOCOL_NAME,
	REMOTE_AGENT_PROTOCOL_VERSION,
} from "./protocol.ts";

export interface RemoteAgentManifestV1 {
	version: 1;
	protocolVersion: typeof REMOTE_AGENT_PROTOCOL_VERSION;
	agentVersion: string;
	minimumNodeVersion: typeof REMOTE_AGENT_MIN_NODE_VERSION;
	file: "beaupi-agent.mjs";
	sha256: string;
	bytes: number;
}

export interface RemoteAgentArtifact {
	sourcePath: string;
	manifest: RemoteAgentManifestV1;
	bytes: Buffer;
}

export interface RemoteAgentArtifactProvider {
	load(): Promise<RemoteAgentArtifact>;
}

export function sha256Bytes(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function manifestForBytes(bytes: Buffer, agentVersion: string): RemoteAgentManifestV1 {
	return {
		version: 1,
		protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
		agentVersion,
		minimumNodeVersion: REMOTE_AGENT_MIN_NODE_VERSION,
		file: "beaupi-agent.mjs",
		sha256: sha256Bytes(bytes),
		bytes: bytes.length,
	};
}

function validateManifest(value: unknown): RemoteAgentManifestV1 {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new AgentProtocolError("agent_artifact", "Agent manifest must be an object");
	const record = value as Record<string, unknown>;
	const expectedKeys = ["version", "protocolVersion", "agentVersion", "minimumNodeVersion", "file", "sha256", "bytes"];
	if (Object.keys(record).some((key) => !expectedKeys.includes(key)) || expectedKeys.some((key) => !(key in record)))
		throw new AgentProtocolError("agent_artifact", "Agent manifest contains an unknown or missing field");
	if (
		record.version !== 1 ||
		record.protocolVersion !== REMOTE_AGENT_PROTOCOL_VERSION ||
		record.file !== "beaupi-agent.mjs"
	)
		throw new AgentProtocolError("agent_artifact", "Agent manifest version is unsupported");
	if (typeof record.agentVersion !== "string" || record.agentVersion.length === 0 || record.agentVersion.length > 128)
		throw new AgentProtocolError("agent_artifact", "Agent manifest agentVersion is invalid");
	if (record.minimumNodeVersion !== REMOTE_AGENT_MIN_NODE_VERSION)
		throw new AgentProtocolError("agent_artifact", "Agent manifest minimum Node version is unsupported");
	if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256))
		throw new AgentProtocolError("agent_artifact", "Agent manifest SHA-256 is invalid");
	if (typeof record.bytes !== "number" || !Number.isSafeInteger(record.bytes) || record.bytes <= 0)
		throw new AgentProtocolError("agent_artifact", "Agent manifest byte count is invalid");
	return {
		version: 1,
		protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
		agentVersion: record.agentVersion,
		minimumNodeVersion: REMOTE_AGENT_MIN_NODE_VERSION,
		file: "beaupi-agent.mjs",
		sha256: record.sha256,
		bytes: record.bytes,
	};
}

export function validateRemoteAgentArtifact(artifact: RemoteAgentArtifact): RemoteAgentArtifact {
	const manifest = validateManifest(artifact.manifest);
	if (artifact.bytes.length !== manifest.bytes)
		throw new AgentProtocolError("agent_artifact", "Agent artifact byte count does not match manifest");
	if (sha256Bytes(artifact.bytes) !== manifest.sha256)
		throw new AgentProtocolError("agent_artifact", "Agent artifact hash does not match manifest");
	return { sourcePath: artifact.sourcePath, manifest, bytes: Buffer.from(artifact.bytes) };
}

export async function loadRemoteAgentArtifact(directory: string): Promise<RemoteAgentArtifact> {
	const artifactPath = join(directory, "beaupi-agent.mjs");
	const manifestPath = join(directory, "manifest.json");
	let bytes: Buffer;
	let manifestValue: unknown;
	try {
		[bytes, manifestValue] = await Promise.all([
			readFile(artifactPath),
			readFile(manifestPath, "utf8").then((value) => JSON.parse(value) as unknown),
		]);
	} catch (error) {
		throw new AgentProtocolError(
			"agent_artifact_missing",
			error instanceof Error ? error.message : "Agent artifact is unavailable",
			{ retryable: false },
		);
	}
	return validateRemoteAgentArtifact({ sourcePath: artifactPath, manifest: validateManifest(manifestValue), bytes });
}

export class FileRemoteAgentArtifactProvider implements RemoteAgentArtifactProvider {
	private readonly directory: string;

	constructor(directory: string) {
		this.directory = directory;
	}

	load(): Promise<RemoteAgentArtifact> {
		return loadRemoteAgentArtifact(this.directory);
	}
}

export class MemoryRemoteAgentArtifactProvider implements RemoteAgentArtifactProvider {
	private readonly artifact: RemoteAgentArtifact;

	constructor(bytes: Buffer, agentVersion = "test") {
		this.artifact = validateRemoteAgentArtifact({
			sourcePath: "memory:beaupi-agent.mjs",
			manifest: manifestForBytes(bytes, agentVersion),
			bytes,
		});
	}

	load(): Promise<RemoteAgentArtifact> {
		return Promise.resolve({ ...this.artifact, bytes: Buffer.from(this.artifact.bytes) });
	}
}

export function defaultRemoteAgentArtifactDirectory(): string {
	return join(dirname(process.execPath), "remote-agent");
}

export function remoteAgentArtifactDirectories(): string[] {
	const executableDirectory = dirname(process.execPath);
	const moduleDirectory = dirname(fileURLToPath(import.meta.url));
	return [
		join(executableDirectory, "remote-agent"),
		join(moduleDirectory, "..", "remote-agent"),
		join(moduleDirectory, "..", "..", "remote-agent"),
		join(packageDirectoryFallback(moduleDirectory), "dist", "remote-agent"),
	];
}

function packageDirectoryFallback(moduleDirectory: string): string {
	return dirname(dirname(dirname(moduleDirectory)));
}

export function createDefaultRemoteAgentArtifactProvider(): RemoteAgentArtifactProvider {
	return {
		async load() {
			let lastError: unknown;
			for (const directory of remoteAgentArtifactDirectories()) {
				try {
					return await loadRemoteAgentArtifact(directory);
				} catch (error) {
					lastError = error;
				}
			}
			throw lastError instanceof Error
				? lastError
				: new AgentProtocolError("agent_artifact_missing", "No packaged Remote Agent artifact was found");
		},
	};
}

export { REMOTE_AGENT_PROTOCOL_NAME };
