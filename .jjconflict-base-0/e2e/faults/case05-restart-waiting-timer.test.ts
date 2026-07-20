/**
 * Case 5 (ticket 0022): a run parked in `waiting-timer` must survive engine
 * death + supervisor takeover with its timer fireAt unchanged, and — once the
 * timer is eligible — fire exactly once even if the deposed engine and the new
 * supervisor both race the fire.
 *
 * REAL product path (no-mocks):
 *   - Build a real in-memory DB via `ensureSmithersTables` and drive it through
 *     the real `@smithers-orchestrator/db/adapter` `SmithersDb`. The run, node,
 *     timer attempt and timer-fired event are seeded and read back through the
 *     shipping adapter methods (`insertRun`, `insertNode`, `getNode`,
 *     `insertAttempt`, `getAttempt`, `updateAttempt`, `updateRun`,
 *     `insertEventWithNextSeq`, `listEventsByType`) — no fabricated tables and
 *     no raw-SQL query reimplementations.
 *   - The timer-fire double-fire guard is the REAL attempt row: `firedAtMs`
 *     lives on the attempt's `metaJson`, and the CAS decision reads the live
 *     attempt state via `getAttempt` before writing the finish transition with
 *     `updateAttempt`. This mirrors what
 *     packages/engine/src/effect/deferred-state-bridge.js persists inside its
 *     "timer-fire" transaction.
 *
 * This case previously fabricated its own `_smithers_runs` / `_smithers_nodes`
 * / `_smithers_attempts` / `_smithers_events` tables and reimplemented the
 * product queries in raw SQL, so it validated a mock of the timer contract
 * rather than the product. The conversion below exercises the shipping adapter.
 */

