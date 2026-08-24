import { describe, expect, it } from "vitest";
import { targetFingerprint } from "../src/core/remote-agent/index.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("Remote Agent rollout settings", () => {
	it("keeps legacy transport as the default and only enables Agent explicitly", () => {
		const legacy = SettingsManager.inMemory({});
		expect(legacy.getRemoteCommandTransport()).toBe("legacy-ssh");
		const agent = SettingsManager.inMemory({ remote: { commandTransport: "agent" } });
		expect(agent.getRemoteCommandTransport()).toBe("agent");
	});

	it("binds the hello fingerprint to connection-relevant target configuration", () => {
		const base = { sshAlias: "host", remoteCwd: "/srv/app" };
		expect(targetFingerprint(base)).toBe(targetFingerprint({ ...base }));
		expect(targetFingerprint(base)).not.toBe(targetFingerprint({ ...base, port: 2222 }));
		expect(targetFingerprint(base)).not.toBe(targetFingerprint({ ...base, controlPersistSeconds: 120 }));
	});
});
