import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";
import { parseWaitForEventAttemptSnapshot, normalizeWaitForEventCorrelationId } from "../src/waitForEventAttempt.js";

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
  const {
    runId,
    signalName,
    correlationId = null,
    runStatus = "waiting-event",
    nodeState = "waiting-event",
    metaJson,
  } = options;
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
    metaJson:
      metaJson !== undefined
        ? metaJson
        : JSON.stringify({ kind: "wait-for-event", waitForEvent: { signalName, correlationId, waitAsync: false } }),
    responseText: null,
    cached: false,
    jjPointer: null,
    jjCwd: null,
  });
}

describe("integration delivery claims", () => {
  test("legacy insert-if-new API remains a permanent dedupe ledger", async () => {
    const { adapter } = createTestDb();
    const row = {
      sourceId: "webhook",
      dedupeKey: "delivery-1",
      eventName: "integration:webhook:push",
      receivedAtMs: 1_000,
    };
    expect(await adapter.insertIntegrationDeliveryIfNew(row)).toBe(true);
    expect(await adapter.insertIntegrationDeliveryIfNew({ ...row, receivedAtMs: 9_999 })).toBe(false);
    const claim = await adapter.claimIntegrationDelivery(row, { ownerToken: "owner-a", nowMs: 2_000 });
    expect(claim).toMatchObject({ status: "completed", receivedAtMs: 1_000 });
  });
  test("one concurrent owner claims while the duplicate stays busy with the canonical timestamp", async () => {
    const { adapter } = createTestDb();
    const row = { sourceId: "github", dedupeKey: "guid-1", eventName: "integration:github:push", receivedAtMs: 1_000 };
    const [first, duplicate] = await Promise.all([
      adapter.claimIntegrationDelivery(row, { ownerToken: "owner-a", nowMs: 2_000, leaseDurationMs: 5_000 }),
      adapter.claimIntegrationDelivery(
        { ...row, receivedAtMs: 9_999 },
        { ownerToken: "owner-b", nowMs: 2_000, leaseDurationMs: 5_000 },
      ),
    ]);
    expect([first.status, duplicate.status].sort()).toEqual(["busy", "claimed"]);
    expect(first.receivedAtMs).toBe(1_000);
    expect(duplicate.receivedAtMs).toBe(1_000);
  });
  test("completed claims suppress duplicates and preserve first receivedAtMs", async () => {
    const { adapter } = createTestDb();
    const row = {
      sourceId: "telegram",
      dedupeKey: "update:1",
      eventName: "integration:telegram:message",
      receivedAtMs: 1_000,
    };
    expect((await adapter.claimIntegrationDelivery(row, { ownerToken: "owner-a", nowMs: 2_000 })).status).toBe(
      "claimed",
    );
    expect(await adapter.completeIntegrationDelivery("telegram", "update:1", "owner-a", 2_100)).toBe(true);
    const replay = await adapter.claimIntegrationDelivery(
      { ...row, receivedAtMs: 9_999 },
      { ownerToken: "owner-b", nowMs: 3_000 },
    );
    expect(replay).toMatchObject({ status: "completed", receivedAtMs: 1_000 });
    expect(await adapter.releaseIntegrationDeliveryClaim("telegram", "update:1", "owner-a")).toBe(false);
  });
  test("released pending claims retry immediately and expired leases can be taken over", async () => {
    const { adapter } = createTestDb();
    const row = { sourceId: "linear", dedupeKey: "evt-1", eventName: "integration:linear:update", receivedAtMs: 1_000 };
    expect(
      (await adapter.claimIntegrationDelivery(row, { ownerToken: "owner-a", nowMs: 2_000, leaseDurationMs: 1_000 }))
        .status,
    ).toBe("claimed");
    expect(await adapter.releaseIntegrationDeliveryClaim("linear", "evt-1", "owner-a")).toBe(true);
    expect(
      (
        await adapter.claimIntegrationDelivery(
          { ...row, receivedAtMs: 4_000 },
          { ownerToken: "owner-b", nowMs: 2_100, leaseDurationMs: 1_000 },
        )
      ).status,
    ).toBe("claimed");
    expect(await adapter.renewIntegrationDeliveryClaim("linear", "evt-1", "owner-b", 2_400, 1_000)).toBe(true);
    expect(
      (await adapter.claimIntegrationDelivery(row, { ownerToken: "owner-c", nowMs: 2_500, leaseDurationMs: 1_000 }))
        .status,
    ).toBe("busy");
    const takeover = await adapter.claimIntegrationDelivery(row, {
      ownerToken: "owner-c",
      nowMs: 3_401,
      leaseDurationMs: 1_000,
    });
    expect(takeover).toMatchObject({ status: "claimed", receivedAtMs: 1_000 });
    expect(await adapter.renewIntegrationDeliveryClaim("linear", "evt-1", "owner-b", 3_500, 1_000)).toBe(false);
    expect(await adapter.completeIntegrationDelivery("linear", "evt-1", "owner-b", 3_200)).toBe(false);
    expect(await adapter.completeIntegrationDelivery("linear", "evt-1", "owner-c", 3_200)).toBe(true);
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
    await seedWait(adapter, {
      runId: "done",
      signalName: "integration:test:ping",
      correlationId: "c1",
      runStatus: "finished",
    });
    await seedWait(adapter, { runId: "resolved", signalName: "resolved-run", correlationId: null });
    // Mark the resolved run's wait as already resolved.
    await adapter.updateAttempt("resolved", "wait", 0, 1, {
      metaJson: JSON.stringify({
        kind: "wait-for-event",
        waitForEvent: {
          signalName: "integration:test:ping",
          correlationId: "c1",
          resolvedSignalSeq: 0,
          receivedAtMs: Date.now(),
        },
      }),
    });
    await seedWait(adapter, {
      runId: "garbage",
      signalName: "integration:test:ping",
      correlationId: "c1",
      metaJson: "{not json",
    });
    expect(await adapter.findRunsAwaitingEvent("integration:test:ping", "c1")).toEqual([]);
  });
});

describe("waitForEventAttempt shared parser", () => {
  test("parses the engine-stamped wait-for-event meta shape", () => {
    const snapshot = parseWaitForEventAttemptSnapshot(
      JSON.stringify({
        waitForEvent: { signalName: " deploy.ready ", correlationId: " c1 ", waitAsync: true },
      }),
    );
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
