import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";
import { deriveRunState } from "../src/runState/deriveRunState.js";
import { parseEventMeta } from "../src/runState/parseEventMeta.js";
import { parseTimerMeta } from "../src/runState/parseTimerMeta.js";
import { computeRunState } from "../src/runState/computeRunState.js";
import { computeRunStateFromRow } from "../src/runState/computeRunStateFromRow.js";

function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { adapter: new SmithersDb(db), sqlite };
}

const now = 1_700_000_000_000;
const runRow = (runId, status, extra = {}) => ({ runId, workflowName: "wf", status, createdAtMs: now, ...extra });

/** Mirrors the engine's `buildWaitForEventAttemptMeta` output. */
const waitForEventMetaJson = ({ signalName, correlationId = null }) => JSON.stringify({
    kind: "wait-for-event",
    waitForEvent: {
        signalName,
        correlationId,
        onTimeout: "fail",
        timeoutMs: undefined,
        waitAsync: false,
        startedAtMs: now,
        resolvedSignalSeq: null,
        receivedAtMs: null,
        timedOutAtMs: null,
    },
});

describe("parseTimerMeta", () => {
    test("parses a finite firesAtMs", () => {
        expect(parseTimerMeta(JSON.stringify({ timer: { firesAtMs: 1234.9 } }))).toEqual({ firesAtMs: 1234 });
    });
    test("returns null for missing / non-finite / malformed / absent", () => {
        expect(parseTimerMeta(JSON.stringify({ timer: { firesAtMs: "nope" } }))).toBeNull();
        expect(parseTimerMeta(JSON.stringify({ other: 1 }))).toBeNull();
        expect(parseTimerMeta("{not json")).toBeNull();
        expect(parseTimerMeta(null)).toBeNull();
        expect(parseTimerMeta(undefined)).toBeNull();
    });
});

describe("parseEventMeta", () => {
    test("reads the engine's wait-for-event shape, preferring correlationId", () => {
        expect(parseEventMeta(waitForEventMetaJson({ signalName: "issue-42", correlationId: "order:42" })))
            .toEqual({ correlationKey: "order:42" });
    });
    test("falls back to signalName when the wait declares no correlationId", () => {
        expect(parseEventMeta(waitForEventMetaJson({ signalName: "issue-42", correlationId: null })))
            .toEqual({ correlationKey: "issue-42" });
        expect(parseEventMeta(waitForEventMetaJson({ signalName: "issue-42", correlationId: "  " })))
            .toEqual({ correlationKey: "issue-42" });
    });
    test("returns null for a missing signalName / malformed / absent", () => {
        expect(parseEventMeta(JSON.stringify({ kind: "wait-for-event", waitForEvent: { correlationId: "ck" } }))).toBeNull();
        expect(parseEventMeta(JSON.stringify({ event: { correlationKey: "legacy" } }))).toBeNull();
        expect(parseEventMeta("{bad")).toBeNull();
        expect(parseEventMeta(null)).toBeNull();
    });
});

describe("deriveRunState terminal + waiting states", () => {
    test("terminal statuses", () => {
        expect(deriveRunState({ run: runRow("r", "finished") }).state).toBe("succeeded");
        expect(deriveRunState({ run: runRow("r", "continued") }).state).toBe("succeeded");
        expect(deriveRunState({ run: runRow("r", "failed") }).state).toBe("failed");
        expect(deriveRunState({ run: runRow("r", "cancelled") }).state).toBe("cancelled");
        expect(deriveRunState({ run: runRow("r", "paused") }).state).toBe("paused");
        expect(deriveRunState({ run: runRow("r", "bogus-status") }).state).toBe("unknown");
    });

    test("waiting-approval with and without a pending approval", () => {
        const withApproval = deriveRunState({
            run: runRow("r", "waiting-approval"),
            pendingApproval: { nodeId: "n1", requestedAtMs: now },
        });
        expect(withApproval.state).toBe("waiting-approval");
        expect(withApproval.blocked).toEqual({ kind: "approval", nodeId: "n1", requestedAt: new Date(now).toISOString() });
        expect(deriveRunState({ run: runRow("r", "waiting-approval") }).blocked).toBeUndefined();
    });

    test("waiting-timer: within grace vs overdue-unhealthy vs no pending timer", () => {
        const firesAtMs = now - 10;
        const healthy = deriveRunState({ run: runRow("r", "waiting-timer"), pendingTimer: { nodeId: "t", firesAtMs }, now });
        expect(healthy.state).toBe("waiting-timer");
        expect(healthy.unhealthy).toBeUndefined();

        const overdue = deriveRunState({
            run: runRow("r", "waiting-timer"),
            pendingTimer: { nodeId: "t", firesAtMs: now - 10_000 },
            now,
            timerOverdueGraceMs: 1000,
        });
        expect(overdue.unhealthy?.kind).toBe("timer-overdue");
        expect(overdue.unhealthy?.overdueMs).toBeGreaterThan(0);

        expect(deriveRunState({ run: runRow("r", "waiting-timer") }).blocked).toBeUndefined();
    });

    test("waiting-event: pending event vs parked block vs bare", () => {
        const pending = deriveRunState({
            run: runRow("r", "waiting-event"),
            pendingEvent: { nodeId: "e", correlationKey: "ck" },
        });
        expect(pending.blocked).toEqual({ kind: "event", nodeId: "e", correlationKey: "ck" });

        const parked = deriveRunState({
            run: runRow("r", "waiting-event"),
            parkedEventBlock: { kind: "external-trigger" },
        });
        expect(parked.blocked).toEqual({ kind: "external-trigger" });

        expect(deriveRunState({ run: runRow("r", "waiting-event") }).blocked).toBeUndefined();
    });

    test("waiting-quota: with quota meta, without, and malformed errorJson", () => {
        const withMeta = deriveRunState({
            run: runRow("r", "waiting-quota", { errorJson: JSON.stringify({ quotaBlockedCount: 3, resetAtMs: now + 5000 }) }),
        });
        expect(withMeta.blocked).toEqual({ kind: "quota", quotaBlockedCount: 3, resetAtMs: now + 5000 });

        const countOnly = deriveRunState({
            run: runRow("r", "waiting-quota", { errorJson: JSON.stringify({ quotaBlockedCount: 1 }) }),
        });
        expect(countOnly.blocked).toEqual({ kind: "quota", quotaBlockedCount: 1 });

        const noMeta = deriveRunState({ run: runRow("r", "waiting-quota") });
        expect(noMeta.state).toBe("waiting-quota");
        expect(noMeta.blocked).toBeUndefined();

        const malformed = deriveRunState({ run: runRow("r", "waiting-quota", { errorJson: "{bad" }) });
        expect(malformed.state).toBe("waiting-quota");
        expect(malformed.blocked).toBeUndefined();
    });

    test("running: healthy, stale (owned), orphaned (no owner), and unknown (no timestamps)", () => {
        const healthy = deriveRunState({ run: runRow("r", "running", { heartbeatAtMs: now }), now, staleThresholdMs: 1000 });
        expect(healthy.state).toBe("running");

        const stale = deriveRunState({
            run: runRow("r", "running", { heartbeatAtMs: now - 10_000, runtimeOwnerId: "owner" }),
            now,
            staleThresholdMs: 1000,
        });
        expect(stale.state).toBe("stale");
        expect(stale.unhealthy?.kind).toBe("engine-heartbeat-stale");

        const orphaned = deriveRunState({
            run: runRow("r", "running", { startedAtMs: now - 10_000 }),
            now,
            staleThresholdMs: 1000,
        });
        expect(orphaned.state).toBe("orphaned");

        const unknown = deriveRunState({ run: runRow("r", "running"), now });
        expect(unknown.state).toBe("unknown");
    });

    test("now defaults to Date.now() when omitted", () => {
        const view = deriveRunState({ run: runRow("r", "finished") });
        expect(typeof view.computedAt).toBe("string");
        expect(Number.isNaN(Date.parse(view.computedAt))).toBe(false);
    });
});

