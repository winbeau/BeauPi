import { shellQuote } from "../remote/openssh-runner.ts";
import {
	type ExecutionTargetConfig,
	type RemoteCommandOptions,
	type RemoteCommandResult,
	RemoteExecutionError,
} from "../remote/types.ts";
import type { RemoteAgentArtifact, RemoteAgentArtifactProvider } from "./artifact.ts";
import { AgentProtocolError, isSupportedNodeVersion } from "./protocol.ts";
import { agentLaunchCommand, OpenSshCommandRunner } from "./ssh-transport.ts";

export interface RemoteAgentProbeResult {
	platform: string;
	arch: string;
	nodeVersion: string;
	homeDir: string;
	artifactPath: string;
	artifactPresent: boolean;
	artifactSha256?: string;
	artifactBytes?: number;
	artifactSymlink: boolean;
	manifestPresent: boolean;
	manifestValid: boolean;
	manifestSymlink: boolean;
}

export interface RemoteAgentBootstrapResult {
	artifact: RemoteAgentArtifact;
	probe: RemoteAgentProbeResult;
	remoteArtifactPath: string;
	controlPath: string;
	runner: OpenSshCommandRunner;
}

export interface RemoteAgentBootstrapRunner {
	run(command: string, options?: RemoteCommandOptions & { stdin?: Buffer }): Promise<RemoteCommandResult>;
}

const PROBE_SCRIPT = `
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const digest = process.argv[1];
const homeDir = os.homedir();
const artifactPath = path.join(homeDir, '.beaupi', 'server', 'v1', digest, 'beaupi-agent.mjs');
const manifestPath = path.join(homeDir, '.beaupi', 'server', 'v1', digest, 'manifest.json');
const result = { platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, homeDir, artifactPath, artifactPresent: false, artifactSymlink: false, manifestPresent: false, manifestValid: false, manifestSymlink: false };
let currentPath = homeDir;
let parentSymlink = false;
for (const part of ['.beaupi', 'server', 'v1', digest]) {
  currentPath = path.join(currentPath, part);
  try {
    const stat = fs.lstatSync(currentPath);
    if (stat.isSymbolicLink()) { parentSymlink = true; break; }
  } catch (error) {
    if (error && error.code !== 'ENOENT') result.error = String(error.message || error);
    break;
  }
}
if (parentSymlink) {
  result.artifactPresent = true;
  result.artifactSymlink = true;
  result.manifestPresent = true;
  result.manifestSymlink = true;
} else {
  try {
    const stat = fs.lstatSync(artifactPath);
    result.artifactPresent = true;
    result.artifactSymlink = stat.isSymbolicLink();
    if (stat.isFile() && !result.artifactSymlink) {
      const bytes = fs.readFileSync(artifactPath);
      result.artifactBytes = bytes.length;
      result.artifactSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') result.error = String(error.message || error);
  }
  try {
    const manifestStat = fs.lstatSync(manifestPath);
    result.manifestPresent = true;
    result.manifestSymlink = manifestStat.isSymbolicLink();
    if (manifestStat.isFile() && !result.manifestSymlink) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      result.manifestValid = manifest && manifest.version === 1 && manifest.protocolVersion === 1 && manifest.file === 'beaupi-agent.mjs' && manifest.sha256 === digest && manifest.bytes === result.artifactBytes;
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') result.error = String(error.message || error);
  }
}
process.stdout.write(JSON.stringify(result));
`;

