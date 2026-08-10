import type { Locator, Page } from "playwright";
import type { PlaywrightDiagnosticCode, PlaywrightTarget } from "./types.ts";

export class PlaywrightLocatorError extends Error {
	readonly code: PlaywrightDiagnosticCode;

	constructor(code: PlaywrightDiagnosticCode, message: string) {
		super(message);
		this.name = "PlaywrightLocatorError";
		this.code = code;
	}
}

export function resolveLocator(page: Page, target: PlaywrightTarget): Locator {
	let locator: Locator;
	switch (target.by) {
		case "role":
			locator = page.getByRole(target.role as Parameters<Page["getByRole"]>[0], {
				name: target.name,
				exact: target.exact,
			});
			break;
		case "text":
			locator = page.getByText(target.value, { exact: target.exact });
			break;
		case "label":
			locator = page.getByLabel(target.value, { exact: target.exact });
			break;
		case "placeholder":
			locator = page.getByPlaceholder(target.value, { exact: target.exact });
			break;
		case "testId":
			locator = page.getByTestId(target.value);
			break;
		case "css":
			locator = page.locator(target.value);
			break;
	}
	return target.nth === undefined ? locator : locator.nth(target.nth);
}

export async function resolveUniqueLocator(
	page: Page,
	target: PlaywrightTarget,
	options: { timeoutMs: number; signal?: AbortSignal },
): Promise<Locator> {
	const locator = resolveLocator(page, target);
	let count = await locator.count();
	if (count === 0) {
		try {
			await locator.first().waitFor({ state: "attached", timeout: options.timeoutMs, signal: options.signal });
		} catch (error) {
			if (options.signal?.aborted) throw error;
			throw new PlaywrightLocatorError("locator_not_found", `No element matched ${formatPlaywrightTarget(target)}.`);
		}
		count = await locator.count();
	}
	if (count === 0) {
		throw new PlaywrightLocatorError("locator_not_found", `No element matched ${formatPlaywrightTarget(target)}.`);
	}
	if (target.nth === undefined && count > 1) {
		throw new PlaywrightLocatorError(
			"locator_ambiguous",
			`${count} elements matched ${formatPlaywrightTarget(target)}. Add a more specific name/value or nth.`,
		);
	}
	return locator;
}

function quoted(value: string): string {
	return JSON.stringify(value.length > 80 ? `${value.slice(0, 77)}...` : value);
}

export function formatPlaywrightTarget(target: PlaywrightTarget): string {
	const suffix = target.nth === undefined ? "" : ` nth=${target.nth}`;
	if (target.by === "role") {
		return `role=${target.role}${target.name ? ` name=${quoted(target.name)}` : ""}${suffix}`;
	}
	return `${target.by}=${quoted(target.value)}${suffix}`;
}
