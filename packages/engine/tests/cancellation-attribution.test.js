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
  test.each([
    [
      "signal",
      {
        kind: "signal",
        detail: "worker received SIGTERM",
        signal: "SIGTERM",
        clientPid: 4321,
        requestId: "signal-request",
      },
    ],
    [
      "rpc",
      {
        kind: "rpc",
        detail: "http cancellation request",
        clientPid: 5432,
        requestId: "rpc-request",
        clientIdentity: "user:operator",
      },
    ],
    ["cli", { kind: "cli", detail: "smithers cancel cli-run", clientPid: 6543 }],
    ["engine", { kind: "engine", detail: "task heartbeat timed out" }],
  ])("persists %s attribution on the terminal row and RunCancelled event", async (kind, attribution) => {
    const adapter = createAdapter();
    const runId = `${kind}-run`;
    await insertRunningRun(adapter, runId);

    const result = await finalizeCancelledRun(adapter, runId, { now: 1234, attribution });

    expect(result.won).toBe(true);
    expect(await adapter.getRun(runId)).toMatchObject({
      status: "cancelled",
      cancelRequestSource: attribution.kind,
      cancelRequestDetail: attribution.detail ?? null,
      cancelRequestSignal: attribution.signal ?? null,
      cancelRequestClientPid: attribution.clientPid ?? null,
      cancelRequestId: attribution.requestId ?? null,
      cancelRequestClientIdentity: attribution.clientIdentity ?? null,
    });
    const event = (await adapter.listEventsByType(runId, "RunCancelled")).at(-1);
    expect(JSON.parse(event.payloadJson)).toEqual({
      type: "RunCancelled",
      runId,
      timestampMs: 1234,
      source: attribution,
    });
  });

  test("preserves previously requested attribution over a competing engine finalization", async () => {
    const adapter = createAdapter();
    await insertRunningRun(adapter, "requested-run");
    await adapter.requestRunCancel("requested-run", 2000, {
      requestId: "gateway-request",
      transport: "websocket",
    });

    await finalizeCancelledRun(adapter, "requested-run", {
      now: 2001,
      attribution: {
        kind: "engine",
        detail: "engine cleanup raced the RPC request",
      },
    });

    expect(await adapter.getRun("requested-run")).toMatchObject({
      cancelRequestSource: "rpc",
      cancelRequestDetail: "websocket cancellation request",
      cancelRequestId: "gateway-request",
    });

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

  test("does not relabel an unattributed durable request as engine cleanup", async () => {
    const adapter = createAdapter();
    await insertRunningRun(adapter, "legacy-request-run");
    await adapter.requestRunCancel("legacy-request-run", 4000);

    await finalizeCancelledRun(adapter, "legacy-request-run", {
      now: 4001,
      attribution: {
        kind: "engine",
        detail: "engine observed the durable request",
      },
    });

    expect((await adapter.getRun("legacy-request-run"))?.cancelRequestSource).toBeNull();
    const event = (await adapter.listEventsByType("legacy-request-run", "RunCancelled")).at(-1);
    expect(JSON.parse(event.payloadJson)).toEqual({
      type: "RunCancelled",
      runId: "legacy-request-run",
      timestampMs: 4001,
    });
  });
});
