import { describe, expect, test } from "bun:test";
import { assign, createMachine } from "xstate";
import { computeMachineState, taskOutput, __machineCacheInternals } from "../src/index.js";

const { foldCache, hashReducer, MAX_CACHE_ENTRIES } = __machineCacheInternals;

/** Ctx fixture whose outputRows serve mutable row arrays, so tests can
 * append rows (new frame) or replace payloads in place (retry-task/reopen). */
function makeHarness(runId) {
    const rows = [];
    const calls = { maps: 0 };
    const ctxFor = () => ({
        runId,
        outputRows: () => rows.map((row) => ({ ...row })).sort((a, b) => a.seq - b.seq),
        signalRows: () => [],
    });
    return { rows, calls, ctxFor };
}

/** The cache key is (runId, machine id, reducer hash) — reconstruct it the
 * same way computeMachineState does, for direct cache assertions. */
function cacheKeyFor(runId, id, machine, sources) {
    return `${runId}::${id}::${hashReducer(machine, sources)}`;
}

const counter = createMachine({
    context: { log: [] },
    initial: "a",
    states: {
        a: {
            on: {
                MARK: { actions: assign({ log: ({ context, event }) => [...context.log, event.tag] }) },
            },
        },
    },
});

let runCounter = 0;
const freshRunId = () => `cache-run-${++runCounter}`;

