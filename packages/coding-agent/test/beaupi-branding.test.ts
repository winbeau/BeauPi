import { describe, expect, it } from "vitest";
import { APP_NAME, APP_TITLE, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR, PACKAGE_NAME } from "../src/config.ts";

describe("BeauPi distribution branding", () => {
	it("uses BeauPi application metadata without renaming the internal package", () => {
		expect(APP_NAME).toBe("beaupi");
		expect(APP_TITLE).toBe("BeauPi");
		expect(CONFIG_DIR_NAME).toBe(".beaupi");
		expect(ENV_AGENT_DIR).toBe("BEAUPI_CODING_AGENT_DIR");
		expect(ENV_SESSION_DIR).toBe("BEAUPI_CODING_AGENT_SESSION_DIR");
		expect(PACKAGE_NAME).toBe("@earendil-works/pi-coding-agent");
	});
});
