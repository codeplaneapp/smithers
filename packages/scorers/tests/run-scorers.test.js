import { describe, expect, it, mock } from "bun:test";
import { createScorer } from "../src/create-scorer.js";
import { runScorersAsync, runScorersBatch } from "../src/run-scorers.js";
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
    it("respects ratio sampling and falls back to running unknown sampling types", async () => {
        const originalRandom = Math.random;
        const scoreFn = mock(async () => ({ score: 1 }));
        try {
            Math.random = () => 0.75;
            let results = await runScorersBatch({
                ratio: {
                    scorer: createScorer({
                        id: "ratio",
                        name: "Ratio",
                        description: "d",
                        score: scoreFn,
                    }),
                    sampling: { type: "ratio", rate: 0.5 },
                },
            }, makeContext(), null);
            expect(results.ratio).toBeNull();

            Math.random = () => 0.25;
            results = await runScorersBatch({
                ratio: {
                    scorer: createScorer({
                        id: "ratio",
                        name: "Ratio",
                        description: "d",
                        score: scoreFn,
                    }),
                    sampling: { type: "ratio", rate: 0.5 },
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
        } finally {
            Math.random = originalRandom;
        }
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
});
