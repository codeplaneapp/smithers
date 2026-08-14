import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../../db/src/adapter.js";
import { ensureSmithersTables } from "../../db/src/ensure.js";
import { finalizeCancelledRun } from "../src/engine.js";

const databases = [];

afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});

function createAdapter() {
  const sqlite = new Database(":memory:");
  databases.push(sqlite);
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return new SmithersDb(db);
}

async function insertRunningRun(adapter, runId) {
  const now = Date.now();
  await adapter.insertRun({
    runId,
    workflowName: "cancellation-attribution",
    status: "running",
    createdAtMs: now - 100,
    startedAtMs: now - 50,
    heartbeatAtMs: now,
  });
}

describe("cancellation attribution contract", () => {
  test("persists explicit attribution on the terminal row and RunCancelled event", async () => {
    const adapter = createAdapter();
    await insertRunningRun(adapter, "signal-run");

    const result = await finalizeCancelledRun(adapter, "signal-run", {
      now: 1234,
      attribution: {
        kind: "signal",
        detail: "worker received SIGTERM",
        signal: "SIGTERM",
        clientPid: 4321,
        requestId: "request-1",
      },
    });

    expect(result.won).toBe(true);
    expect(await adapter.getRun("signal-run")).toMatchObject({
      status: "cancelled",
      cancelRequestSource: "signal",
      cancelRequestDetail: "worker received SIGTERM",
      cancelRequestSignal: "SIGTERM",
      cancelRequestClientPid: 4321,
      cancelRequestId: "request-1",
    });
    const event = (await adapter.listEventsByType("signal-run", "RunCancelled")).at(-1);
    expect(JSON.parse(event.payloadJson)).toEqual({
      type: "RunCancelled",
      runId: "signal-run",
      timestampMs: 1234,
      source: {
        kind: "signal",
        detail: "worker received SIGTERM",
        signal: "SIGTERM",
        clientPid: 4321,
        requestId: "request-1",
      },
    });
  });

  test("serializes previously requested attribution during finalization", async () => {
    const adapter = createAdapter();
    await insertRunningRun(adapter, "requested-run");
    await adapter.requestRunCancel("requested-run", 2000, {
      requestId: "gateway-request",
      transport: "websocket",
    });

    await finalizeCancelledRun(adapter, "requested-run", { now: 2001 });

    const event = (await adapter.listEventsByType("requested-run", "RunCancelled")).at(-1);
    expect(JSON.parse(event.payloadJson).source).toEqual({
      kind: "rpc",
      detail: "websocket cancellation request",
      requestId: "gateway-request",
    });
  });

  test("keeps source optional for unattributed cancellations", async () => {
    const adapter = createAdapter();
    await insertRunningRun(adapter, "unattributed-run");

    await finalizeCancelledRun(adapter, "unattributed-run", { now: 3000 });

    const event = (await adapter.listEventsByType("unattributed-run", "RunCancelled")).at(-1);
    expect(JSON.parse(event.payloadJson)).toEqual({
      type: "RunCancelled",
      runId: "unattributed-run",
      timestampMs: 3000,
    });
  });
});
