import { Database } from "bun:sqlite";
import { describe, expect, onTestFinished, test } from "bun:test";
import { corruptHeartbeat } from "../harness/corruptHeartbeat.ts";
import { takeoverRun } from "../harness/takeoverRun.ts";

type RunRow = {
  run_id: string;
  status: string;
  heartbeat_at_ms: number | null;
  runtime_owner_id: string | null;
};

type NodeRow = {
  run_id: string;
  node_id: string;
  iteration: number;
  state: string;
};

type AttemptRow = {
  run_id: string;
  node_id: string;
  iteration: number;
  attempt: number;
  state: string;
  started_at_ms: number;
  finished_at_ms: number | null;
  meta_json: string | null;
};

type EventRow = {
  run_id: string;
  seq: number;
  type: string;
  payload_json: string;
};

const RUN_ID = "run-case05";
const TIMER_NODE_ID = "tick";
const TIMER_ITERATION = 0;
const TIMER_ATTEMPT = 1;
const TIMER_DURATION = "10s";
const ORIGINAL_OWNER = "engine-pid-original";
const SUPERVISOR_OWNER = "supervisor:case05";
const STALE_THRESHOLD_MS = 30_000;

function buildDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE _smithers_runs (
      run_id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      started_at_ms INTEGER,
      heartbeat_at_ms INTEGER,
      runtime_owner_id TEXT
    );
    CREATE TABLE _smithers_nodes (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      output_table TEXT NOT NULL,
      PRIMARY KEY (run_id, node_id, iteration)
    );
    CREATE TABLE _smithers_attempts (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL,
      state TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER,
      heartbeat_at_ms INTEGER,
      heartbeat_data_json TEXT,
      error_json TEXT,
      jj_pointer TEXT,
      response_text TEXT,
      jj_cwd TEXT,
      cached INTEGER DEFAULT 0,
      meta_json TEXT,
      PRIMARY KEY (run_id, node_id, iteration, attempt)
    );
    CREATE TABLE _smithers_events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
  `);
  return db;
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

function seedWaitingTimer(
  db: Database,
  now: number,
  firesAtMs: number,
): string {
  db.query(
    `INSERT INTO _smithers_runs
       (run_id, workflow_name, status, created_at_ms, started_at_ms, heartbeat_at_ms, runtime_owner_id)
     VALUES (?, 'case05-workflow', 'waiting-timer', ?, ?, ?, ?)`,
  ).run(RUN_ID, now - 5_000, now - 4_000, now - 1_000, ORIGINAL_OWNER);

  db.query(
    `INSERT INTO _smithers_nodes
       (run_id, node_id, iteration, state, updated_at_ms, output_table)
     VALUES (?, ?, ?, 'waiting-timer', ?, 'out_tick')`,
  ).run(RUN_ID, TIMER_NODE_ID, TIMER_ITERATION, now - 1_000);

  const metaJson = buildTimerMetaJson(now - 4_500, firesAtMs);
  db.query(
    `INSERT INTO _smithers_attempts
       (run_id, node_id, iteration, attempt, state, started_at_ms, meta_json)
     VALUES (?, ?, ?, ?, 'waiting-timer', ?, ?)`,
  ).run(
    RUN_ID,
    TIMER_NODE_ID,
    TIMER_ITERATION,
    TIMER_ATTEMPT,
    now - 4_500,
    metaJson,
  );

  return metaJson;
}

function readRun(db: Database): RunRow {
  return db
    .query(
      `SELECT run_id, status, heartbeat_at_ms, runtime_owner_id
         FROM _smithers_runs WHERE run_id = ?`,
    )
    .get(RUN_ID) as RunRow;
}

function readNode(db: Database): NodeRow {
  return db
    .query(
      `SELECT run_id, node_id, iteration, state
         FROM _smithers_nodes
        WHERE run_id = ? AND node_id = ? AND iteration = ?`,
    )
    .get(RUN_ID, TIMER_NODE_ID, TIMER_ITERATION) as NodeRow;
}

function readAttempt(db: Database): AttemptRow {
  return db
    .query(
      `SELECT run_id, node_id, iteration, attempt, state,
              started_at_ms, finished_at_ms, meta_json
         FROM _smithers_attempts
        WHERE run_id = ? AND node_id = ? AND iteration = ? AND attempt = ?`,
    )
    .get(
      RUN_ID,
      TIMER_NODE_ID,
      TIMER_ITERATION,
      TIMER_ATTEMPT,
    ) as AttemptRow;
}

function readTimerEvents(db: Database): EventRow[] {
  return db
    .query(
      `SELECT run_id, seq, type, payload_json
         FROM _smithers_events
        WHERE run_id = ? AND type = 'TimerFired'
        ORDER BY seq`,
    )
    .all(RUN_ID) as EventRow[];
}

function fireTimerOnce(
  db: Database,
  firedAtMs: number,
): { fired: boolean; eventSeq: number | null } {
  return db.transaction(() => {
    const row = db
      .query(
        `SELECT state, meta_json FROM _smithers_attempts
          WHERE run_id = ? AND node_id = ? AND iteration = ? AND attempt = ?`,
      )
      .get(
        RUN_ID,
        TIMER_NODE_ID,
        TIMER_ITERATION,
        TIMER_ATTEMPT,
      ) as { state: string; meta_json: string | null } | null;
    if (!row || row.state !== "waiting-timer" || !row.meta_json) {
      return { fired: false, eventSeq: null };
    }
    const meta = JSON.parse(row.meta_json) as {
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
    if (meta?.timer?.firedAtMs != null) {
      return { fired: false, eventSeq: null };
    }
    const firesAtMs = meta.timer.firesAtMs;
    const updated = {
      ...meta,
      timer: { ...meta.timer, firedAtMs },
    };

    db.query(
      `UPDATE _smithers_attempts
          SET state = 'finished',
              finished_at_ms = ?,
              meta_json = ?
        WHERE run_id = ? AND node_id = ? AND iteration = ? AND attempt = ?
          AND state = 'waiting-timer'`,
    ).run(
      firedAtMs,
      JSON.stringify(updated),
      RUN_ID,
      TIMER_NODE_ID,
      TIMER_ITERATION,
      TIMER_ATTEMPT,
    );

    const { count } = db.query("SELECT changes() AS count").get() as {
      count: number;
    };
    if (Number(count) === 0) {
      return { fired: false, eventSeq: null };
    }

    db.query(
      `UPDATE _smithers_nodes
          SET state = 'finished', updated_at_ms = ?
        WHERE run_id = ? AND node_id = ? AND iteration = ?`,
    ).run(firedAtMs, RUN_ID, TIMER_NODE_ID, TIMER_ITERATION);

    db.query(`UPDATE _smithers_runs SET status = 'running' WHERE run_id = ?`).run(
      RUN_ID,
    );

    const eventSeq =
      (
        db
          .query(
            `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM _smithers_events WHERE run_id = ?`,
          )
          .get(RUN_ID) as { max_seq: number }
      ).max_seq + 1;

    db.query(
      `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
       VALUES (?, ?, ?, 'TimerFired', ?)`,
    ).run(
      RUN_ID,
      eventSeq,
      firedAtMs,
      JSON.stringify({
        runId: RUN_ID,
        timerId: TIMER_NODE_ID,
        firesAtMs,
        firedAtMs,
        delayMs: Math.max(0, firedAtMs - firesAtMs),
        timestampMs: firedAtMs,
      }),
    );

    return { fired: true, eventSeq };
  })();
}

describe("case05 restart during waiting-timer", () => {
  test("timer attempt survives engine death and supervisor takeover with fireAt unchanged", async () => {
    const db = buildDb();
    onTestFinished(() => db.close());

    const t0 = Date.now();
    const firesAtMs = t0 + 60_000;
    const seededMeta = seedWaitingTimer(db, t0, firesAtMs);

    const seeded = readAttempt(db);
    expect(seeded.state).toBe("waiting-timer");
    expect(seeded.finished_at_ms).toBeNull();
    expect(seeded.meta_json).toBe(seededMeta);
    const seededTimer = JSON.parse(seeded.meta_json!).timer;
    expect(seededTimer.firesAtMs).toBe(firesAtMs);
    expect(seededTimer.firedAtMs).toBeNull();

    await corruptHeartbeat(db, RUN_ID, "stale");

    const afterCrash = readAttempt(db);
    expect(afterCrash.state).toBe("waiting-timer");
    expect(afterCrash.meta_json).toBe(seededMeta);
    expect(afterCrash.finished_at_ms).toBeNull();

    const result = takeoverRun(db, RUN_ID, SUPERVISOR_OWNER, {
      staleThresholdMs: STALE_THRESHOLD_MS,
      now: () => t0 + 2_000,
    });
    expect(result.claimed).toBe(true);
    expect(result.newOwnerId).toBe(SUPERVISOR_OWNER);

    const afterTakeover = readAttempt(db);
    expect(afterTakeover.state).toBe("waiting-timer");
    expect(afterTakeover.meta_json).toBe(seededMeta);
    expect(afterTakeover.finished_at_ms).toBeNull();
    const takeoverTimer = JSON.parse(afterTakeover.meta_json!).timer;
    expect(takeoverTimer.firesAtMs).toBe(firesAtMs);
    expect(takeoverTimer.firedAtMs).toBeNull();

    const node = readNode(db);
    expect(node.state).toBe("waiting-timer");

    const run = readRun(db);
    expect(run.status).toBe("waiting-timer");
    expect(run.runtime_owner_id).toBe(SUPERVISOR_OWNER);
    expect(run.heartbeat_at_ms).toBe(t0 + 2_000);

    expect(readTimerEvents(db).length).toBe(0);
  });

  test("timer fires exactly once post-takeover even when both engine and supervisor race", async () => {
    const db = buildDb();
    onTestFinished(() => db.close());

    const t0 = Date.now();
    const firesAtMs = t0 + 60_000;
    seedWaitingTimer(db, t0, firesAtMs);
    await corruptHeartbeat(db, RUN_ID, "stale");
    const claim = takeoverRun(db, RUN_ID, SUPERVISOR_OWNER, {
      staleThresholdMs: STALE_THRESHOLD_MS,
      now: () => t0 + 2_000,
    });
    expect(claim.claimed).toBe(true);

    const firedAtMs = firesAtMs + 50;
    const first = fireTimerOnce(db, firedAtMs);
    expect(first.fired).toBe(true);
    expect(first.eventSeq).toBe(1);

    const second = fireTimerOnce(db, firedAtMs + 10);
    expect(second.fired).toBe(false);
    expect(second.eventSeq).toBeNull();

    const third = fireTimerOnce(db, firedAtMs + 20);
    expect(third.fired).toBe(false);

    const events = readTimerEvents(db);
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload_json) as {
      runId: string;
      timerId: string;
      firesAtMs: number;
      firedAtMs: number;
    };
    expect(payload.runId).toBe(RUN_ID);
    expect(payload.timerId).toBe(TIMER_NODE_ID);
    expect(payload.firesAtMs).toBe(firesAtMs);
    expect(payload.firedAtMs).toBe(firedAtMs);

    const attempt = readAttempt(db);
    expect(attempt.state).toBe("finished");
    expect(attempt.finished_at_ms).toBe(firedAtMs);
    const finalTimer = JSON.parse(attempt.meta_json!).timer;
    expect(finalTimer.firedAtMs).toBe(firedAtMs);
    expect(finalTimer.firesAtMs).toBe(firesAtMs);

    const node = readNode(db);
    expect(node.state).toBe("finished");

    const run = readRun(db);
    expect(run.status).toBe("running");
  });

  test("supervisor takeover does not fire the timer when firesAtMs is still in the future", async () => {
    const db = buildDb();
    onTestFinished(() => db.close());

    const t0 = Date.now();
    const firesAtMs = t0 + 60_000;
    seedWaitingTimer(db, t0, firesAtMs);
    await corruptHeartbeat(db, RUN_ID, "stale");
    const claim = takeoverRun(db, RUN_ID, SUPERVISOR_OWNER, {
      staleThresholdMs: STALE_THRESHOLD_MS,
      now: () => t0 + 2_000,
    });
    expect(claim.claimed).toBe(true);

    expect(readTimerEvents(db).length).toBe(0);
    const attempt = readAttempt(db);
    expect(attempt.state).toBe("waiting-timer");
    expect(attempt.finished_at_ms).toBeNull();
    const meta = JSON.parse(attempt.meta_json!);
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
  });
});