describe("prefix cache", () => {
    test("append-only growth reuses the cached prefix (suffix fold only)", () => {
        const runId = freshRunId();
        const { rows, ctxFor } = makeHarness(runId);
        rows.push({ payload: { tag: "one" }, nodeId: "t1", iteration: 0, seq: 1 });

        // The assigner increments an out-of-band counter purely to observe
        // how many transitions actually executed — the purity contract is for
        // workflow authors, not for this instrumentation.
        const executed = { count: 0 };
        const instrumented = createMachine({
            context: { log: [] },
            initial: "a",
            states: {
                a: {
                    on: {
                        MARK: {
                            actions: assign({
                                log: ({ context, event }) => {
                                    executed.count += 1;
                                    return [...context.log, event.tag];
                                },
                            }),
                        },
                    },
                },
            },
        });

        const source = taskOutput("rows", {}, (p) => ({ type: "MARK", tag: p.tag }));
        const key = cacheKeyFor(runId, "m", instrumented, [source]);
        const first = computeMachineState(ctxFor(), instrumented, { id: "m", events: [source] });
        expect(first.context.log).toEqual(["one"]);
        expect(executed.count).toBe(1);
        expect(foldCache.get(key).folded).toBe(1);

        rows.push({ payload: { tag: "two" }, nodeId: "t2", iteration: 0, seq: 2 });
        const second = computeMachineState(ctxFor(), instrumented, { id: "m", events: [source] });
        expect(second.context.log).toEqual(["one", "two"]);
        // Suffix fold proof: event 1 was NOT refolded — only the new event ran.
        expect(executed.count).toBe(2);
        expect(foldCache.get(key).folded).toBe(2);
    });

    test("in-place payload replacement at the same key (same seq) invalidates by content", () => {
        const runId = freshRunId();
        const { rows, ctxFor } = makeHarness(runId);
        rows.push({ payload: { tag: "draft-v1" }, nodeId: "draft", iteration: 0, seq: 1 });
        rows.push({ payload: { tag: "review" }, nodeId: "review", iteration: 0, seq: 2 });

        const source = taskOutput("rows", {}, (p) => ({ type: "MARK", tag: p.tag }));
        const first = computeMachineState(ctxFor(), counter, { id: "m", events: [source] });
        expect(first.context.log).toEqual(["draft-v1", "review"]);

        // Manual retry-task of the completed draft node: same (nodeId,
        // iteration), same seq, NEW payload. Count and maxSeq are unchanged —
        // only content validation can catch this.
        rows[0] = { payload: { tag: "draft-v2" }, nodeId: "draft", iteration: 0, seq: 1 };
        const second = computeMachineState(ctxFor(), counter, { id: "m", events: [source] });
        expect(second.context.log).toEqual(["draft-v2", "review"]);
    });

    test("machine identity change refolds and warns once about reinterpretation", () => {
        const runId = freshRunId();
        const { rows, ctxFor } = makeHarness(runId);
        rows.push({ payload: { tag: "x" }, nodeId: "t", iteration: 0, seq: 1 });
        const source = taskOutput("rows", {}, (p) => ({ type: "MARK", tag: p.tag }));

        const first = computeMachineState(ctxFor(), counter, { id: "m", events: [source] });
        expect(first.context.log).toEqual(["x"]);

        const editedMachine = createMachine({
            context: { log: [] },
            initial: "a",
            states: {
                a: { on: { MARK: { actions: assign({ log: ({ context, event }) => [...context.log, `edited-${event.tag}`] }) } } },
            },
        });
        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(" "));
        try {
            const second = computeMachineState(ctxFor(), editedMachine, { id: "m", events: [source] });
            expect(second.context.log).toEqual(["edited-x"]);
            computeMachineState(ctxFor(), editedMachine, { id: "m", events: [source] });
        }
        finally {
            console.warn = originalWarn;
        }
        expect(warnings.filter((w) => w.includes("reinterpreted")).length).toBe(1);
        // The reducer hash changed, so this is a genuinely different cache
        // entry — the original machine's fold is still sitting in the cache
        // under its own key, not overwritten in place.
        expect(foldCache.get(cacheKeyFor(runId, "m", counter, [source])).snapshot.context.log).toEqual(["x"]);
        expect(foldCache.get(cacheKeyFor(runId, "m", editedMachine, [source])).snapshot.context.log).toEqual(["edited-x"]);
    });

    test("input change refolds from scratch", () => {
        const runId = freshRunId();
        const { ctxFor } = makeHarness(runId);
        const machine = createMachine({
            context: ({ input }) => ({ seed: input?.seed ?? 0 }),
            initial: "a",
            states: { a: {} },
        });
        const first = computeMachineState(ctxFor(), machine, { id: "m", input: { seed: 1 } });
        expect(first.context.seed).toBe(1);
        const second = computeMachineState(ctxFor(), machine, { id: "m", input: { seed: 2 } });
        expect(second.context.seed).toBe(2);
    });

    test("distinct machine ids never share cache entries", () => {
        const runId = freshRunId();
        const { rows, ctxFor } = makeHarness(runId);
        rows.push({ payload: { tag: "only-a" }, nodeId: "t", iteration: 0, seq: 1 });
        const source = taskOutput("rows", {}, (p) => ({ type: "MARK", tag: p.tag }));
        const a = computeMachineState(ctxFor(), counter, { id: "a", events: [source] });
        const b = computeMachineState(ctxFor(), counter, { id: "b", events: [] });
        expect(a.context.log).toEqual(["only-a"]);
        expect(b.context.log).toEqual([]);
        expect(foldCache.has(cacheKeyFor(runId, "a", counter, [source]))).toBe(true);
        expect(foldCache.has(cacheKeyFor(runId, "b", counter, []))).toBe(true);
    });

    test("cache key is (runId, machine id, reducer hash): two concurrent runs plus a fork sharing one machine id fold independently in one process", () => {
        // A fork inherits its parent's row history AND its machine `id`
        // verbatim. If the key were bare `id` (or even `${runId}::${id}`
        // without the reducer hash guarding content), a long-lived process
        // hosting many runs could serve one run's snapshot to another. Use
        // the SAME machine id ("shared") for a real, distinct third run and a
        // simulated "fork" (a run that starts from a copy of the parent's
        // rows) and assert every snapshot stays independent.
        const parentRunId = freshRunId();
        const siblingRunId = freshRunId();
        const parent = makeHarness(parentRunId);
        const sibling = makeHarness(siblingRunId);
        parent.rows.push({ payload: { tag: "p1" }, nodeId: "t", iteration: 0, seq: 1 });
        sibling.rows.push({ payload: { tag: "s1" }, nodeId: "t", iteration: 0, seq: 1 });

        const source = taskOutput("rows", {}, (p) => ({ type: "MARK", tag: p.tag }));
        const parentState = computeMachineState(parent.ctxFor(), counter, { id: "shared", events: [source] });
        const siblingState = computeMachineState(sibling.ctxFor(), counter, { id: "shared", events: [source] });
        expect(parentState.context.log).toEqual(["p1"]);
        expect(siblingState.context.log).toEqual(["s1"]);

        // Fork: a new run id whose row history starts as an exact copy of the
        // parent's rows at fork time, then diverges with its own event.
        const forkRunId = freshRunId();
        const fork = makeHarness(forkRunId);
        fork.rows.push(...parent.rows.map((row) => ({ ...row })));
        fork.rows.push({ payload: { tag: "fork-only" }, nodeId: "t2", iteration: 0, seq: 2 });
        const forkState = computeMachineState(fork.ctxFor(), counter, { id: "shared", events: [source] });
        expect(forkState.context.log).toEqual(["p1", "fork-only"]);

        // The parent's own fold, recomputed now, must be untouched by the
        // fork or the sibling ever having used the same machine id.
        const parentAgain = computeMachineState(parent.ctxFor(), counter, { id: "shared", events: [source] });
        expect(parentAgain.context.log).toEqual(["p1"]);
        expect(foldCache.get(cacheKeyFor(parentRunId, "shared", counter, [source])).snapshot.context.log).toEqual(["p1"]);
        expect(foldCache.get(cacheKeyFor(siblingRunId, "shared", counter, [source])).snapshot.context.log).toEqual(["s1"]);
        expect(foldCache.get(cacheKeyFor(forkRunId, "shared", counter, [source])).snapshot.context.log).toEqual(["p1", "fork-only"]);
    });

    test("the cache is bounded: it never grows past MAX_CACHE_ENTRIES and evicts least-recently-used entries first", () => {
        const source = taskOutput("rows", {}, (p) => ({ type: "MARK", tag: p.tag }));
        /** @type {string[]} */
        const keysInOrder = [];
        for (let i = 0; i < MAX_CACHE_ENTRIES + 10; i += 1) {
            const runId = freshRunId();
            const { rows, ctxFor } = makeHarness(runId);
            rows.push({ payload: { tag: `t${i}` }, nodeId: "t", iteration: 0, seq: 1 });
            computeMachineState(ctxFor(), counter, { id: "m", events: [source] });
            keysInOrder.push(cacheKeyFor(runId, "m", counter, [source]));
        }
        expect(foldCache.size).toBeLessThanOrEqual(MAX_CACHE_ENTRIES);
        // The oldest entries were evicted first (FIFO/LRU over insertion —
        // none of these keys were ever re-touched after their first fold).
        expect(foldCache.has(keysInOrder[0])).toBe(false);
        expect(foldCache.has(keysInOrder[keysInOrder.length - 1])).toBe(true);
    });
});
