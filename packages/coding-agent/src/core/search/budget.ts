import type { SessionEntry } from "../session-manager.ts";
import { getSearchRuntimeToolDetails, type SearchBudgetLimits, type SearchBudgetSnapshot } from "./types.ts";

interface MutableSearchBudgetState {
	queries: number;
	fetches: number;
	providerAttempts: number;
	inputCharacters: number;
	contentHashes: Set<string>;
	branchSignature?: string;
}

function emptyState(): MutableSearchBudgetState {
	return { queries: 0, fetches: 0, providerAttempts: 0, inputCharacters: 0, contentHashes: new Set() };
}

function branchSignature(entries: readonly SessionEntry[]): string {
	return entries.map((entry) => entry.id).join("\0");
}

export class SearchBudgetManager {
	private readonly states = new Map<string, MutableSearchBudgetState>();

	synchronize(scopeId: string, entries: readonly SessionEntry[]): void {
		const signature = branchSignature(entries);
		const current = this.states.get(scopeId);
		if (current?.branchSignature === signature) return;
		const restored = emptyState();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
			const details = getSearchRuntimeToolDetails(entry.message.details);
			if (!details) continue;
			restored.queries = Math.max(restored.queries, details.budget.used.queries);
			restored.fetches = Math.max(restored.fetches, details.budget.used.fetches);
			restored.providerAttempts = Math.max(restored.providerAttempts, details.budget.used.providerAttempts);
			restored.inputCharacters = Math.max(restored.inputCharacters, details.budget.used.inputCharacters);
			if (details.operation === "fetch" && details.contentHash) restored.contentHashes.add(details.contentHash);
		}
		const branchExtended =
			current !== undefined &&
			(current.branchSignature === "" || signature.startsWith(`${current.branchSignature ?? ""}\0`));
		if (branchExtended) {
			restored.queries = Math.max(restored.queries, current.queries);
			restored.fetches = Math.max(restored.fetches, current.fetches);
			restored.providerAttempts = Math.max(restored.providerAttempts, current.providerAttempts);
			restored.inputCharacters = Math.max(restored.inputCharacters, current.inputCharacters);
			for (const contentHash of current.contentHashes) restored.contentHashes.add(contentHash);
		}
		restored.branchSignature = signature;
		this.states.set(scopeId, restored);
	}

	reserveQuery(scopeId: string, limits: SearchBudgetLimits): boolean {
		const state = this.state(scopeId);
		if (state.queries >= limits.maxQueriesPerTask) return false;
		state.queries++;
		return true;
	}

	reserveFetch(scopeId: string, limits: SearchBudgetLimits): boolean {
		const state = this.state(scopeId);
		if (state.fetches >= limits.maxFetchesPerTask) return false;
		state.fetches++;
		return true;
	}

	reserveProviderAttempt(scopeId: string, limits: SearchBudgetLimits): boolean {
		const state = this.state(scopeId);
		if (state.providerAttempts >= limits.maxProviderAttemptsPerTask) return false;
		state.providerAttempts++;
		return true;
	}

	remainingCharacters(scopeId: string, limits: SearchBudgetLimits): number {
		return Math.max(0, limits.maxInputCharactersPerTask - this.state(scopeId).inputCharacters);
	}

	consumeCharacters(scopeId: string, limits: SearchBudgetLimits, characters: number): number {
		const state = this.state(scopeId);
		const consumed = Math.min(this.remainingCharacters(scopeId, limits), Math.max(0, Math.floor(characters)));
		state.inputCharacters += consumed;
		return consumed;
	}

	hasContentHash(scopeId: string, contentHash: string): boolean {
		return this.state(scopeId).contentHashes.has(contentHash);
	}

	markContentHash(scopeId: string, contentHash: string): void {
		this.state(scopeId).contentHashes.add(contentHash);
	}

	snapshot(
		scopeId: string,
		limits: SearchBudgetLimits,
		exhausted?: SearchBudgetSnapshot["exhausted"],
	): SearchBudgetSnapshot {
		const state = this.state(scopeId);
		return {
			limits: { ...limits },
			used: {
				queries: state.queries,
				fetches: state.fetches,
				providerAttempts: state.providerAttempts,
				inputCharacters: state.inputCharacters,
			},
			remaining: {
				queries: Math.max(0, limits.maxQueriesPerTask - state.queries),
				fetches: Math.max(0, limits.maxFetchesPerTask - state.fetches),
				providerAttempts: Math.max(0, limits.maxProviderAttemptsPerTask - state.providerAttempts),
				inputCharacters: Math.max(0, limits.maxInputCharactersPerTask - state.inputCharacters),
			},
			...(exhausted ? { exhausted } : {}),
		};
	}

	private state(scopeId: string): MutableSearchBudgetState {
		let state = this.states.get(scopeId);
		if (!state) {
			state = emptyState();
			this.states.set(scopeId, state);
		}
		return state;
	}
}