const INSTALL_SCRIPT = `
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const digest = process.argv[1];
const expectedBytes = Number(process.argv[2]);
const manifest = Buffer.from(process.argv[3], 'base64').toString('utf8');
const root = path.join(os.homedir(), '.beaupi');
const v1 = path.join(root, 'server', 'v1');
const digestDir = path.join(v1, digest);
const artifactPath = path.join(digestDir, 'beaupi-agent.mjs');
const manifestPath = path.join(digestDir, 'manifest.json');
const safeError = (code, message) => { const error = new Error(message); error.code = code; return error; };
const ensureDir = async (directory) => {
  try {
    const stat = await fsp.lstat(directory);
    if (stat.isSymbolicLink()) throw safeError('agent_install_symlink', 'installation path contains a symlink');
    if (!stat.isDirectory()) throw safeError('agent_install', 'installation path is not a directory');
    await fsp.chmod(directory, 0o700);
  } catch (error) {
    if (error && error.code !== 'ENOENT' && error.code !== 'EEXIST') throw error;
    if (error && error.code === 'EEXIST') {
      const existing = await fsp.lstat(directory);
      if (existing.isSymbolicLink() || !existing.isDirectory()) throw safeError('agent_install_symlink', 'installation path is not a private directory');
      await fsp.chmod(directory, 0o700);
      return;
    }
    await fsp.mkdir(directory, { recursive: false, mode: 0o700 });
    const stat = await fsp.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw safeError('agent_install_symlink', 'installation path is not a private directory');
  }
};
const verifyArtifact = async () => {
  try {
    const stat = await fsp.lstat(artifactPath);
    if (stat.isSymbolicLink()) throw safeError('agent_install_symlink', 'artifact is a symlink');
    if (!stat.isFile()) throw safeError('agent_install', 'artifact is not a regular file');
    const bytes = await fsp.readFile(artifactPath);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (hash !== digest || bytes.length !== expectedBytes) throw safeError('agent_install_hash', 'existing artifact does not match the expected digest');
    return bytes;
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    throw error;
  }
};
const atomicCreate = async (destination, bytes, mode) => {
  try {
    const stat = await fsp.lstat(destination);
    if (stat.isSymbolicLink()) throw safeError('agent_install_symlink', 'destination is a symlink');
    if (!stat.isFile()) throw safeError('agent_install', 'destination is not a regular file');
    const existing = await fsp.readFile(destination);
    if (!existing.equals(bytes)) throw safeError('agent_install_hash', 'existing file does not match the expected content');
    return 'reused';
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(path.dirname(destination), '.' + path.basename(destination) + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
  try {
    const handle = await fsp.open(temporary, 'wx', mode);
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    await fsp.chmod(temporary, mode);
    try {
      await fsp.link(temporary, destination);
      return 'installed';
    } catch (error) {
      if (error && error.code !== 'EEXIST') throw error;
      const existing = await fsp.readFile(destination);
      if (!existing.equals(bytes)) throw safeError('agent_install_hash', 'concurrent artifact differs from expected content');
      return 'reused';
    }
  } finally {
    await fsp.rm(temporary, { force: true });
  }
};
const readInput = () => new Promise((resolve, reject) => {
  const chunks = [];
  let total = 0;
  process.stdin.on('data', chunk => { total += chunk.length; if (total > expectedBytes) { reject(safeError('agent_install_size', 'uploaded artifact is larger than the manifest')); process.stdin.destroy(); return; } chunks.push(chunk); });
  process.stdin.on('error', reject);
  process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
});
(async () => {
  process.umask(0o077);
  await ensureDir(root);
  await ensureDir(path.join(root, 'server'));
  await ensureDir(v1);
  await ensureDir(digestDir);
  const existing = await verifyArtifact();
  let status = 'reused';
  if (!existing) {
    const bytes = await readInput();
    if (bytes.length !== expectedBytes) throw safeError('agent_install_size', 'uploaded artifact byte count does not match the manifest');
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (hash !== digest) throw safeError('agent_install_hash', 'uploaded artifact hash does not match the expected digest');
    status = await atomicCreate(artifactPath, bytes, 0o600);
  }
  const manifestBytes = Buffer.from(manifest, 'utf8');
  await atomicCreate(manifestPath, manifestBytes, 0o600);
  const finalBytes = await verifyArtifact();
  if (!finalBytes) throw safeError('agent_install', 'artifact disappeared after installation');
  process.stdout.write(JSON.stringify({ status, artifactPath, manifestPath, bytes: finalBytes.length, sha256: digest }));
})().catch(error => { const code = error && (error.code === 'EACCES' || error.code === 'EPERM') ? 'agent_install_permission' : (error.code || 'agent_install'); process.stdout.write(JSON.stringify({ error: { code, message: String(error.message || error).slice(0, 500) } })); process.exitCode = 42; });
`;

