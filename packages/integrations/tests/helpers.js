import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";

/**
 * Real in-memory Smithers db + adapter (no mocks).
 */
export function createTestAdapter() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), db, sqlite };
}

/**
 * Seed a run with a node parked on `WaitForEvent(signalName, correlationId)`
 * exactly the way the engine records it (node + attempt in `waiting-event`
 * state, attempt meta_json carrying the waitForEvent snapshot).
 * @param {SmithersDb} adapter
 * @param {{ runId: string; signalName: string; correlationId?: string | null; nodeId?: string; runStatus?: string }} options
 */
export async function seedWaitingEventRun(adapter, options) {
  const { runId, signalName, correlationId = null, nodeId = "wait-node", runStatus = "waiting-event" } = options;
  const now = Date.now();
  await adapter.insertRun({
    runId,
    workflowName: "integration-test-flow",
    status: runStatus,
    createdAtMs: now,
  });
  await adapter.insertNode({
    runId,
    nodeId,
    iteration: 0,
    state: "waiting-event",
    lastAttempt: 1,
    updatedAtMs: now,
    outputTable: "",
    label: null,
  });
  await adapter.insertAttempt({
    runId,
    nodeId,
    iteration: 0,
    attempt: 1,
    state: "waiting-event",
    startedAtMs: now,
    finishedAtMs: null,
    errorJson: null,
    metaJson: JSON.stringify({
      kind: "wait-for-event",
      waitForEvent: {
        signalName,
        correlationId,
        waitAsync: false,
      },
    }),
    responseText: null,
    cached: false,
    jjPointer: null,
    jjCwd: null,
  });
}
