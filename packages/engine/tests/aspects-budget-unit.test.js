import { describe, expect, test } from "bun:test";
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

describe("createBudgetTracker", () => {
    test("accumulates input + output tokens", () => {
        const tracker = createBudgetTracker({ runStartMs: 1000 });
        tracker.recordUsage({ inputTokens: 100, outputTokens: 50 });
        tracker.recordUsage({ inputTokens: 10, outputTokens: 5 });
        expect(tracker.tokens).toBe(165);
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
        expect(evaluateAspectBudget(undefined, { tokens: 9e9, elapsedMs: 9e9 })).toBeNull();
        expect(evaluateAspectBudget({ tokenBudget: { max: 100 } }, { tokens: 99, elapsedMs: 0 })).toBeNull();
    });

    test("flags a token breach at or over the limit with default onExceeded fail", () => {
        const breach = evaluateAspectBudget({ tokenBudget: { max: 100 } }, { tokens: 100, elapsedMs: 0 });
        expect(breach).toEqual({ kind: "tokens", limit: 100, current: 100, onExceeded: "fail" });
    });

    test("honors a configured onExceeded mode", () => {
        const breach = evaluateAspectBudget({ tokenBudget: { max: 100, onExceeded: "skip-remaining" } }, { tokens: 120, elapsedMs: 0 });
        expect(breach?.onExceeded).toBe("skip-remaining");
    });

    test("flags a latency breach", () => {
        expect(evaluateAspectBudget({ latencySlo: { maxMs: 1000 } }, { tokens: 0, elapsedMs: 1000 })?.kind).toBe("latency");
    });

    test("checks tokens before latency", () => {
        const aspects = { tokenBudget: { max: 1 }, latencySlo: { maxMs: 1 } };
        expect(evaluateAspectBudget(aspects, { tokens: 10, elapsedMs: 10 })?.kind).toBe("tokens");
    });
});

describe("setupBudgetTracker resume seeding", () => {
    test("seeds accumulated token usage from persisted TokenUsageReported events", async () => {
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
            payloadJson: JSON.stringify({ type: "TokenUsageReported", runId, inputTokens: 200, outputTokens: 100 }),
        });
        await adapter.insertEvent({
            runId,
            seq: 1,
            timestampMs: 1001,
            type: "TokenUsageReported",
            payloadJson: JSON.stringify({ type: "TokenUsageReported", runId, inputTokens: 50, outputTokens: 0 }),
        });

        const eventBus = new EventEmitter();
        const tracker = await setupBudgetTracker({ adapter, runId, eventBus, runStartMs: 1000 });
        expect(tracker.tokens).toBe(350);

        // Live events keep accumulating after seeding.
        eventBus.emit("event", { type: "TokenUsageReported", inputTokens: 10, outputTokens: 0 });
        expect(tracker.tokens).toBe(360);
    });
});
