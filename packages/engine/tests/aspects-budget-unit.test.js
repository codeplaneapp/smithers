import { describe, expect, test } from "bun:test";
import { estimateCostUsd } from "../src/aspects/estimateCostUsd.js";
import { createBudgetTracker } from "../src/aspects/createBudgetTracker.js";
import { evaluateAspectBudget } from "../src/aspects/evaluateAspectBudget.js";
import { setupBudgetTracker } from "../src/aspects/setupBudgetTracker.js";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { EventEmitter } from "node:events";

function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { adapter: new SmithersDb(db), db, sqlite };
}

describe("estimateCostUsd", () => {
    test("prices known model families above zero", () => {
        const opus = estimateCostUsd({ model: "claude-opus-4-8", inputTokens: 1_000_000, outputTokens: 0 });
        expect(opus).toBeGreaterThan(0);
        // Output is priced higher than input for opus.
        const opusOut = estimateCostUsd({ model: "claude-opus-4-8", inputTokens: 0, outputTokens: 1_000_000 });
        expect(opusOut).toBeGreaterThan(opus);
    });

    test("matches model id case-insensitively and by family substring", () => {
        const a = estimateCostUsd({ model: "CLAUDE-SONNET-4-6", inputTokens: 1_000_000, outputTokens: 0 });
        expect(a).toBeGreaterThan(0);
    });

    test("returns 0 for unknown models so cost simply cannot be estimated", () => {
        expect(estimateCostUsd({ model: "some-unknown-model", inputTokens: 5_000_000, outputTokens: 5_000_000 })).toBe(0);
        expect(estimateCostUsd({ inputTokens: 1_000_000 })).toBe(0);
        expect(estimateCostUsd(null)).toBe(0);
    });
});

describe("createBudgetTracker", () => {
    test("accumulates input + output tokens and cost", () => {
        const tracker = createBudgetTracker({ runStartMs: 1000 });
        tracker.recordUsage({ model: "claude-opus-4-8", inputTokens: 100, outputTokens: 50 });
        tracker.recordUsage({ model: "claude-opus-4-8", inputTokens: 10, outputTokens: 5 });
        expect(tracker.tokens).toBe(165);
        expect(tracker.costUsd).toBeGreaterThan(0);
    });

    test("snapshot reports elapsed wall-clock from run start", () => {
        const tracker = createBudgetTracker({ runStartMs: 1000 });
        const snap = tracker.snapshot(4000);
        expect(snap.elapsedMs).toBe(3000);
        expect(snap.tokens).toBe(0);
    });
});

describe("evaluateAspectBudget", () => {
    test("returns null when there are no aspects or no breach", () => {
        expect(evaluateAspectBudget(undefined, { tokens: 9e9, costUsd: 9e9, elapsedMs: 9e9 })).toBeNull();
        expect(evaluateAspectBudget({ tokenBudget: { max: 100 } }, { tokens: 99, costUsd: 0, elapsedMs: 0 })).toBeNull();
    });

    test("flags a token breach at or over the limit with default onExceeded fail", () => {
        const breach = evaluateAspectBudget({ tokenBudget: { max: 100 } }, { tokens: 100, costUsd: 0, elapsedMs: 0 });
        expect(breach).toEqual({ kind: "tokens", limit: 100, current: 100, onExceeded: "fail" });
    });

    test("honors a configured onExceeded mode", () => {
        const breach = evaluateAspectBudget({ tokenBudget: { max: 100, onExceeded: "skip-remaining" } }, { tokens: 120, costUsd: 0, elapsedMs: 0 });
        expect(breach?.onExceeded).toBe("skip-remaining");
    });

    test("flags cost and latency breaches", () => {
        expect(evaluateAspectBudget({ costBudget: { maxUsd: 5 } }, { tokens: 0, costUsd: 5, elapsedMs: 0 })?.kind).toBe("cost");
        expect(evaluateAspectBudget({ latencySlo: { maxMs: 1000 } }, { tokens: 0, costUsd: 0, elapsedMs: 1000 })?.kind).toBe("latency");
    });

    test("checks tokens before cost before latency", () => {
        const aspects = { tokenBudget: { max: 1 }, costBudget: { maxUsd: 1 }, latencySlo: { maxMs: 1 } };
        expect(evaluateAspectBudget(aspects, { tokens: 10, costUsd: 10, elapsedMs: 10 })?.kind).toBe("tokens");
    });
});

describe("setupBudgetTracker resume seeding", () => {
    test("seeds accumulated usage from persisted TokenUsageReported events", async () => {
        const { adapter } = createTestDb();
        const runId = "resume-run";
        await adapter.insertRun({
            runId,
            parentRunId: null,
            workflowName: "w",
            workflowPath: null,
            workflowHash: null,
            status: "running",
            createdAtMs: 1000,
            startedAtMs: 1000,
            finishedAtMs: null,
            heartbeatAtMs: 1000,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
            hijackRequestedAtMs: null,
            hijackTarget: null,
            errorJson: null,
        });
        await adapter.insertEvent({
            runId,
            seq: 0,
            timestampMs: 1000,
            type: "TokenUsageReported",
            payloadJson: JSON.stringify({
                type: "TokenUsageReported",
                runId,
                model: "claude-opus-4-8",
                inputTokens: 200,
                outputTokens: 100,
            }),
        });
        await adapter.insertEvent({
            runId,
            seq: 1,
            timestampMs: 1001,
            type: "TokenUsageReported",
            payloadJson: JSON.stringify({
                type: "TokenUsageReported",
                runId,
                model: "claude-opus-4-8",
                inputTokens: 50,
                outputTokens: 0,
            }),
        });

        const eventBus = new EventEmitter();
        const tracker = await setupBudgetTracker({ adapter, runId, eventBus, runStartMs: 1000 });
        expect(tracker.tokens).toBe(350);
        expect(tracker.costUsd).toBeGreaterThan(0);

        // Live events keep accumulating after seeding.
        eventBus.emit("event", { type: "TokenUsageReported", inputTokens: 10, outputTokens: 0, model: "claude-opus-4-8" });
        expect(tracker.tokens).toBe(360);
    });
});
