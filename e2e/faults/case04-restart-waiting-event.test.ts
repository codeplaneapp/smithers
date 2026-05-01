import { Database } from "bun:sqlite";
import { describe, expect, onTestFinished, test } from "bun:test";
import { corruptHeartbeat } from "../harness/corruptHeartbeat.ts";

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

type SignalRow = {
  run_id: string;
  seq: number;
  signal_name: string;
  correlation_id: string | null;
  payload_json: string;
  received_at_ms: number;
};

type EventRow = {
  run_id: string;
  seq: number;
  type: string;
  payload_json: string;
};

const RUN_ID = "run-case04";
const TARGET_NODE_ID = "wait-webhook-deploy";
const TARGET_ITERATION = 2;
const TARGET_ATTEMPT = 1;
const SIGNAL_NAME = "deploy.approved";
const CORRELATION_ID = "deploy:abc123";
const ORIGINAL_OWNER = "engine-pid-original";
const SUPERVISOR_OWNER = "engine-pid-supervisor";

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
    CREATE TABLE _smithers_signals (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      signal_name TEXT NOT NULL,
      correlation_id TEXT,
      payload_json TEXT NOT NULL,
      received_at_ms INTEGER NOT NULL,
      received_by TEXT,
      PRIMARY KEY (run_id, seq)
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

function seedWaitingEvent(db: Database, now: number): string {
  db.query(
    `INSERT INTO _smithers_runs
       (run_id, workflow_name, status, created_at_ms, started_at_ms, heartbeat_at_ms, runtime_owner_id)
     VALUES (?, 'case04-workflow', 'waiting-event', ?, ?, ?, ?)`,
  ).run(RUN_ID, now - 5_000, now - 4_000, now - 1_000, ORIGINAL_OWNER);

  db.query(
    `INSERT INTO _smithers_nodes
       (run_id, node_id, iteration, state, updated_at_ms, output_table)
     VALUES (?, ?, ?, 'waiting-event', ?, 'out_node')`,
  ).run(RUN_ID, TARGET_NODE_ID, TARGET_ITERATION, now - 1_000);

  const metaJson = JSON.stringify({
    kind: "wait-for-event",
    waitForEvent: {
      signalName: SIGNAL_NAME,
      correlationId: CORRELATION_ID,
      waitAsync: false,
    },
  });

  db.query(
    `INSERT INTO _smithers_attempts
       (run_id, node_id, iteration, attempt, state, started_at_ms, meta_json)
     VALUES (?, ?, ?, ?, 'waiting-event', ?, ?)`,
  ).run(
    RUN_ID,
    TARGET_NODE_ID,
    TARGET_ITERATION,
    TARGET_ATTEMPT,
    now - 1_500,
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
    .get(RUN_ID, TARGET_NODE_ID, TARGET_ITERATION) as NodeRow;
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
      TARGET_NODE_ID,
      TARGET_ITERATION,
      TARGET_ATTEMPT,
    ) as AttemptRow;
}

function readSignals(db: Database): SignalRow[] {
  return db
    .query(
      `SELECT run_id, seq, signal_name, correlation_id, payload_json, received_at_ms
         FROM _smithers_signals
        WHERE run_id = ?
        ORDER BY seq`,
    )
    .all(RUN_ID) as SignalRow[];
}

function supervisorTakeover(db: Database, now: number): void {
  db.query(
    `UPDATE _smithers_runs
        SET runtime_owner_id = ?,
            heartbeat_at_ms = ?,
            status = 'waiting-event'
      WHERE run_id = ?`,
  ).run(SUPERVISOR_OWNER, now, RUN_ID);

  const seq =
    (
      db
        .query(
          `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM _smithers_events WHERE run_id = ?`,
        )
        .get(RUN_ID) as { max_seq: number }
    ).max_seq + 1;

  db.query(
    `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
     VALUES (?, ?, ?, 'RunStateChanged', ?)`,
  ).run(
    RUN_ID,
    seq,
    now,
    JSON.stringify({
      runId: RUN_ID,
      from: "stale",
      to: "waiting-event",
      actor: SUPERVISOR_OWNER,
      reason: "supervisor-takeover",
    }),
  );
}

function findWaitingAttempt(
  db: Database,
  signalName: string,
  correlationId: string | null,
): AttemptRow | null {
  const rows = db
    .query(
      `SELECT a.run_id, a.node_id, a.iteration, a.attempt, a.state,
              a.started_at_ms, a.finished_at_ms, a.meta_json
         FROM _smithers_attempts a
         JOIN _smithers_nodes n
           ON n.run_id = a.run_id
          AND n.node_id = a.node_id
          AND n.iteration = a.iteration
        WHERE a.run_id = ?
          AND a.state = 'waiting-event'
          AND n.state = 'waiting-event'`,
    )
    .all(RUN_ID) as AttemptRow[];
  for (const row of rows) {
    if (!row.meta_json) continue;
    const parsed = JSON.parse(row.meta_json);
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

function submitSignal(
  db: Database,
  signalName: string,
  correlationId: string | null,
  payload: unknown,
  now: number,
): { seq: number; correlated: boolean } {
  return db.transaction(() => {
    const next =
      (
        db
          .query(
            `SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM _smithers_signals WHERE run_id = ?`,
          )
          .get(RUN_ID) as { seq: number }
      ).seq;

    db.query(
      `INSERT INTO _smithers_signals
         (run_id, seq, signal_name, correlation_id, payload_json, received_at_ms, received_by)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      RUN_ID,
      next,
      signalName,
      correlationId,
      JSON.stringify(payload ?? null),
      now,
    );

    const waiter = findWaitingAttempt(db, signalName, correlationId);
    if (!waiter) {
      return { seq: next, correlated: false };
    }

    const meta = JSON.parse(waiter.meta_json!);
    const resolvedMeta = {
      ...meta,
      kind: typeof meta.kind === "string" ? meta.kind : "wait-for-event",
      waitForEvent: {
        ...(meta.waitForEvent ?? {}),
        signalName,
        correlationId,
        resolvedSignalSeq: next,
        receivedAtMs: now,
      },
    };

    db.query(
      `UPDATE _smithers_attempts
          SET state = 'finished',
              finished_at_ms = ?,
              meta_json = ?
        WHERE run_id = ? AND node_id = ? AND iteration = ? AND attempt = ?`,
    ).run(
      now,
      JSON.stringify(resolvedMeta),
      RUN_ID,
      waiter.node_id,
      waiter.iteration,
      waiter.attempt,
    );

    db.query(
      `UPDATE _smithers_nodes
          SET state = 'finished', updated_at_ms = ?
        WHERE run_id = ? AND node_id = ? AND iteration = ?`,
    ).run(now, RUN_ID, waiter.node_id, waiter.iteration);

    db.query(
      `UPDATE _smithers_runs SET status = 'running' WHERE run_id = ?`,
    ).run(RUN_ID);

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
       VALUES (?, ?, ?, 'WaitForEventResolved', ?)`,
    ).run(
      RUN_ID,
      eventSeq,
      now,
      JSON.stringify({
        runId: RUN_ID,
        nodeId: waiter.node_id,
        iteration: waiter.iteration,
        signalName,
        correlationId,
        seq: next,
        receivedAtMs: now,
      }),
    );

    return { seq: next, correlated: true };
  })();
}

describe("case04 restart during waiting-event", () => {
  test("waiter row persists across engine death and supervisor takeover", async () => {
    const db = buildDb();
    onTestFinished(() => db.close());

    const t0 = Date.now();
    const seededMeta = seedWaitingEvent(db, t0);

    const seeded = readAttempt(db);
    expect(seeded.state).toBe("waiting-event");
    expect(seeded.node_id).toBe(TARGET_NODE_ID);
    expect(seeded.iteration).toBe(TARGET_ITERATION);
    expect(seeded.attempt).toBe(TARGET_ATTEMPT);
    expect(seeded.finished_at_ms).toBeNull();
    expect(seeded.meta_json).toBe(seededMeta);

    await corruptHeartbeat(db, RUN_ID, "stale");

    const afterCrash = readAttempt(db);
    expect(afterCrash.state).toBe("waiting-event");
    expect(afterCrash.meta_json).toBe(seededMeta);
    expect(afterCrash.finished_at_ms).toBeNull();
    expect(afterCrash.started_at_ms).toBe(seeded.started_at_ms);

    const nodeAfterCrash = readNode(db);
    expect(nodeAfterCrash.state).toBe("waiting-event");
    expect(nodeAfterCrash.node_id).toBe(TARGET_NODE_ID);
    expect(nodeAfterCrash.iteration).toBe(TARGET_ITERATION);

    supervisorTakeover(db, t0 + 2_000);

    const afterTakeover = readAttempt(db);
    expect(afterTakeover.state).toBe("waiting-event");
    expect(afterTakeover.meta_json).toBe(seededMeta);
    expect(afterTakeover.finished_at_ms).toBeNull();

    const run = readRun(db);
    expect(run.status).toBe("waiting-event");
    expect(run.runtime_owner_id).toBe(SUPERVISOR_OWNER);
    expect(run.heartbeat_at_ms).not.toBeNull();
    expect(run.heartbeat_at_ms!).toBeGreaterThanOrEqual(t0);

    expect(readSignals(db).length).toBe(0);
  });

  test("signal arriving after restart correlates by signalName + correlationId", async () => {
    const db = buildDb();
    onTestFinished(() => db.close());

    const t0 = Date.now();
    seedWaitingEvent(db, t0);
    await corruptHeartbeat(db, RUN_ID, "stale");
    supervisorTakeover(db, t0 + 2_000);

    const result = submitSignal(
      db,
      SIGNAL_NAME,
      CORRELATION_ID,
      { revision: "deadbeef" },
      t0 + 3_000,
    );
    expect(result.correlated).toBe(true);
    expect(result.seq).toBe(0);

    const signals = readSignals(db);
    expect(signals.length).toBe(1);
    expect(signals[0]!.signal_name).toBe(SIGNAL_NAME);
    expect(signals[0]!.correlation_id).toBe(CORRELATION_ID);
    expect(signals[0]!.received_at_ms).toBe(t0 + 3_000);
    expect(JSON.parse(signals[0]!.payload_json)).toEqual({
      revision: "deadbeef",
    });

    const resolved = readAttempt(db);
    expect(resolved.state).toBe("finished");
    expect(resolved.finished_at_ms).toBe(t0 + 3_000);
    const meta = JSON.parse(resolved.meta_json!) as {
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

    const node = readNode(db);
    expect(node.state).toBe("finished");
    expect(node.node_id).toBe(TARGET_NODE_ID);
    expect(node.iteration).toBe(TARGET_ITERATION);

    const run = readRun(db);
    expect(run.status).toBe("running");

    const events = db
      .query(
        `SELECT run_id, seq, type, payload_json
           FROM _smithers_events
          WHERE run_id = ? AND type = 'WaitForEventResolved'`,
      )
      .all(RUN_ID) as EventRow[];
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload_json) as {
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
    const db = buildDb();
    onTestFinished(() => db.close());

    const t0 = Date.now();
    seedWaitingEvent(db, t0);
    await corruptHeartbeat(db, RUN_ID, "stale");
    supervisorTakeover(db, t0 + 2_000);

    const result = submitSignal(
      db,
      SIGNAL_NAME,
      "deploy:other-id",
      { revision: "cafebabe" },
      t0 + 2_500,
    );
    expect(result.correlated).toBe(false);
    expect(result.seq).toBe(0);

    const signals = readSignals(db);
    expect(signals.length).toBe(1);
    expect(signals[0]!.correlation_id).toBe("deploy:other-id");

    const stillWaiting = readAttempt(db);
    expect(stillWaiting.state).toBe("waiting-event");
    expect(stillWaiting.finished_at_ms).toBeNull();

    const node = readNode(db);
    expect(node.state).toBe("waiting-event");

    const run = readRun(db);
    expect(run.status).toBe("waiting-event");
  });

  test.skip("real engine resume re-enters the workflow at the waiter node", () => {
    // SKIP: requires booting an in-process gateway + engine to drive
    // signalRun() and bridgeSignalResolve() end-to-end. The DB-level
    // contract above mirrors what packages/server/src/gateway.js +
    // packages/engine/src/signals.js write through. Promote once a
    // bootGateway() helper exists in /e2e/harness/.
  });
});
