import { describe, expect, it, vi } from "vitest";
import type { SkillRegistryEntry } from "../src/core/skill-registry.ts";
import {
	type SkillRegistryRemoveResult,
	SkillRegistryServiceError,
	type SkillSecurityReview,
} from "../src/core/skill-registry-service.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const entry: SkillRegistryEntry = {
	id: "review-id",
	name: "review",
	source: { type: "local", path: "/tmp/source/review" },
	scope: "user",
	path: "skills/review",
	enabled: true,
	importedAt: 100,
	diagnostics: [],
};

describe("InteractiveMode skill registry command integration", () => {
	it("dispatches recognized management commands before normal prompt handling", async () => {
		const handleSkillRegistryCommand = vi.fn(async () => undefined);
		const editor = { setText: vi.fn() };
		const defaultEditor: { onSubmit?: (text: string) => Promise<void> } = {};
		const fakeThis = {
			defaultEditor,
			editor,
			handleSkillRegistryCommand,
		};

		const setup = (
			InteractiveMode as unknown as {
				prototype: { setupEditorSubmitHandler(this: typeof fakeThis): void };
			}
		).prototype.setupEditorSubmitHandler;
		setup.call(fakeThis);
		await defaultEditor.onSubmit?.("  /skill-enable review  ");

		expect(handleSkillRegistryCommand).toHaveBeenCalledWith({ type: "enable", name: "review" });
		expect(editor.setText).toHaveBeenCalledWith("");
	});

	it("shows source, target, content preview, scripts, and risks through the confirmation lifecycle", async () => {
		const review: SkillSecurityReview = {
			action: "import",
			source: { type: "url", url: "https://example.com/SKILL.md", sha256: "a".repeat(64) },
			scope: "project",
			name: "review",
			targetPath: "/tmp/project/.beaupi/skills/review",
			preview: "---\nname: review\ndescription: reviewed\n---\nBody",
			previewTruncated: false,
			sha256: "a".repeat(64),
			validation: {
				entry: { ...entry, source: { type: "url", url: "https://example.com/SKILL.md" } },
				resolvedPath: "/tmp/staging/review",
				skillFilePath: "/tmp/staging/review/SKILL.md",
				name: "review",
				description: "reviewed",
				references: [],
				inventory: { scripts: ["scripts/check.sh"], executables: ["scripts/check.sh"], truncated: false },
				diagnostics: [{ code: "security_risk", severity: "warning", message: "sudo usage" }],
				valid: true,
			},
		};
		const showExtensionConfirm = vi.fn(async (_title: string, _message: string) => true);
		const showStatus = vi.fn();
		const fakeThis = {
			showExtensionConfirm,
			showStatus,
			formatDisplayPath: (value: string) => value,
		};
		const confirm = (
			InteractiveMode as unknown as {
				prototype: {
					confirmSkillSecurityReview(this: typeof fakeThis, input: SkillSecurityReview): Promise<boolean>;
				};
			}
		).prototype.confirmSkillSecurityReview;
		expect(await confirm.call(fakeThis, review)).toBe(true);
		const [title, message] = showExtensionConfirm.mock.calls[0] ?? [];
		expect(title).toContain("project Skill");
		expect(message).toContain("https://example.com/SKILL.md");
		expect(message).toContain("Version/ref/hash:");
		expect(message).toContain("sha256:");
		expect(message).toContain("/tmp/project/.beaupi/skills/review");
		expect(message).toContain("scripts/check.sh");
		expect(message).toContain("sudo usage");
		expect(message).toContain("name: review");
	});

	it("keeps structured Skill diagnostics visible in InteractiveMode errors", () => {
		const showError = vi.fn();
		const fakeThis = {
			showError,
			formatDisplayPath: (value: string) => value,
		};
		const showSkillRegistryError = (
			InteractiveMode as unknown as {
				prototype: {
					showSkillRegistryError(this: typeof fakeThis, error: unknown): void;
				};
			}
		).prototype.showSkillRegistryError;
		const error = new SkillRegistryServiceError("Skill read failed", [
			{ code: "skill_file_read_failed", severity: "error", message: "permission denied", path: "/tmp/SKILL.md" },
		]);
		showSkillRegistryError.call(fakeThis, error);
		expect(showError).toHaveBeenCalledWith(expect.stringContaining("skill_file_read_failed"));
		expect(showError).toHaveBeenCalledWith(expect.stringContaining("permission denied"));
	});

	it("dispatches the remote Skill update command through InteractiveMode", async () => {
		const handleSkillRegistryCommand = vi.fn(async () => undefined);
		const editor = { setText: vi.fn() };
		const defaultEditor: { onSubmit?: (text: string) => Promise<void> } = {};
		const fakeThis = {
			defaultEditor,
			editor,
			handleSkillRegistryCommand,
		};
		const setup = (
			InteractiveMode as unknown as {
				prototype: { setupEditorSubmitHandler(this: typeof fakeThis): void };
			}
		).prototype.setupEditorSubmitHandler;
		setup.call(fakeThis);
		await defaultEditor.onSubmit?.("/skill-update review");
		expect(handleSkillRegistryCommand).toHaveBeenCalledWith({ type: "update", name: "review" });
	});

	it("keeps managed files after the first remove and deletes them only after explicit confirmation", async () => {
		let confirmDelete = false;
		const removeResult: SkillRegistryRemoveResult = {
			entry,
			managedPath: "/tmp/agent/skills/review",
		};
		const deleteManagedFiles = vi.fn();
		const handleReloadCommand = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showExtensionConfirm = vi.fn(async () => confirmDelete);
		const fakeThis = {
			createSkillRegistryService: () => ({ remove: () => removeResult, deleteManagedFiles }),
			handleReloadCommand,
			showStatus,
			showExtensionConfirm,
			formatDisplayPath: (path: string) => path,
			showSkillRegistryError: vi.fn(),
		};

		const handleRemove = (
			InteractiveMode as unknown as {
				prototype: {
					handleSkillRemoveCommand(this: typeof fakeThis, name: string): Promise<void>;
				};
			}
		).prototype.handleSkillRemoveCommand;

		await handleRemove.call(fakeThis, "review");
		expect(handleReloadCommand).toHaveBeenCalledTimes(1);
		expect(showExtensionConfirm).toHaveBeenCalledTimes(1);
		expect(deleteManagedFiles).not.toHaveBeenCalled();

		confirmDelete = true;
		await handleRemove.call(fakeThis, "review");
		expect(handleReloadCommand).toHaveBeenCalledTimes(3);
		expect(deleteManagedFiles).toHaveBeenCalledTimes(1);
	});
});
