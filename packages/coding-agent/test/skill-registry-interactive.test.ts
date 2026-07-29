import { describe, expect, it, vi } from "vitest";
import type { SkillRegistryEntry } from "../src/core/skill-registry.ts";
import type { SkillRegistryRemoveResult } from "../src/core/skill-registry-service.ts";
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
