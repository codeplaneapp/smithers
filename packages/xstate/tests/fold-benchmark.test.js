import { describe, expect, test } from "bun:test";
import { assign, createMachine } from "xstate";
import { computeMachineState, foldMachineState, taskOutput, __machineCacheInternals } from "../src/index.js";

/**
 * CI benchmark for the documented practical limit: a hierarchical
 * (3-region parallel + nested compound) machine folding 10k+ events.
 * Budgets are deliberately generous — CI hosts and this repo's dev machine
 * run heavily loaded — while still catching order-of-magnitude regressions
 * (an accidental O(N²) refold-per-frame would blow through them instantly).
 * The documented practical limit lives in docs/integrations/xstate.mdx and
 * must match what this test enforces: 10k events full-refold ≤ 30s,
 * incremental frame ≤ 1s.
 */
const hierarchical = createMachine({
    context: { applied: 0, phases: 0 },
    type: "parallel",
    states: {
        pipeline: {
            initial: "intake",
            states: {
                intake: { on: { ADVANCE: "processing" } },
                processing: {
                    initial: "validate",
                    states: {
                        validate: { on: { STEP: "transform" } },
                        transform: { on: { STEP: "persist" } },
                        persist: { on: { STEP: "done" } },
                        done: { type: "final" },
                    },
                    onDone: "review",
                },
                review: { on: { ADVANCE: { target: "intake", actions: assign({ phases: ({ context }) => context.phases + 1 }) } } },
            },
        },
        audit: {
            initial: "counting",
            states: {
                counting: {
                    on: {
                        STEP: { actions: assign({ applied: ({ context }) => context.applied + 1 }) },
                        ADVANCE: { actions: assign({ applied: ({ context }) => context.applied + 1 }) },
                    },
                },
            },
        },
        health: {
            initial: "ok",
            states: { ok: { on: { DEGRADE: "degraded" } }, degraded: { on: { RECOVER: "ok" } } },
        },
    },
});

const EVENT_COUNT = 10_000;

function buildEvents() {
    const events = [];
    for (let seq = 1; seq <= EVENT_COUNT; seq++) {
        const type = seq % 5 === 0 ? "ADVANCE" : "STEP";
        events.push({ seq, declarationIndex: 0, subIndex: 0, event: { type } });
    }
    return events;
}

describe("fold benchmark (documented practical limit)", () => {
    test(`full refold of ${EVENT_COUNT} events on a hierarchical machine completes within budget`, () => {
        const events = buildEvents();
        const startMs = performance.now();
        const { snapshot, folded } = foldMachineState(hierarchical, { id: "bench", events });
        const elapsedMs = performance.now() - startMs;
        expect(folded).toBe(EVENT_COUNT);
        expect(snapshot.context.applied).toBe(EVENT_COUNT);
        expect(snapshot.status).toBe("active");
        console.log(`[bench] full refold of ${EVENT_COUNT} events: ${Math.round(elapsedMs)}ms (${(elapsedMs * 1000 / EVENT_COUNT).toFixed(1)}µs/event)`);
        expect(elapsedMs).toBeLessThan(30_000);
    }, 60_000);

    test("an incremental frame over 10k cached events folds only the suffix within budget", () => {
        const runId = "bench-incremental";
        const rows = [];
        for (let seq = 1; seq <= EVENT_COUNT; seq++) {
            rows.push({ payload: { kind: seq % 5 === 0 ? "ADVANCE" : "STEP" }, nodeId: `n${seq}`, iteration: 0, seq });
        }
        const ctx = {
            runId,
            outputRows: () => rows.map((row) => ({ ...row })),
            signalRows: () => [],
        };
        const source = taskOutput("rows", {}, (p) => ({ type: p.kind }));
        const warmMs = performance.now();
        computeMachineState(ctx, hierarchical, { id: "bench", events: [source] });
        const warmElapsed = performance.now() - warmMs;
        expect(__machineCacheInternals.foldCache.get(`${runId}::bench`).folded).toBe(EVENT_COUNT);

        rows.push({ payload: { kind: "STEP" }, nodeId: "extra", iteration: 0, seq: EVENT_COUNT + 1 });
        const frameMs = performance.now();
        const snapshot = computeMachineState(ctx, hierarchical, { id: "bench", events: [source] });
        const frameElapsed = performance.now() - frameMs;
        expect(snapshot.context.applied).toBe(EVENT_COUNT + 1);
        console.log(`[bench] warm fold ${Math.round(warmElapsed)}ms; incremental frame over ${EVENT_COUNT} cached events: ${Math.round(frameElapsed)}ms`);
        // Collection + hashing stay O(N) per frame; only the fold is O(suffix).
        expect(frameElapsed).toBeLessThan(1_000);
    }, 60_000);
});