function parseJsonResult(stdout: string, label: string): Record<string, unknown> {
	const trimmed = stdout.trim();
	if (!trimmed) throw new AgentProtocolError("agent_probe_failed", `${label} returned no JSON`);
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length === 0)
			throw new Error("not an object");
		return parsed as Record<string, unknown>;
	} catch {
		throw new AgentProtocolError("agent_probe_failed", `${label} returned malformed JSON`);
	}
}

function parseProbe(stdout: string): RemoteAgentProbeResult {
	const result = parseJsonResult(stdout, "Node probe");
	if (
		typeof result.platform !== "string" ||
		typeof result.arch !== "string" ||
		typeof result.nodeVersion !== "string" ||
		typeof result.homeDir !== "string" ||
		typeof result.artifactPath !== "string" ||
		typeof result.artifactPresent !== "boolean" ||
		typeof result.artifactSymlink !== "boolean" ||
		typeof result.manifestPresent !== "boolean" ||
		typeof result.manifestValid !== "boolean" ||
		typeof result.manifestSymlink !== "boolean"
	)
		throw new AgentProtocolError("agent_probe_failed", "Node probe omitted required fields");
	return {
		platform: result.platform,
		arch: result.arch,
		nodeVersion: result.nodeVersion,
		homeDir: result.homeDir,
		artifactPath: result.artifactPath,
		artifactPresent: result.artifactPresent,
		artifactSymlink: result.artifactSymlink,
		manifestPresent: result.manifestPresent,
		manifestValid: result.manifestValid,
		manifestSymlink: result.manifestSymlink,
		...(typeof result.artifactSha256 === "string" ? { artifactSha256: result.artifactSha256 } : {}),
		...(typeof result.artifactBytes === "number" ? { artifactBytes: result.artifactBytes } : {}),
	};
}

function parseInstall(stdout: string): { artifactPath: string; sha256: string; bytes: number } {
	const result = parseJsonResult(stdout, "Agent install");
	if (result.error && typeof result.error === "object" && result.error !== null) {
		const error = result.error as Record<string, unknown>;
		throw new AgentProtocolError(
			typeof error.code === "string" ? error.code : "agent_install",
			typeof error.message === "string" ? error.message : "Agent installation failed",
		);
	}
	if (typeof result.artifactPath !== "string" || typeof result.sha256 !== "string" || typeof result.bytes !== "number")
		throw new AgentProtocolError("agent_install", "Agent install returned malformed JSON");
	return { artifactPath: result.artifactPath, sha256: result.sha256, bytes: result.bytes };
}

export class RemoteAgentBootstrapper {
	private readonly artifactProvider: RemoteAgentArtifactProvider;

	constructor(artifactProvider: RemoteAgentArtifactProvider) {
		this.artifactProvider = artifactProvider;
	}