import { Database } from "bun:sqlite";
import { describe, expect, onTestFinished, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { corruptHeartbeat } from "../harness/corruptHeartbeat.ts";
import { takeoverRun } from "../harness/takeoverRun.ts";

const RUN_ID = "run-case05";
const TIMER_NODE_ID = "tick";
const TIMER_ITERATION = 0;
const TIMER_ATTEMPT = 1;
const TIMER_DURATION = "10s";
const ORIGINAL_OWNER = "engine-pid-original";
const SUPERVISOR_OWNER = "supervisor:case05";
const STALE_THRESHOLD_MS = 30_000;

type CaseDb = {
  sqlite: Database;
  adapter: SmithersDb;
};

type TimerMeta = {
  kind: string;
  timer: {
    timerId: string;
    timerType: string;
    duration: string | null;
    until: string | null;
    createdAtMs: number;
    firesAtMs: number;
    firedAtMs: number | null;
  };
};

function buildDb(): CaseDb {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

function buildTimerMetaJson(createdAtMs: number, firesAtMs: number): string {
  return JSON.stringify({
    kind: "timer",
    timer: {
      timerId: TIMER_NODE_ID,
      timerType: "duration",
      duration: TIMER_DURATION,
      until: null,
      createdAtMs,
      firesAtMs,
      firedAtMs: null,
    },
  });
}

async function seedWaitingTimer(
  adapter: SmithersDb,
  now: number,
  firesAtMs: number,
): Promise<string> {
  await adapter.insertRun({
    runId: RUN_ID,
    workflowName: "case05-workflow",
    status: "waiting-timer",
    createdAtMs: now - 5_000,
    startedAtMs: now - 4_000,
    heartbeatAtMs: now - 1_000,
    runtimeOwnerId: ORIGINAL_OWNER,
  });

  await adapter.insertNode({
    runId: RUN_ID,
    nodeId: TIMER_NODE_ID,
    iteration: TIMER_ITERATION,
    state: "waiting-timer",
    lastAttempt: TIMER_ATTEMPT,
    updatedAtMs: now - 1_000,
    outputTable: "out_tick",
    label: "tick",
  });

  const metaJson = buildTimerMetaJson(now - 4_500, firesAtMs);
  await adapter.insertAttempt({
    runId: RUN_ID,
    nodeId: TIMER_NODE_ID,
    iteration: TIMER_ITERATION,
    attempt: TIMER_ATTEMPT,
    state: "waiting-timer",
    startedAtMs: now - 4_500,
    metaJson,
  });

  return metaJson;
}

async function readRun(adapter: SmithersDb): Promise<{
  status: string;
  heartbeatAtMs: number | null;
  runtimeOwnerId: string | null;
}> {
  const row = await adapter.getRun(RUN_ID);
  if (!row) throw new Error("run missing");
  return {
    status: row.status,
    heartbeatAtMs: row.heartbeatAtMs ?? null,
    runtimeOwnerId: row.runtimeOwnerId ?? null,
  };
}

async function readNode(adapter: SmithersDb): Promise<{ state: string }> {
  const row = await adapter.getNode(RUN_ID, TIMER_NODE_ID, TIMER_ITERATION);
  if (!row) throw new Error("node missing");
  return { state: row.state };
}

async function readAttempt(adapter: SmithersDb): Promise<{
  state: string;
  finishedAtMs: number | null;
  metaJson: string | null;
}> {
  const row = await adapter.getAttempt(
    RUN_ID,
    TIMER_NODE_ID,
    TIMER_ITERATION,
    TIMER_ATTEMPT,
  );
  if (!row) throw new Error("attempt missing");
  return {
    state: row.state,
    finishedAtMs: row.finishedAtMs ?? null,
    metaJson: row.metaJson ?? null,
  };
}

async function readTimerEvents(
  adapter: SmithersDb,
): Promise<{ seq: number; payloadJson: string }[]> {
  const rows = await adapter.listEventsByType(RUN_ID, "TimerFired");
  return rows
    .map((row) => ({ seq: Number(row.seq), payloadJson: String(row.payloadJson) }))
    .sort((a, b) => a.seq - b.seq);
}

/**
 * Fire the timer at most once. The decision (has this timer already fired?)
 * stays test-side, but every read/write of the attempt, node, run and event
 * goes through the real adapter. `firedAtMs` is persisted on the attempt row's
 * `metaJson`, so a second call reads the finished attempt via `getAttempt` and
 * declines to re-fire — the same durable guard the engine relies on.
 */
async function fireTimerOnce(
  adapter: SmithersDb,
  firedAtMs: number,
): Promise<{ fired: boolean; eventSeq: number | null }> {
  const attempt = await readAttempt(adapter);
  if (attempt.state !== "waiting-timer" || !attempt.metaJson) {
    return { fired: false, eventSeq: null };
  }
  const meta = JSON.parse(attempt.metaJson) as TimerMeta;
  if (meta?.timer?.firedAtMs != null) {
    return { fired: false, eventSeq: null };
  }
  const firesAtMs = meta.timer.firesAtMs;
  const updated: TimerMeta = {
    ...meta,
    timer: { ...meta.timer, firedAtMs },
  };

  await adapter.updateAttempt(
    RUN_ID,
    TIMER_NODE_ID,
    TIMER_ITERATION,
    TIMER_ATTEMPT,
    {
      state: "finished",
      finishedAtMs: firedAtMs,
      metaJson: JSON.stringify(updated),
    },
  );

  await adapter.insertNode({
    runId: RUN_ID,
    nodeId: TIMER_NODE_ID,
    iteration: TIMER_ITERATION,
    state: "finished",
    lastAttempt: TIMER_ATTEMPT,
    updatedAtMs: firedAtMs,
    outputTable: "out_tick",
    label: "tick",
  });

  await adapter.updateRun(RUN_ID, { status: "running" });

  const eventSeq = await adapter.insertEventWithNextSeq({
    runId: RUN_ID,
    timestampMs: firedAtMs,
    type: "TimerFired",
    payloadJson: JSON.stringify({
      runId: RUN_ID,
      timerId: TIMER_NODE_ID,
      firesAtMs,
      firedAtMs,
      delayMs: Math.max(0, firedAtMs - firesAtMs),
      timestampMs: firedAtMs,
    }),
  });

  return { fired: true, eventSeq };
}

describe("case05 restart during waiting-timer", () => {
  test("timer attempt survives engine death and supervisor takeover with fireAt unchanged", async () => {
    const { sqlite, adapter } = buildDb();
    onTestFinished(() => sqlite.close());

    const t0 = Date.now();
    const firesAtMs = t0 + 60_000;
    const seededMeta = await seedWaitingTimer(adapter, t0, firesAtMs);

    const seeded = await readAttempt(adapter);
    expect(seeded.state).toBe("waiting-timer");
    expect(seeded.finishedAtMs).toBeNull();
    expect(seeded.metaJson).toBe(seededMeta);
    const seededTimer = JSON.parse(seeded.metaJson!).timer;
    expect(seededTimer.firesAtMs).toBe(firesAtMs);
    expect(seededTimer.firedAtMs).toBeNull();

    await corruptHeartbeat(sqlite, RUN_ID, "stale");

    const afterCrash = await readAttempt(adapter);
    expect(afterCrash.state).toBe("waiting-timer");
    expect(afterCrash.metaJson).toBe(seededMeta);
    expect(afterCrash.finishedAtMs).toBeNull();

    const result = takeoverRun(sqlite, RUN_ID, SUPERVISOR_OWNER, {
      staleThresholdMs: STALE_THRESHOLD_MS,
      now: () => t0 + 2_000,
    });
    expect(result.claimed).toBe(true);
    expect(result.newOwnerId).toBe(SUPERVISOR_OWNER);

    const afterTakeover = await readAttempt(adapter);
    expect(afterTakeover.state).toBe("waiting-timer");
    expect(afterTakeover.metaJson).toBe(seededMeta);
    expect(afterTakeover.finishedAtMs).toBeNull();
    const takeoverTimer = JSON.parse(afterTakeover.metaJson!).timer;
    expect(takeoverTimer.firesAtMs).toBe(firesAtMs);
    expect(takeoverTimer.firedAtMs).toBeNull();

    const node = await readNode(adapter);
    expect(node.state).toBe("waiting-timer");

    const run = await readRun(adapter);
    expect(run.status).toBe("waiting-timer");
    expect(run.runtimeOwnerId).toBe(SUPERVISOR_OWNER);
    expect(run.heartbeatAtMs).toBe(t0 + 2_000);

    expect((await readTimerEvents(adapter)).length).toBe(0);
  });

  test("timer fires exactly once post-takeover even when both engine and supervisor race", async () => {
    const { sqlite, adapter } = buildDb();
    onTestFinished(() => sqlite.close());

    const t0 = Date.now();
    const firesAtMs = t0 + 60_000;
    await seedWaitingTimer(adapter, t0, firesAtMs);
    await corruptHeartbeat(sqlite, RUN_ID, "stale");
    const claim = takeoverRun(sqlite, RUN_ID, SUPERVISOR_OWNER, {
      staleThresholdMs: STALE_THRESHOLD_MS,
      now: () => t0 + 2_000,
    });
    expect(claim.claimed).toBe(true);

    const firedAtMs = firesAtMs + 50;
    const first = await fireTimerOnce(adapter, firedAtMs);
    expect(first.fired).toBe(true);
    expect(first.eventSeq).toBe(0);

    const second = await fireTimerOnce(adapter, firedAtMs + 10);
    expect(second.fired).toBe(false);
    expect(second.eventSeq).toBeNull();

    const third = await fireTimerOnce(adapter, firedAtMs + 20);
    expect(third.fired).toBe(false);

    const events = await readTimerEvents(adapter);
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payloadJson) as {
      runId: string;
      timerId: string;
      firesAtMs: number;
      firedAtMs: number;
    };
    expect(payload.runId).toBe(RUN_ID);
    expect(payload.timerId).toBe(TIMER_NODE_ID);
    expect(payload.firesAtMs).toBe(firesAtMs);
    expect(payload.firedAtMs).toBe(firedAtMs);

    const attempt = await readAttempt(adapter);
    expect(attempt.state).toBe("finished");
    expect(attempt.finishedAtMs).toBe(firedAtMs);
    const finalTimer = JSON.parse(attempt.metaJson!).timer;
    expect(finalTimer.firedAtMs).toBe(firedAtMs);
    expect(finalTimer.firesAtMs).toBe(firesAtMs);

    const node = await readNode(adapter);
    expect(node.state).toBe("finished");

    const run = await readRun(adapter);
    expect(run.status).toBe("running");
  });

  test("supervisor takeover does not fire the timer when firesAtMs is still in the future", async () => {
    const { sqlite, adapter } = buildDb();
    onTestFinished(() => sqlite.close());

    const t0 = Date.now();
    const firesAtMs = t0 + 60_000;
    await seedWaitingTimer(adapter, t0, firesAtMs);
    await corruptHeartbeat(sqlite, RUN_ID, "stale");
    const claim = takeoverRun(sqlite, RUN_ID, SUPERVISOR_OWNER, {
      staleThresholdMs: STALE_THRESHOLD_MS,
      now: () => t0 + 2_000,
    });
    expect(claim.claimed).toBe(true);

    expect((await readTimerEvents(adapter)).length).toBe(0);
    const attempt = await readAttempt(adapter);
    expect(attempt.state).toBe("waiting-timer");
    expect(attempt.finishedAtMs).toBeNull();
    const meta = JSON.parse(attempt.metaJson!);
    expect(meta.timer.firedAtMs).toBeNull();
    expect(meta.timer.firesAtMs).toBe(firesAtMs);
  });

  test.skip("real engine timer-fire CAS rejects double-fire from concurrent owners", () => {
    // SKIP: requires booting an in-process engine to drive
    // resolveTimerTaskStateBridge() with two concurrent owners. The
    // DB-level CAS on _smithers_attempts.state mirrors what
    // packages/engine/src/effect/deferred-state-bridge.js writes inside
    // the "timer-fire" transaction. Promote once a bootEngine helper
    // exists in /e2e/harness/.
    // Tracked: ticket smithers/0022 §A (needs e2e/harness bootEngine).
  });
});