describe("computeRunState / computeRunStateFromRow against a real adapter", () => {
    test("computeRunState throws RUN_NOT_FOUND for a missing run", async () => {
        const { adapter } = createTestDb();
        await expect(computeRunState(adapter, "missing")).rejects.toThrow(/Run not found/);
    });

    test("waiting-approval loads the earliest pending approval", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun(runRow("r1", "waiting-approval"));
        await adapter.insertOrUpdateApproval({ runId: "r1", nodeId: "late", iteration: 0, status: "requested", requestedAtMs: now + 100 });
        await adapter.insertOrUpdateApproval({ runId: "r1", nodeId: "early", iteration: 0, status: "requested", requestedAtMs: now });
        const view = await computeRunState(adapter, "r1");
        expect(view.state).toBe("waiting-approval");
        expect(view.blocked?.nodeId).toBe("early");
    });

    test("waiting-timer loads the earliest waiting-timer attempt metadata", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun(runRow("r2", "waiting-timer"));
        await adapter.insertNode({ runId: "r2", nodeId: "timer", iteration: 0, state: "waiting-timer", updatedAtMs: now, outputTable: "out", label: null });
        await adapter.insertAttempt({ runId: "r2", nodeId: "timer", iteration: 0, attempt: 1, state: "waiting-timer", startedAtMs: now, metaJson: JSON.stringify({ timer: { firesAtMs: now + 60_000 } }) });
        const view = await computeRunStateFromRow(adapter, await adapter.getRun("r2"), { now });
        expect(view.state).toBe("waiting-timer");
        expect(view.blocked).toEqual({ kind: "timer", nodeId: "timer", wakeAt: new Date(now + 60_000).toISOString() });
    });

    test("waiting-event loads the correlation key from the waiting-event attempt", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun(runRow("r3", "waiting-event"));
        await adapter.insertNode({ runId: "r3", nodeId: "evt", iteration: 0, state: "waiting-event", updatedAtMs: now, outputTable: "out", label: null });
        await adapter.insertAttempt({ runId: "r3", nodeId: "evt", iteration: 0, attempt: 1, state: "waiting-event", startedAtMs: now, metaJson: waitForEventMetaJson({ signalName: "sig-3", correlationId: "ck-3" }) });
        const view = await computeRunState(adapter, "r3");
        expect(view.blocked).toEqual({ kind: "event", nodeId: "evt", correlationKey: "ck-3" });
    });

    test("waiting-event with no waiting-event node → parked block: pending node yields approval-decided-resume-required", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun(runRow("r4", "waiting-event"));
        await adapter.insertNode({ runId: "r4", nodeId: "p", iteration: 0, state: "pending", updatedAtMs: now, outputTable: "out", label: null });
        const view = await computeRunState(adapter, "r4");
        expect(view.blocked).toEqual({ kind: "approval-decided-resume-required", nodeId: "p" });
    });

    test("waiting-event with no waiting-event and no pending node → external-trigger", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun(runRow("r5", "waiting-event"));
        await adapter.insertNode({ runId: "r5", nodeId: "done", iteration: 0, state: "finished", updatedAtMs: now, outputTable: "out", label: null });
        const view = await computeRunState(adapter, "r5");
        expect(view.blocked).toEqual({ kind: "external-trigger" });
    });
});
