import { Database } from "bun:sqlite";
import { describe, expect, onTestFinished, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { corruptHeartbeat } from "../harness/corruptHeartbeat.ts";

type RunRow = {
  runId: string;
  status: string;
  heartbeatAtMs: number | null;
  runtimeOwnerId: string | null;
};

type NodeRow = {
  runId: string;
  nodeId: string;
  iteration: number;
  state: string;
};

type AttemptRow = {
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  state: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  metaJson: string | null;
};

type SignalRow = {
  runId: string;
  seq: number;
  signalName: string;
  correlationId: string | null;
  payloadJson: string;
  receivedAtMs: number;
};

type EventRow = {
  runId: string;
  seq: number;
  type: string;
  payloadJson: string;
};

type CaseDb = {
  sqlite: Database;
  adapter: SmithersDb;
};

const RUN_ID = "run-case04";
const TARGET_NODE_ID = "wait-webhook-deploy";
const TARGET_ITERATION = 2;
const TARGET_ATTEMPT = 1;
const OUTPUT_TABLE = "out_node";
const SIGNAL_NAME = "deploy.approved";
const CORRELATION_ID = "deploy:abc123";
const ORIGINAL_OWNER = "engine-pid-original";
const SUPERVISOR_OWNER = "engine-pid-supervisor";

function buildDb(): CaseDb {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

async function seedWaitingEvent(
  adapter: SmithersDb,
  now: number,
): Promise<string> {
  await adapter.insertRun({
    runId: RUN_ID,
    workflowName: "case04-workflow",
    status: "waiting-event",
    createdAtMs: now - 5_000,
    startedAtMs: now - 4_000,
    heartbeatAtMs: now - 1_000,
    runtimeOwnerId: ORIGINAL_OWNER,
  });

  await adapter.insertNode({
    runId: RUN_ID,
    nodeId: TARGET_NODE_ID,
    iteration: TARGET_ITERATION,
    state: "waiting-event",
    lastAttempt: TARGET_ATTEMPT,
    updatedAtMs: now - 1_000,
    outputTable: OUTPUT_TABLE,
    label: null,
  });

  const metaJson = JSON.stringify({
    kind: "wait-for-event",
    waitForEvent: {
      signalName: SIGNAL_NAME,
      correlationId: CORRELATION_ID,
      waitAsync: false,
    },
  });

  await adapter.insertAttempt({
    runId: RUN_ID,
    nodeId: TARGET_NODE_ID,
    iteration: TARGET_ITERATION,
    attempt: TARGET_ATTEMPT,
    state: "waiting-event",
    startedAtMs: now - 1_500,
    finishedAtMs: null,
    metaJson,
  });

  return metaJson;
}

async function readRun(adapter: SmithersDb): Promise<RunRow> {
  return (await adapter.getRun(RUN_ID)) as RunRow;
}

async function readNode(adapter: SmithersDb): Promise<NodeRow> {
  return (await adapter.getNode(
    RUN_ID,
    TARGET_NODE_ID,
    TARGET_ITERATION,
  )) as NodeRow;
}

async function readAttempt(adapter: SmithersDb): Promise<AttemptRow> {
  return (await adapter.getAttempt(
    RUN_ID,
    TARGET_NODE_ID,
    TARGET_ITERATION,
    TARGET_ATTEMPT,
  )) as AttemptRow;
}

async function readSignals(adapter: SmithersDb): Promise<SignalRow[]> {
  return (await adapter.listSignals(RUN_ID)) as SignalRow[];
}

async function supervisorTakeover(
  adapter: SmithersDb,
  now: number,
): Promise<void> {
  await adapter.updateRun(RUN_ID, {
    runtimeOwnerId: SUPERVISOR_OWNER,
    heartbeatAtMs: now,
    status: "waiting-event",
  });

  await adapter.insertEventWithNextSeq({
    runId: RUN_ID,
    timestampMs: now,
    type: "RunStateChanged",
    payloadJson: JSON.stringify({
      runId: RUN_ID,
      from: "stale",
      to: "waiting-event",
      actor: SUPERVISOR_OWNER,
      reason: "supervisor-takeover",
    }),
  });
}

// Signal correlation (matching signalName + correlationId against a waiting
// attempt, then consuming the waiter) is engine/interpretation logic — the
// real engine drives it via packages/engine/src/signals.js. We keep that
// decision here (test-side), but every storage read/write goes through the
// real SmithersDb adapter, not fabricated tables or raw-SQL reimplementations.
async function findWaitingAttempt(
  adapter: SmithersDb,
  signalName: string,
  correlationId: string | null,
): Promise<AttemptRow | null> {
  const nodes = (await adapter.listNodes(RUN_ID)) as NodeRow[];
  const waitingNodes = new Set(
    nodes
      .filter((n) => n.state === "waiting-event")
      .map((n) => `${n.nodeId}#${n.iteration}`),
  );
  const attempts = (await adapter.listAttemptsForRun(RUN_ID)) as AttemptRow[];
  for (const row of attempts) {
    if (row.state !== "waiting-event") continue;
    if (!waitingNodes.has(`${row.nodeId}#${row.iteration}`)) continue;
    if (!row.metaJson) continue;
    const parsed = JSON.parse(row.metaJson);
    const wfe = parsed?.waitForEvent;
    if (!wfe || typeof wfe !== "object") continue;
    if (wfe.signalName !== signalName) continue;
    const rowCorrelation =
      typeof wfe.correlationId === "string" ? wfe.correlationId : null;
    if (rowCorrelation !== correlationId) continue;
    return row;
  }
  return null;
}

async function submitSignal(
  adapter: SmithersDb,
  signalName: string,
  correlationId: string | null,
  payload: unknown,
  now: number,
): Promise<{ seq: number; correlated: boolean }> {
  const seq = (await adapter.insertSignalWithNextSeq({
    runId: RUN_ID,
    signalName,
    correlationId,
    payloadJson: JSON.stringify(payload ?? null),
    receivedAtMs: now,
    receivedBy: null,
  })) as number;

  const waiter = await findWaitingAttempt(adapter, signalName, correlationId);
  if (!waiter) {
    return { seq, correlated: false };
  }

  const meta = JSON.parse(waiter.metaJson!);
  const resolvedMeta = {
    ...meta,
    kind: typeof meta.kind === "string" ? meta.kind : "wait-for-event",
    waitForEvent: {
      ...(meta.waitForEvent ?? {}),
      signalName,
      correlationId,
      resolvedSignalSeq: seq,
      receivedAtMs: now,
    },
  };

  await adapter.updateAttempt(
    RUN_ID,
    waiter.nodeId,
    waiter.iteration,
    waiter.attempt,
    {
      state: "finished",
      finishedAtMs: now,
      metaJson: JSON.stringify(resolvedMeta),
    },
  );

  await adapter.insertNode({
    runId: RUN_ID,
    nodeId: waiter.nodeId,
    iteration: waiter.iteration,
    state: "finished",
    lastAttempt: waiter.attempt,
    updatedAtMs: now,
    outputTable: OUTPUT_TABLE,
    label: null,
  });

  await adapter.updateRun(RUN_ID, { status: "running" });

  await adapter.insertEventWithNextSeq({
    runId: RUN_ID,
    timestampMs: now,
    type: "WaitForEventResolved",
    payloadJson: JSON.stringify({
      runId: RUN_ID,
      nodeId: waiter.nodeId,
      iteration: waiter.iteration,
      signalName,
      correlationId,
      seq,
      receivedAtMs: now,
    }),
  });

  return { seq, correlated: true };
}

describe("case04 restart during waiting-event", () => {
  test("waiter row persists across engine death and supervisor takeover", async () => {
    const { sqlite, adapter } = buildDb();
    onTestFinished(() => sqlite.close());

    const t0 = Date.now();
    const seededMeta = await seedWaitingEvent(adapter, t0);

    const seeded = await readAttempt(adapter);
    expect(seeded.state).toBe("waiting-event");
    expect(seeded.nodeId).toBe(TARGET_NODE_ID);
    expect(seeded.iteration).toBe(TARGET_ITERATION);
    expect(seeded.attempt).toBe(TARGET_ATTEMPT);
    expect(seeded.finishedAtMs).toBeNull();
    expect(seeded.metaJson).toBe(seededMeta);

    await corruptHeartbeat(sqlite, RUN_ID, "stale");

    const afterCrash = await readAttempt(adapter);
    expect(afterCrash.state).toBe("waiting-event");
    expect(afterCrash.metaJson).toBe(seededMeta);
    expect(afterCrash.finishedAtMs).toBeNull();
    expect(afterCrash.startedAtMs).toBe(seeded.startedAtMs);

    const nodeAfterCrash = await readNode(adapter);
    expect(nodeAfterCrash.state).toBe("waiting-event");
    expect(nodeAfterCrash.nodeId).toBe(TARGET_NODE_ID);
    expect(nodeAfterCrash.iteration).toBe(TARGET_ITERATION);

    await supervisorTakeover(adapter, t0 + 2_000);

    const afterTakeover = await readAttempt(adapter);
    expect(afterTakeover.state).toBe("waiting-event");
    expect(afterTakeover.metaJson).toBe(seededMeta);
    expect(afterTakeover.finishedAtMs).toBeNull();

    const run = await readRun(adapter);
    expect(run.status).toBe("waiting-event");
    expect(run.runtimeOwnerId).toBe(SUPERVISOR_OWNER);
    expect(run.heartbeatAtMs).not.toBeNull();
    expect(run.heartbeatAtMs!).toBeGreaterThanOrEqual(t0);

    expect((await readSignals(adapter)).length).toBe(0);
  });

  test("signal arriving after restart correlates by signalName + correlationId", async () => {
    const { sqlite, adapter } = buildDb();
    onTestFinished(() => sqlite.close());

    const t0 = Date.now();
    await seedWaitingEvent(adapter, t0);
    await corruptHeartbeat(sqlite, RUN_ID, "stale");
    await supervisorTakeover(adapter, t0 + 2_000);

    const result = await submitSignal(
      adapter,
      SIGNAL_NAME,
      CORRELATION_ID,
      { revision: "deadbeef" },
      t0 + 3_000,
    );
    expect(result.correlated).toBe(true);
    expect(result.seq).toBe(0);

    const signals = await readSignals(adapter);
    expect(signals.length).toBe(1);
    expect(signals[0]!.signalName).toBe(SIGNAL_NAME);
    expect(signals[0]!.correlationId).toBe(CORRELATION_ID);
    expect(signals[0]!.receivedAtMs).toBe(t0 + 3_000);
    expect(JSON.parse(signals[0]!.payloadJson)).toEqual({
      revision: "deadbeef",
    });

    const resolved = await readAttempt(adapter);
    expect(resolved.state).toBe("finished");
    expect(resolved.finishedAtMs).toBe(t0 + 3_000);
    const meta = JSON.parse(resolved.metaJson!) as {
      waitForEvent: {
        signalName: string;
        correlationId: string | null;
        resolvedSignalSeq: number;
        receivedAtMs: number;
      };
    };
    expect(meta.waitForEvent.signalName).toBe(SIGNAL_NAME);
    expect(meta.waitForEvent.correlationId).toBe(CORRELATION_ID);
    expect(meta.waitForEvent.resolvedSignalSeq).toBe(0);
    expect(meta.waitForEvent.receivedAtMs).toBe(t0 + 3_000);

    const node = await readNode(adapter);
    expect(node.state).toBe("finished");
    expect(node.nodeId).toBe(TARGET_NODE_ID);
    expect(node.iteration).toBe(TARGET_ITERATION);

    const run = await readRun(adapter);
    expect(run.status).toBe("running");

    const events = (await adapter.listEventsByType(
      RUN_ID,
      "WaitForEventResolved",
    )) as EventRow[];
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payloadJson) as {
      runId: string;
      nodeId: string;
      iteration: number;
      signalName: string;
      correlationId: string | null;
      seq: number;
    };
    expect(payload.runId).toBe(RUN_ID);
    expect(payload.nodeId).toBe(TARGET_NODE_ID);
    expect(payload.iteration).toBe(TARGET_ITERATION);
    expect(payload.signalName).toBe(SIGNAL_NAME);
    expect(payload.correlationId).toBe(CORRELATION_ID);
    expect(payload.seq).toBe(0);
  });

  test("signal with mismatched correlationId is recorded but does not consume the waiter", async () => {
    const { sqlite, adapter } = buildDb();
    onTestFinished(() => sqlite.close());

    const t0 = Date.now();
    await seedWaitingEvent(adapter, t0);
    await corruptHeartbeat(sqlite, RUN_ID, "stale");
    await supervisorTakeover(adapter, t0 + 2_000);

    const result = await submitSignal(
      adapter,
      SIGNAL_NAME,
      "deploy:other-id",
      { revision: "cafebabe" },
      t0 + 2_500,
    );
    expect(result.correlated).toBe(false);
    expect(result.seq).toBe(0);

    const signals = await readSignals(adapter);
    expect(signals.length).toBe(1);
    expect(signals[0]!.correlationId).toBe("deploy:other-id");

    const stillWaiting = await readAttempt(adapter);
    expect(stillWaiting.state).toBe("waiting-event");
    expect(stillWaiting.finishedAtMs).toBeNull();

    const node = await readNode(adapter);
    expect(node.state).toBe("waiting-event");

    const run = await readRun(adapter);
    expect(run.status).toBe("waiting-event");
  });

  test.skip("real engine resume re-enters the workflow at the waiter node", () => {
    // SKIP: requires booting an in-process gateway + engine to drive
    // signalRun() and bridgeSignalResolve() end-to-end. The DB-level
    // contract above mirrors what packages/server/src/gateway.js +
    // packages/engine/src/signals.js write through. Promote once a
    // bootGateway() helper exists in /e2e/harness/.
    // Tracked: ticket smithers/0022 §A (needs e2e/harness bootGateway+bootEngine).
  });
});
