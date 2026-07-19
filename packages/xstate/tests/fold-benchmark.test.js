import { describe, expect, test } from "bun:test";
import { assign, createMachine } from "xstate";
import { computeMachineState, foldMachineState, taskOutput, __machineCacheInternals } from "../src/index.js";

/**
 * CI benchmark for the documented practical limit: a hierarchical
 * (3-region parallel + nested compound) machine folding 10k+ events. The
 * real gate is OPERATION COUNTS, not wall-clock: a wall-clock threshold on a
 * shared/loaded CI or dev machine is flaky by construction, so the
 * incremental-frame case proves "only the suffix was refolded" by counting
 * actual transition-action invocations (immune to machine load) rather than
 * timing it. Wall-clock is still logged and checked against a deliberately
 * generous, non-strict backstop — wide enough that only a true
 * order-of-magnitude regression (e.g. an accidental O(N²) refold-per-frame)
 * would trip it — documented here as a sanity net, not a perf SLA. This
 * gates under `pnpm -C packages/xstate test` like the rest of the suite.
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
        // Generous non-strict backstop (see file header) — not the real gate.
        expect(elapsedMs).toBeLessThan(60_000);
    }, 90_000);

    test("an incremental frame over 10k cached events folds only the suffix (proved by operation count, not timing)", () => {
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
        // An instrumented copy of the hierarchical machine's audit-counting
        // assign, purely to observe how many transitions actually executed —
        // the real proof that only the suffix refolds, immune to machine load.
        const executed = { count: 0 };
        const instrumented = createMachine({
            ...hierarchical.config,
            states: {
                ...hierarchical.config.states,
                audit: {
                    initial: "counting",
                    states: {
                        counting: {
                            on: {
                                STEP: { actions: assign({ applied: ({ context }) => { executed.count += 1; return context.applied + 1; } }) },
                                ADVANCE: { actions: assign({ applied: ({ context }) => { executed.count += 1; return context.applied + 1; } }) },
                            },
                        },
                    },
                },
            },
        });
        const source = taskOutput("rows", {}, (p) => ({ type: p.kind }));
        const warmMs = performance.now();
        computeMachineState(ctx, instrumented, { id: "bench", events: [source] });
        const warmElapsed = performance.now() - warmMs;
        expect(executed.count).toBe(EVENT_COUNT);
        const cacheKey = `${runId}::bench::${__machineCacheInternals.hashReducer(instrumented, [source])}`;
        expect(__machineCacheInternals.foldCache.get(cacheKey).folded).toBe(EVENT_COUNT);

        rows.push({ payload: { kind: "STEP" }, nodeId: "extra", iteration: 0, seq: EVENT_COUNT + 1 });
        const frameMs = performance.now();
        const snapshot = computeMachineState(ctx, instrumented, { id: "bench", events: [source] });
        const frameElapsed = performance.now() - frameMs;
        expect(snapshot.context.applied).toBe(EVENT_COUNT + 1);
        // The real gate: exactly one MORE transition ran, not 10,001.
        expect(executed.count).toBe(EVENT_COUNT + 1);
        console.log(`[bench] warm fold ${Math.round(warmElapsed)}ms; incremental frame over ${EVENT_COUNT} cached events: ${Math.round(frameElapsed)}ms`);
        // Generous non-strict backstop (see file header) — not the real gate.
        expect(frameElapsed).toBeLessThan(5_000);
    }, 90_000);
});
