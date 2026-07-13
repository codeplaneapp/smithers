import { describe, expect, it, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { createScorer } from "../src/index.js";
import { runScorersAsync, runScorersBatch } from "../src/run-scorers.js";
import { aggregateScores } from "../src/aggregate.js";
// Mock DB adapter — only needs insertScorerResult for our tests
function createMockAdapter() {
    const rows = [];
    return {
        rows,
        insertScorerResult: mock((_row) => {
            rows.push(_row);
            // Return an Effect-like object that succeeds synchronously
            const { Effect } = require("effect");
            return Effect.succeed(undefined);
        }),
    };
}
/**
 * @param {Partial<ScorerContext>} [overrides]
 * @returns {ScorerContext}
 */
function makeContext(overrides) {
    return {
        runId: "run-1",
        nodeId: "task-1",
        iteration: 0,
        attempt: 1,
        input: "test prompt",
        output: { result: "test output" },
        latencyMs: 1500,
        ...overrides,
    };
}
describe("runScorersBatch", () => {
    it("runs all scorers and returns results", async () => {
        const scorers = {
            alpha: {
                scorer: createScorer({
                    id: "alpha",
                    name: "Alpha",
                    description: "d",
                    score: async () => ({ score: 0.8, reason: "Good" }),
                }),
            },
            beta: {
                scorer: createScorer({
                    id: "beta",
                    name: "Beta",
                    description: "d",
                    score: async () => ({ score: 0.6 }),
                }),
            },
        };
        const results = await runScorersBatch(scorers, makeContext(), null);
        expect(results.alpha).toBeDefined();
        expect(results.alpha?.score).toBe(0.8);
        expect(results.alpha?.reason).toBe("Good");
        expect(results.beta?.score).toBe(0.6);
    });
    it("returns empty object for empty scorers map", async () => {
        const results = await runScorersBatch({}, makeContext(), null);
        expect(Object.keys(results)).toHaveLength(0);
    });
    it("respects sampling: none", async () => {
        const scoreFn = mock(async () => ({ score: 1 }));
        const scorers = {
            skipped: {
                scorer: createScorer({
                    id: "skipped",
                    name: "Skipped",
                    description: "d",
                    score: scoreFn,
                }),
                sampling: { type: "none" },
            },
        };
        const results = await runScorersBatch(scorers, makeContext(), null);
        expect(results.skipped).toBeNull();
        expect(scoreFn).not.toHaveBeenCalled();
    });
    it("respects sampling: all", async () => {
        const scoreFn = mock(async () => ({ score: 1 }));
        const scorers = {
            always: {
                scorer: createScorer({
                    id: "always",
                    name: "Always",
                    description: "d",
                    score: scoreFn,
                }),
                sampling: { type: "all" },
            },
        };
        const results = await runScorersBatch(scorers, makeContext(), null);
        expect(results.always?.score).toBe(1);
        expect(scoreFn).toHaveBeenCalledTimes(1);
    });
    it("respects ratio sampling deterministically and falls back to running unknown sampling types", async () => {
        const scoreFn = mock(async () => ({ score: 1 }));
        // rate 0 never runs; rate 1 always runs — independent of the context.
        const never = await runScorersBatch({
            ratio: {
                scorer: createScorer({
                    id: "ratio",
                    name: "Ratio",
                    description: "d",
                    score: scoreFn,
                }),
                sampling: { type: "ratio", rate: 0 },
            },
        }, makeContext(), null);
        expect(never.ratio).toBeNull();
        expect(scoreFn).not.toHaveBeenCalled();

        const results = await runScorersBatch({
            ratio: {
                scorer: createScorer({
                    id: "ratio",
                    name: "Ratio",
                    description: "d",
                    score: scoreFn,
                }),
                sampling: { type: "ratio", rate: 1 },
            },
            unknown: {
                scorer: createScorer({
                    id: "unknown",
                    name: "Unknown",
                    description: "d",
                    score: scoreFn,
                }),
                sampling: { type: "surprise" },
            },
        }, makeContext(), null);
        expect(results.ratio?.score).toBe(1);
        expect(results.unknown?.score).toBe(1);
    });
    it("handles scorer errors gracefully", async () => {
        const scorers = {
            failing: {
                scorer: createScorer({
                    id: "failing",
                    name: "Failing",
                    description: "d",
                    score: async () => {
                        throw new Error("Scorer exploded");
                    },
                }),
            },
            working: {
                scorer: createScorer({
                    id: "working",
                    name: "Working",
                    description: "d",
                    score: async () => ({ score: 0.9 }),
                }),
            },
        };
        const results = await runScorersBatch(scorers, makeContext(), null);
        // Failing scorer should return null, not crash the batch
        expect(results.failing).toBeNull();
        expect(results.working?.score).toBe(0.9);
    });
    it("persists results to adapter when provided", async () => {
        const adapter = createMockAdapter();
        const scorers = {
            persisted: {
                scorer: createScorer({
                    id: "persisted",
                    name: "Persisted",
                    description: "d",
                    score: async () => ({ score: 0.75, reason: "Decent" }),
                }),
            },
        };
        await runScorersBatch(scorers, makeContext(), adapter);
        expect(adapter.insertScorerResult).toHaveBeenCalledTimes(1);
        const insertedRow = adapter.rows[0];
        expect(insertedRow).toBeDefined();
        expect(insertedRow.runId).toBe("run-1");
        expect(insertedRow.nodeId).toBe("task-1");
        expect(insertedRow.scorerId).toBe("persisted");
        expect(insertedRow.score).toBe(0.75);
        expect(insertedRow.reason).toBe("Decent");
        expect(insertedRow.source).toBe("batch");
    });
    it("emits scorer lifecycle events and persists circular values as strings", async () => {
        const adapter = createMockAdapter();
        const events = [];
        const circular = { label: "circle" };
        circular.self = circular;
        const scorers = {
            evented: {
                scorer: createScorer({
                    id: "evented",
                    name: "Evented",
                    description: "d",
                    score: async () => ({ score: 0.5, meta: { bucket: "mid" } }),
                }),
            },
        };
        const results = await runScorersBatch(
            scorers,
            makeContext({ input: circular, output: undefined }),
            adapter,
            { emit: (name, event) => events.push({ name, event }) },
        );
        expect(results.evented?.score).toBe(0.5);
        expect(events.map((entry) => entry.event.type)).toEqual([
            "ScorerStarted",
            "ScorerFinished",
        ]);
        expect(adapter.rows[0].inputJson).toBe("[object Object]");
        expect(adapter.rows[0].outputJson).toBeNull();
        expect(JSON.parse(adapter.rows[0].metaJson)).toEqual({ bucket: "mid" });
    });
    it("routes lifecycle events through the durable emitEventWithPersist path when available", async () => {
        const { Effect } = require("effect");
        const adapter = createMockAdapter();
        const persisted = [];
        const bareEmitted = [];
        const scorers = {
            durable: {
                scorer: createScorer({
                    id: "durable",
                    name: "Durable",
                    description: "d",
                    score: async () => ({ score: 0.7 }),
                }),
            },
        };
        await runScorersBatch(
            scorers,
            makeContext({ input: { a: 1 }, output: undefined }),
            adapter,
            {
                emit: (_name, event) => bareEmitted.push(event),
                emitEventWithPersist: (event) => Effect.sync(() => persisted.push(event)),
            },
        );
        // Durable path used (DB + NDJSON + metrics); bare live-only emit not used.
        expect(persisted.map((e) => e.type)).toEqual(["ScorerStarted", "ScorerFinished"]);
        expect(bareEmitted).toEqual([]);
    });
    it("emits failure events and runScorersAsync handles empty and non-empty maps", async () => {
        const failureEvents = [];
        await runScorersBatch(
            {
                failing: {
                    scorer: createScorer({
                        id: "failing-event",
                        name: "Failing Event",
                        description: "d",
                        score: async () => {
                            throw new Error("event failure");
                        },
                    }),
                },
            },
            makeContext(),
            null,
            { emit: (name, event) => failureEvents.push({ name, event }) },
        );
        expect(failureEvents.map((entry) => entry.event.type)).toEqual([
            "ScorerStarted",
            "ScorerFailed",
        ]);

        runScorersAsync({}, makeContext(), null);
        const asyncFinished = new Promise((resolve) => {
            runScorersAsync(
                {
                    asyncOne: {
                        scorer: createScorer({
                            id: "async-one",
                            name: "Async One",
                            description: "d",
                            score: async () => ({ score: 0.4 }),
                        }),
                    },
                },
                makeContext(),
                null,
                {
                    emit: (_name, event) => {
                        if (event.type === "ScorerFinished") {
                            resolve(event);
                        }
                    },
                },
            );
        });
        await expect(asyncFinished).resolves.toMatchObject({
            type: "ScorerFinished",
            scorerId: "async-one",
        });
    });
    it("ignores throwing bare event buses without aborting batch or async scoring", async () => {
        const batchResults = await runScorersBatch(
            {
                batch: {
                    scorer: createScorer({
                        id: "throwing-batch-bus",
                        name: "Throwing Batch Bus",
                        description: "d",
                        score: async () => ({ score: 0.8 }),
                    }),
                },
            },
            makeContext(),
            null,
            { emit: () => { throw new Error("bus unavailable"); } },
        );
        expect(batchResults.batch?.score).toBe(0.8);

        const asyncEvents = [];
        let firstEmit = true;
        runScorersAsync(
            {
                async: {
                    scorer: createScorer({
                        id: "throwing-async-bus",
                        name: "Throwing Async Bus",
                        description: "d",
                        score: async () => ({ score: 0.6 }),
                    }),
                },
            },
            makeContext(),
            null,
            {
                emit: (_name, event) => {
                    if (firstEmit) {
                        firstEmit = false;
                        throw new Error("bus unavailable");
                    }
                    asyncEvents.push(event);
                },
            },
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(asyncEvents.map((event) => event.type)).toEqual(["ScorerFinished"]);
    });
    it("runScorersAsync persists live rows through the adapter", async () => {
        let resolvePersisted;
        const persisted = new Promise((resolve) => {
            resolvePersisted = resolve;
        });
        const adapter = {
            rows: [],
            insertScorerResult: mock((row) => {
                adapter.rows.push(row);
                resolvePersisted(row);
                const { Effect } = require("effect");
                return Effect.succeed(undefined);
            }),
        };
        runScorersAsync(
            {
                asyncPersisted: {
                    scorer: createScorer({
                        id: "async-persisted",
                        name: "Async Persisted",
                        description: "d",
                        score: async () => ({
                            score: 0.42,
                            reason: "stored",
                            meta: { mode: "async" },
                        }),
                    }),
                },
            },
            makeContext(),
            adapter,
        );
        await expect(persisted).resolves.toMatchObject({
            runId: "run-1",
            nodeId: "task-1",
            scorerId: "async-persisted",
            scorerName: "Async Persisted",
            source: "live",
            score: 0.42,
            reason: "stored",
        });
        expect(adapter.insertScorerResult).toHaveBeenCalledTimes(1);
        expect(JSON.parse(adapter.rows[0].metaJson)).toEqual({ mode: "async" });
    });
    it("runScorersAsync handles persistence failures without throwing synchronously", async () => {
        const { Effect } = require("effect");
        const adapter = {
            insertScorerResult: mock(() =>
                Effect.fail(new Error("persist failed")),
            ),
        };
        expect(() =>
            runScorersAsync(
                {
                    asyncFailure: {
                        scorer: createScorer({
                            id: "async-failure",
                            name: "Async Failure",
                            description: "d",
                            score: async () => ({ score: 0.3 }),
                        }),
                    },
                },
                makeContext(),
                adapter,
            ),
        ).not.toThrow();
    });
    it("passes correct scorer input fields", async () => {
        let receivedInput;
        const scorers = {
            capture: {
                scorer: createScorer({
                    id: "capture",
                    name: "Capture",
                    description: "d",
                    score: async (input) => {
                        receivedInput = input;
                        return { score: 1 };
                    },
                }),
            },
        };
        const ctx = makeContext({
            input: "my prompt",
            output: { data: "my output" },
            latencyMs: 2500,
        });
        await runScorersBatch(scorers, ctx, null);
        expect(receivedInput.input).toBe("my prompt");
        expect(receivedInput.output).toEqual({ data: "my output" });
        expect(receivedInput.latencyMs).toBe(2500);
    });
    it("forwards context and groundTruth to scorers", async () => {
        let receivedInput;
        const scorers = {
            capture: {
                scorer: createScorer({
                    id: "capture-context",
                    name: "Capture Context",
                    description: "d",
                    score: async (input) => {
                        receivedInput = input;
                        return { score: input.context === "source material" ? 1 : 0 };
                    },
                }),
            },
        };
        const ctx = makeContext({
            context: "source material",
            groundTruth: { expected: "answer" },
        });
        const results = await runScorersBatch(scorers, ctx, null);
        expect(results.capture?.score).toBe(1);
        expect(receivedInput.context).toBe("source material");
        expect(receivedInput.groundTruth).toEqual({ expected: "answer" });
    });
    it("persists context and groundTruth JSON with scorer results", async () => {
        const adapter = createMockAdapter();
        const scorers = {
            persisted: {
                scorer: createScorer({
                    id: "persisted-context",
                    name: "Persisted Context",
                    description: "d",
                    score: async () => ({ score: 0.91 }),
                }),
            },
        };
        await runScorersBatch(scorers, makeContext({
            context: { docs: ["source-a"], traceId: "trace-1" },
            groundTruth: { expected: "answer" },
        }), adapter);
        expect(adapter.insertScorerResult).toHaveBeenCalledTimes(1);
        const insertedRow = adapter.rows[0];
        expect(JSON.parse(insertedRow.contextJson)).toEqual({
            docs: ["source-a"],
            traceId: "trace-1",
        });
        expect(JSON.parse(insertedRow.groundTruthJson)).toEqual({
            expected: "answer",
        });
    });
});

// ---------------------------------------------------------------------------
// Score validation / clamping (api-contract + crash-safety-durability)
//
// A custom scorer's score must be a finite number in [0, 1]. Out-of-range
// scores are clamped (matching llmJudge); missing/NaN/Infinity scores surface
// as SCORER_FAILED instead of silently corrupting aggregates or dropping the
// durable row while still emitting a ScorerFinished event (split-brain).
// These run against a real in-memory SmithersDb — no mocks of the unit.
// ---------------------------------------------------------------------------
describe("runScorersBatch score validation", () => {
    let adapter;
    beforeEach(() => {
        const sqlite = new Database(":memory:");
        const db = drizzle(sqlite);
        ensureSmithersTables(db);
        adapter = new SmithersDb(db);
    });
    /**
     * @param {string} id
     * @param {number} score
     */
    function scorerReturning(id, score) {
        return {
            scorer: createScorer({
                id,
                name: id,
                description: "d",
                score: async () => ({ score }),
            }),
        };
    }
    it("clamps an above-range score to 1 in the returned result, the DB row, and aggregates", async () => {
        const events = [];
        const results = await runScorersBatch({ s: scorerReturning("over", 5) }, makeContext({ runId: "clamp-over" }), adapter, { emit: (_name, event) => events.push(event) });
        expect(results.s?.score).toBe(1);
        expect(events.map((e) => e.type)).toEqual(["ScorerStarted", "ScorerFinished"]);
        expect(events[1].score).toBe(1);
        const rows = await adapter.listScorerResults("clamp-over");
        expect(rows).toHaveLength(1);
        expect(rows[0].score).toBe(1);
        const agg = await aggregateScores(adapter, { runId: "clamp-over" });
        expect(agg).toHaveLength(1);
        expect(agg[0].mean).toBe(1);
        expect(agg[0].min).toBe(1);
        expect(agg[0].max).toBe(1);
        expect(agg[0].p50).toBe(1);
        expect(agg[0].mean).toBeGreaterThanOrEqual(0);
        expect(agg[0].mean).toBeLessThanOrEqual(1);
    });
    it("clamps a below-range score to 0 in the returned result, the DB row, and aggregates", async () => {
        const results = await runScorersBatch({ s: scorerReturning("under", -1) }, makeContext({ runId: "clamp-under" }), adapter);
        expect(results.s?.score).toBe(0);
        const rows = await adapter.listScorerResults("clamp-under");
        expect(rows).toHaveLength(1);
        expect(rows[0].score).toBe(0);
        const agg = await aggregateScores(adapter, { runId: "clamp-under" });
        expect(agg[0].mean).toBe(0);
        expect(agg[0].min).toBe(0);
        expect(agg[0].max).toBe(0);
        expect(agg[0].p50).toBe(0);
    });
    it("leaves an in-range score untouched and preserves reason/meta", async () => {
        const results = await runScorersBatch({
            s: {
                scorer: createScorer({
                    id: "ok",
                    name: "ok",
                    description: "d",
                    score: async () => ({ score: 0.42, reason: "fine", meta: { k: "v" } }),
                }),
            },
        }, makeContext({ runId: "in-range" }), adapter);
        expect(results.s).toMatchObject({ score: 0.42, reason: "fine", meta: { k: "v" } });
        const rows = await adapter.listScorerResults("in-range");
        expect(rows[0].score).toBe(0.42);
        expect(rows[0].reason).toBe("fine");
        expect(JSON.parse(rows[0].metaJson)).toEqual({ k: "v" });
    });
    for (const [label, badScore] of [["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY], ["-Infinity", Number.NEGATIVE_INFINITY]]) {
        it(`surfaces a ${label} score as SCORER_FAILED (no Finished event, no row, scorersFailed) instead of corrupting aggregates`, async () => {
            const events = [];
            const results = await runScorersBatch({ s: scorerReturning("bad", badScore) }, makeContext({ runId: `bad-${label}` }), adapter, { emit: (_name, event) => events.push(event) });
            // Failed scorer surfaces as null, not a poisoned score.
            expect(results.s).toBeNull();
            const types = events.map((e) => e.type);
            expect(types).toContain("ScorerStarted");
            expect(types).toContain("ScorerFailed");
            // No split-brain: a Finished event must NOT accompany a failure.
            expect(types).not.toContain("ScorerFinished");
            const failed = events.find((e) => e.type === "ScorerFailed");
            expect(failed?.error).toMatch(/non-finite or missing score/i);
            // Event log and DB agree: zero rows persisted.
            const rows = await adapter.listScorerResults(`bad-${label}`);
            expect(rows).toHaveLength(0);
            // Aggregation is not poisoned.
            const agg = await aggregateScores(adapter, { runId: `bad-${label}` });
            expect(agg).toHaveLength(0);
        });
    }
    it("surfaces a missing score (malformed scorer result) as SCORER_FAILED with no silently-dropped row", async () => {
        const events = [];
        const results = await runScorersBatch({
            s: {
                scorer: createScorer({
                    id: "noscore",
                    name: "noscore",
                    description: "d",
                    // Forgets to return `score` — a real scorer-author mistake.
                    score: async () => ({ reason: "oops" }),
                }),
            },
        }, makeContext({ runId: "missing-score" }), adapter, { emit: (_name, event) => events.push(event) });
        expect(results.s).toBeNull();
        const types = events.map((e) => e.type);
        expect(types).toEqual(["ScorerStarted", "ScorerFailed"]);
        const rows = await adapter.listScorerResults("missing-score");
        expect(rows).toHaveLength(0);
    });
    it("isolates a malformed scorer: sibling healthy scorers still run and persist their rows", async () => {
        const results = await runScorersBatch({
            bad: scorerReturning("bad-sib", Number.NaN),
            good: scorerReturning("good-sib", 0.7),
        }, makeContext({ runId: "mixed" }), adapter);
        expect(results.bad).toBeNull();
        expect(results.good?.score).toBe(0.7);
        const rows = await adapter.listScorerResults("mixed");
        expect(rows).toHaveLength(1);
        expect(rows[0].scorerId).toBe("good-sib");
        expect(rows[0].score).toBe(0.7);
    });
});

// ---------------------------------------------------------------------------
// Deterministic ratio sampling (edge-case / replay-determinism)
//
// shouldRun's ratio branch must be a pure function of the scorer's durable
// identity (runId, nodeId, iteration, attempt, scorerId), NOT global
// Math.random(). Otherwise replaying/forking a checkpoint can flip a
// previously-skipped scorer to run (or vice versa), breaking deterministic
// replay and double-counting aggregates.
// ---------------------------------------------------------------------------
describe("ratio sampling determinism", () => {
    /**
     * @param {string} id
     * @param {number} rate
     */
    function ratioScorers(id, rate) {
        return {
            r: {
                scorer: createScorer({
                    id,
                    name: id,
                    description: "d",
                    score: async () => ({ score: 1 }),
                }),
                sampling: { type: "ratio", rate },
            },
        };
    }
    it("makes the SAME run/skip decision for the same identity across repeated runs (replay-stable)", async () => {
        // Two independent invocations with identical context and scorer identity
        // must agree — even though no global RNG is monkeypatched.
        const ctx = makeContext({ runId: "det-run", nodeId: "det-node", attempt: 1 });
        const decisions = [];
        for (let i = 0; i < 8; i++) {
            const res = await runScorersBatch(ratioScorers("det-scorer", 0.5), ctx, null);
            decisions.push(res.r === null ? "skip" : "run");
        }
        const unique = new Set(decisions);
        expect(unique.size).toBe(1);
    });
    it("persists exactly the same number of rows on replay of the same identity", async () => {
        const ctx = makeContext({ runId: "det-rows", nodeId: "det-node", attempt: 1 });
        const counts = [];
        for (let i = 0; i < 4; i++) {
            const sqlite = new Database(":memory:");
            const db = drizzle(sqlite);
            ensureSmithersTables(db);
            const adapter = new SmithersDb(db);
            await runScorersBatch(ratioScorers("det-scorer", 0.5), ctx, adapter);
            counts.push((await adapter.listScorerResults("det-rows")).length);
        }
        const unique = new Set(counts);
        expect(unique.size).toBe(1);
    });
    it("rate 0 always skips and rate 1 always runs, regardless of identity", async () => {
        for (const attempt of [1, 2, 3, 7, 42]) {
            const ctx = makeContext({ attempt });
            const skipped = await runScorersBatch(ratioScorers("edge", 0), ctx, null);
            expect(skipped.r).toBeNull();
            const ran = await runScorersBatch(ratioScorers("edge", 1), ctx, null);
            expect(ran.r?.score).toBe(1);
        }
    });
    it("can differ across different durable identities (e.g. attempt) while staying stable per-identity", async () => {
        // The sampler is seeded off identity, so different attempts may yield
        // different decisions — but each is itself reproducible. We assert that
        // across a spread of attempts at rate 0.5 we observe BOTH outcomes,
        // proving the decision actually varies with identity (not constant), and
        // that each individual attempt is stable when repeated.
        const outcomes = new Set();
        for (let attempt = 1; attempt <= 16; attempt++) {
            const ctx = makeContext({ runId: "spread", nodeId: "spread", attempt });
            const first = await runScorersBatch(ratioScorers("spread-scorer", 0.5), ctx, null);
            const second = await runScorersBatch(ratioScorers("spread-scorer", 0.5), ctx, null);
            const a = first.r === null ? "skip" : "run";
            const b = second.r === null ? "skip" : "run";
            expect(a).toBe(b); // per-identity stability
            outcomes.add(a);
        }
        expect(outcomes.has("run")).toBe(true);
        expect(outcomes.has("skip")).toBe(true);
    });
});
