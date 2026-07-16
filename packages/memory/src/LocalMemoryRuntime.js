/** @typedef {import("./store/MemoryStore.ts").MemoryStore} MemoryStore */
/** @typedef {import("./MemoryNamespace.ts").MemoryNamespace} MemoryNamespace */

import { capMemoryRecallResults } from "./capMemoryRecallResults.js";

/**
 * Map component bank names onto the existing local namespace store. Known
 * namespace prefixes preserve their kind; project banks intentionally map to
 * workflow scope because projects are workflow-local in the SQLite seam.
 * @param {string} bank
 * @returns {MemoryNamespace}
 */
function namespaceForBank(bank) {
    for (const kind of ["workflow", "agent", "user", "global"]) {
        if (bank.startsWith(`${kind}-`) && bank.length > kind.length + 1) {
            return /** @type {MemoryNamespace} */ ({ kind, id: bank.slice(kind.length + 1) });
        }
    }
    return { kind: "workflow", id: bank };
}

/** @param {unknown} value */
function searchableText(value) {
    if (value && typeof value === "object" && typeof value.content === "string") {
        return value.content;
    }
    return typeof value === "string" ? value : JSON.stringify(value);
}

/** @param {unknown} value */
function retainedTags(value) {
    if (!value || typeof value !== "object" || !Array.isArray(value.tags)) {
        return [];
    }
    return value.tags.filter((tag) => typeof tag === "string");
}

/**
 * @typedef {{ tags: string[]; match?: "any" | "all" | "any_strict" | "all_strict" | "exact" }
 * | { and: LocalTagGroup[] }
 * | { or: LocalTagGroup[] }
 * | { not: LocalTagGroup }} LocalTagGroup
 */

/** @param {string[]} actual @param {LocalTagGroup} group */
function matchesTagGroup(actual, group) {
    if ("and" in group) {
        return group.and.every((child) => matchesTagGroup(actual, child));
    }
    if ("or" in group) {
        return group.or.some((child) => matchesTagGroup(actual, child));
    }
    if ("not" in group) {
        return !matchesTagGroup(actual, group.not);
    }
    const expected = [...new Set(group.tags)];
    const actualSet = new Set(actual);
    switch (group.match ?? "any") {
        case "all":
            return actual.length === 0 || expected.every((tag) => actualSet.has(tag));
        case "any_strict":
            return actual.length > 0 && expected.some((tag) => actualSet.has(tag));
        case "all_strict":
            return actual.length > 0 && expected.every((tag) => actualSet.has(tag));
        case "exact":
            return actualSet.size === expected.length && expected.every((tag) => actualSet.has(tag));
        case "any":
        default:
            return actual.length === 0 || expected.some((tag) => actualSet.has(tag));
    }
}

/** @param {string[]} actual @param {LocalTagGroup[]} groups */
function matchesTagGroups(actual, groups) {
    return groups.every((group) => matchesTagGroup(actual, group));
}

/**
 * Runtime recall/retain adapter for the pre-existing local facts store.
 * Exact MemoryStore behavior is untouched; this only gives `<Memory>` a
 * keyword fallback when HINDSIGHT_URL is absent.
 */
export class LocalMemoryRuntime {
    /** @param {MemoryStore} store */
    constructor(store) {
        this.store = store;
    }

    /** @param {{ banks: string[]; query: string; tags?: string[]; tagGroupsByBank?: Record<string, LocalTagGroup[]>; maxTokens?: number }} input */
    async recallMemory(input) {
        const terms = input.query.toLowerCase().split(/\s+/u).filter(Boolean);
        const scored = [];
        for (const bank of input.banks) {
            const facts = await this.store.listFacts(namespaceForBank(bank));
            for (const fact of facts) {
                let value;
                try {
                    value = JSON.parse(fact.valueJson);
                }
                catch {
                    value = fact.valueJson;
                }
                const groups = input.tagGroupsByBank?.[bank]
                    ?? (input.tags?.length ? [{ tags: input.tags, match: "all_strict" }] : []);
                if (groups.length > 0 && !matchesTagGroups(retainedTags(value), groups)) {
                    continue;
                }
                const text = searchableText(value);
                const haystack = `${fact.key} ${text}`.toLowerCase();
                const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
                if (score > 0 || terms.length === 0) {
                    scored.push({ bank, text, score, updatedAtMs: fact.updatedAtMs });
                }
            }
        }
        scored.sort((a, b) => b.score - a.score || b.updatedAtMs - a.updatedAtMs);
        return capMemoryRecallResults(scored.map(({ bank, text }) => ({ bank, text })), input.maxTokens ?? 2048);
    }

    async getPrimers() {
        return [];
    }

    /**
     * @param {{ bank: string; content: string; tags?: string[]; metadata?: Record<string, string>; documentId: string; updateMode?: "replace" | "append" }} input
     */
    async retainMemory(input) {
        const ns = namespaceForBank(input.bank);
        const key = `memory:${input.documentId}`;
        let content = input.content;
        if (input.updateMode !== "replace") {
            const previous = await this.store.getFact(ns, key);
            if (previous) {
                try {
                    const decoded = JSON.parse(previous.valueJson);
                    const previousContent = searchableText(decoded);
                    content = previousContent ? `${previousContent}\n${content}` : content;
                }
                catch {
                    // A malformed old value should not prevent the new memory.
                }
            }
        }
        await this.store.setFact(ns, key, {
            content,
            tags: input.tags ?? [],
            metadata: input.metadata ?? {},
            documentId: input.documentId,
        }, undefined, {
            runId: input.metadata?.run,
            nodeId: input.metadata?.node,
        });
    }
}

/** @param {MemoryStore} store */
export function createLocalMemoryRuntime(store) {
    return new LocalMemoryRuntime(store);
}
