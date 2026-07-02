import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";
import { parseWaitForEventAttemptSnapshot, normalizeWaitForEventCorrelationId, } from "../src/waitForEventAttempt.js";

function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { adapter: new SmithersDb(db), sqlite };
}

/**
 * @param {SmithersDb} adapter
 * @param {{ runId: string; signalName: string; correlationId?: string | null; runStatus?: string; nodeState?: string; metaJson?: string | null }} options
 */
async function seedWait(adapter, options) {
    const { runId, signalName, correlationId = null, runStatus = "waiting-event", nodeState = "waiting-event", metaJson, } = options;
    const now = Date.now();
    await adapter.insertRun({ runId, workflowName: "wf", status: runStatus, createdAtMs: now });
    await adapter.insertNode({
        runId,
        nodeId: "wait",
        iteration: 0,
        state: nodeState,
        lastAttempt: 1,
        updatedAtMs: now,
        outputTable: "",
        label: null,
    });
    await adapter.insertAttempt({
        runId,
        nodeId: "wait",
        iteration: 0,
        attempt: 1,
        state: nodeState,
        startedAtMs: now,
        finishedAtMs: null,
        errorJson: null,
        metaJson: metaJson !== undefined
            ? metaJson
            : JSON.stringify({ kind: "wait-for-event", waitForEvent: { signalName, correlationId, waitAsync: false } }),
        responseText: null,
        cached: false,
        jjPointer: null,
        jjCwd: null,
    });
}

describe("integration delivery dedupe", () => {
    test("insertIntegrationDeliveryIfNew returns true first, false on redelivery", async () => {
        const { adapter } = createTestDb();
        const row = { sourceId: "github", dedupeKey: "guid-1", eventName: "integration:github:push", receivedAtMs: Date.now() };
        expect(await adapter.insertIntegrationDeliveryIfNew(row)).toBe(true);
        expect(await adapter.insertIntegrationDeliveryIfNew(row)).toBe(false);
        expect(await adapter.insertIntegrationDeliveryIfNew({ ...row, dedupeKey: "guid-2" })).toBe(true);
    });
});

describe("integration cursors", () => {
    test("get/set cursor round-trips and upserts", async () => {
        const { adapter } = createTestDb();
        expect(await adapter.getIntegrationCursor("telegram")).toBeUndefined();
        await adapter.setIntegrationCursor("telegram", "100");
        expect(await adapter.getIntegrationCursor("telegram")).toBe("100");
        await adapter.setIntegrationCursor("telegram", "101");
        expect(await adapter.getIntegrationCursor("telegram")).toBe("101");
        await adapter.setIntegrationCursor("telegram", null);
        expect(await adapter.getIntegrationCursor("telegram")).toBeNull();
    });
});

describe("findRunsAwaitingEvent", () => {
    test("matches waiting-event runs by signal name + normalized correlationId", async () => {
        const { adapter } = createTestDb();
        await seedWait(adapter, { runId: "r1", signalName: "integration:test:ping", correlationId: "c1" });
        await seedWait(adapter, { runId: "r2", signalName: "integration:test:ping", correlationId: "other" });
        await seedWait(adapter, { runId: "r3", signalName: "integration:test:pong", correlationId: "c1" });
        expect(await adapter.findRunsAwaitingEvent("integration:test:ping", "c1")).toEqual(["r1"]);
        expect(await adapter.findRunsAwaitingEvent("integration:test:ping", "  c1  ")).toEqual(["r1"]);
        expect(await adapter.findRunsAwaitingEvent("integration:test:ping", "nope")).toEqual([]);
    });
    test("excludes terminal runs, resolved waits, and malformed metadata", async () => {
        const { adapter } = createTestDb();
        await seedWait(adapter, { runId: "done", signalName: "integration:test:ping", correlationId: "c1", runStatus: "finished" });
        await seedWait(adapter, { runId: "resolved", signalName: "resolved-run", correlationId: null });
        // Mark the resolved run's wait as already resolved.
        await adapter.updateAttempt("resolved", "wait", 0, 1, {
            metaJson: JSON.stringify({ kind: "wait-for-event", waitForEvent: { signalName: "integration:test:ping", correlationId: "c1", resolvedSignalSeq: 0, receivedAtMs: Date.now() } }),
        });
        await seedWait(adapter, { runId: "garbage", signalName: "integration:test:ping", correlationId: "c1", metaJson: "{not json" });
        expect(await adapter.findRunsAwaitingEvent("integration:test:ping", "c1")).toEqual([]);
    });
});

describe("waitForEventAttempt shared parser", () => {
    test("parses the engine-stamped wait-for-event meta shape", () => {
        const snapshot = parseWaitForEventAttemptSnapshot(JSON.stringify({
            waitForEvent: { signalName: " deploy.ready ", correlationId: " c1 ", waitAsync: true },
        }));
        expect(snapshot).toMatchObject({
            signalName: "deploy.ready",
            correlationId: "c1",
            waitAsync: true,
        });
        expect(parseWaitForEventAttemptSnapshot(null)).toBeNull();
        expect(parseWaitForEventAttemptSnapshot("{}")).toBeNull();
        expect(parseWaitForEventAttemptSnapshot("not json")).toBeNull();
    });
    test("normalizeWaitForEventCorrelationId trims and nulls blanks", () => {
        expect(normalizeWaitForEventCorrelationId("  x ")).toBe("x");
        expect(normalizeWaitForEventCorrelationId("   ")).toBeNull();
        expect(normalizeWaitForEventCorrelationId(undefined)).toBeNull();
    });
});
