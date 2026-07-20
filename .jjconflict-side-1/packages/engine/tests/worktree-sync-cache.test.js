import { describe, expect, test } from "bun:test";
import { createWorktreeSyncCache } from "../src/worktreeSyncCache.js";

/**
 * @param {number} ttlMs
 * @param {number} [startMs]
 */
function makeCache(ttlMs, startMs = 0) {
    let now = startMs;
    const cache = createWorktreeSyncCache({ ttlMs, nowMs: () => now });
    return {
        cache,
        /** @param {number} ms */
        advance(ms) {
            now += ms;
        },
    };
}

describe("createWorktreeSyncCache fetch TTL", () => {
    test("first fetch always runs, then skips until the TTL elapses", () => {
        const { cache, advance } = makeCache(1000);
        expect(cache.shouldFetch("/repo")).toBe(true);
        cache.recordFetch("/repo");
        expect(cache.shouldFetch("/repo")).toBe(false);
        advance(999);
        expect(cache.shouldFetch("/repo")).toBe(false);
        advance(1);
        expect(cache.shouldFetch("/repo")).toBe(true);
    });

    test("recording a fetch restarts the TTL window", () => {
        const { cache, advance } = makeCache(1000);
        cache.recordFetch("/repo");
        advance(1500);
        expect(cache.shouldFetch("/repo")).toBe(true);
        cache.recordFetch("/repo");
        expect(cache.shouldFetch("/repo")).toBe(false);
        advance(999);
        expect(cache.shouldFetch("/repo")).toBe(false);
    });

    test("repos are isolated: one repo's fetch does not cover another", () => {
        const { cache } = makeCache(1000);
        cache.recordFetch("/repo-a");
        expect(cache.shouldFetch("/repo-a")).toBe(false);
        expect(cache.shouldFetch("/repo-b")).toBe(true);
    });
});

describe("createWorktreeSyncCache rebase tip", () => {
    test("rebases when no tip recorded, skips only on the identical tip", () => {
        const { cache } = makeCache(1000);
        expect(cache.shouldRebase("/wt", "aaa")).toBe(true);
        cache.recordRebase("/wt", "aaa");
        expect(cache.shouldRebase("/wt", "aaa")).toBe(false);
        expect(cache.shouldRebase("/wt", "bbb")).toBe(true);
        cache.recordRebase("/wt", "bbb");
        expect(cache.shouldRebase("/wt", "bbb")).toBe(false);
        expect(cache.shouldRebase("/wt", "aaa")).toBe(true);
    });

    test("worktrees are isolated: recording one does not skip another", () => {
        const { cache } = makeCache(1000);
        cache.recordRebase("/wt-a", "aaa");
        expect(cache.shouldRebase("/wt-a", "aaa")).toBe(false);
        expect(cache.shouldRebase("/wt-b", "aaa")).toBe(true);
    });

    test("fails open on unresolved tips and never records them", () => {
        const { cache } = makeCache(1000);
        expect(cache.shouldRebase("/wt", null)).toBe(true);
        expect(cache.shouldRebase("/wt", undefined)).toBe(true);
        expect(cache.shouldRebase("/wt", "")).toBe(true);
        cache.recordRebase("/wt", null);
        cache.recordRebase("/wt", "");
        expect(cache.shouldRebase("/wt", "aaa")).toBe(true);
        // An unresolved tip must not clobber a real recorded tip either.
        cache.recordRebase("/wt", "aaa");
        cache.recordRebase("/wt", null);
        expect(cache.shouldRebase("/wt", "aaa")).toBe(false);
        expect(cache.shouldRebase("/wt", null)).toBe(true);
    });
});

describe("createWorktreeSyncCache disable semantics", () => {
    for (const ttlMs of [0, -1, Number.NaN]) {
        test(`ttlMs=${ttlMs} disables all caching`, () => {
            const { cache } = makeCache(ttlMs);
            cache.recordFetch("/repo");
            expect(cache.shouldFetch("/repo")).toBe(true);
            cache.recordRebase("/wt", "aaa");
            expect(cache.shouldRebase("/wt", "aaa")).toBe(true);
        });
    }
});
