import { AgentServer } from "./server.ts";

interface AgentCliOptions {
	stdio: boolean;
	artifactSha256: string;
	agentVersion?: string;
}

function parseArgs(args: readonly string[]): AgentCliOptions {
	let stdio = false;
	let artifactSha256 = "";
	let agentVersion: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--stdio") {
			stdio = true;
			continue;
		}
		if (arg === "--artifact-sha256") {
			artifactSha256 = args[++index] ?? "";
			continue;
		}
		if (arg === "--agent-version") {
			agentVersion = args[++index] ?? "";
			continue;
		}
		throw new Error(`Unknown agent option ${JSON.stringify(arg)}`);
	}
	if (!stdio) throw new Error("Remote Agent requires --stdio");
	if (!/^[a-f0-9]{64}$/.test(artifactSha256)) throw new Error("Remote Agent requires a valid --artifact-sha256");
	return { stdio, artifactSha256, ...(agentVersion ? { agentVersion } : {}) };
}

export async function runRemoteAgent(args = process.argv.slice(2)): Promise<void> {
	const options = parseArgs(args);
	const server = new AgentServer({ artifactSha256: options.artifactSha256, agentVersion: options.agentVersion });
	await server.run(process.stdin, process.stdout);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	runRemoteAgent().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