	async prepare(target: ExecutionTargetConfig, signal?: AbortSignal): Promise<RemoteAgentBootstrapResult> {
		const artifact = await this.artifactProvider.load();
		const runner = new OpenSshCommandRunner(target);
		const probeCommand = `node -e ${shellQuote(PROBE_SCRIPT)} ${shellQuote(artifact.manifest.sha256)}`;
		const probeResult = await runner.run(probeCommand, { signal, timeoutMs: target.connectTimeoutMs ?? 15_000 });
		if (probeResult.exitCode !== 0) {
			const message = safeRemoteText(probeResult.stderr || probeResult.stdout);
			if (probeResult.exitCode === 255) throw sshBootstrapFailure(target.id, message);
			const code = /not found|command not found|no such file or directory/i.test(message)
				? "agent_node_unavailable"
				: "agent_probe_failed";
			throw new AgentProtocolError(code, `Remote Node probe failed: ${message}`);
		}
		const probe = parseProbe(probeResult.stdout);
		if (probe.platform !== "linux")
			throw new AgentProtocolError(
				"agent_node_unavailable",
				`Remote Agent MVP supports Linux only, got ${probe.platform}`,
			);
		if (!isSupportedNodeVersion(probe.nodeVersion))
			throw new AgentProtocolError(
				"agent_node_version",
				`Remote Node ${probe.nodeVersion} is below the required ${artifact.manifest.minimumNodeVersion}`,
			);
		if (probe.artifactSymlink || probe.manifestSymlink)
			throw new AgentProtocolError("agent_install_symlink", "Remote Agent installation path is a symlink");
		if (
			!probe.artifactPresent ||
			probe.artifactSha256 !== artifact.manifest.sha256 ||
			probe.artifactBytes !== artifact.manifest.bytes ||
			!probe.manifestValid
		) {
			const manifest = Buffer.from(`${JSON.stringify(artifact.manifest)}\n`, "utf8");
			const installCommand = `node -e ${shellQuote(INSTALL_SCRIPT)} ${shellQuote(artifact.manifest.sha256)} ${artifact.manifest.bytes} ${shellQuote(manifest.toString("base64"))}`;
			const installResult = await runner.run(installCommand, {
				signal,
				timeoutMs: Math.max(target.connectTimeoutMs ?? 15_000, 30_000),
				stdin: artifact.bytes,
			});
			if (installResult.exitCode === 255)
				throw sshBootstrapFailure(target.id, safeRemoteText(installResult.stderr || installResult.stdout));
			if (installResult.exitCode !== 0) parseInstall(installResult.stdout);
			const installed = parseInstall(installResult.stdout);
			if (installed.sha256 !== artifact.manifest.sha256 || installed.bytes !== artifact.manifest.bytes)
				throw new AgentProtocolError(
					"agent_install_hash",
					"Remote Agent install returned mismatched artifact facts",
				);
		}
		const remoteArtifactPath = `${probe.homeDir}/.beaupi/server/v1/${artifact.manifest.sha256}/beaupi-agent.mjs`;
		return { artifact, probe, remoteArtifactPath, controlPath: runner.controlPath, runner };
	}

	launchCommand(result: RemoteAgentBootstrapResult): string {
		return agentLaunchCommand(
			result.remoteArtifactPath,
			result.artifact.manifest.sha256,
			result.artifact.manifest.agentVersion,
		);
	}
}

function sshBootstrapFailure(targetId: string, message: string): RemoteExecutionError {
	const lower = message.toLowerCase();
	const code =
		lower.includes("permission denied") || lower.includes("authentication failed")
			? "ssh_authentication"
			: lower.includes("host key verification failed") || lower.includes("remote host identification has changed")
				? "ssh_host_key"
				: lower.includes("connection timed out") || lower.includes("connecttimeout")
					? "ssh_timeout"
					: "ssh_connection";
	return new RemoteExecutionError({
		code,
		message: message || "OpenSSH could not connect during Agent bootstrap",
		targetId,
		retryable: code !== "ssh_host_key" && code !== "ssh_authentication",
		executionState: "not_started",
		transport: "agent",
	});
}

function safeRemoteText(value: string): string {
	return value
		.replace(/[\r\n\t]+/g, " ")
		.replace(/(password|passphrase|token|secret|authorization)[^ ]*/gi, "$1=[redacted]")
		.slice(0, 500);
}

export { PROBE_SCRIPT, INSTALL_SCRIPT };
