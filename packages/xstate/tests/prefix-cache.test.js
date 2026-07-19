import { describe, expect, test } from "bun:test";
import { assign, createMachine } from "xstate";
import { computeMachineState, taskOutput, __machineCacheInternals } from "../src/index.js";

const { foldCache } = __machineCacheInternals;

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
        const first = computeMachineState(ctxFor(), instrumented, { id: "m", events: [source] });
        expect(first.context.log).toEqual(["one"]);
        expect(executed.count).toBe(1);
        expect(foldCache.get(`${runId}::m`).folded).toBe(1);

        rows.push({ payload: { tag: "two" }, nodeId: "t2", iteration: 0, seq: 2 });
        const second = computeMachineState(ctxFor(), instrumented, { id: "m", events: [source] });
        expect(second.context.log).toEqual(["one", "two"]);
        // Suffix fold proof: event 1 was NOT refolded — only the new event ran.
        expect(executed.count).toBe(2);
        expect(foldCache.get(`${runId}::m`).folded).toBe(2);
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
        expect(foldCache.has(`${runId}::a`)).toBe(true);
        expect(foldCache.has(`${runId}::b`)).toBe(true);
    });
});
