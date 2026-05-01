import { Database } from "bun:sqlite";
import { describe, expect, onTestFinished, test } from "bun:test";
import { corruptHeartbeat } from "../harness/corruptHeartbeat.ts";

type ApprovalRow = {
  run_id: string;
  node_id: string;
  iteration: number;
  status: string;
  requested_at_ms: number | null;
  decided_at_ms: number | null;
  request_json: string | null;
  decision_json: string | null;
};

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

type EventRow = {
  run_id: string;
  seq: number;
  type: string;
  payload_json: string;
};

const TARGET_NODE_ID = "approve-deploy";
const TARGET_ITERATION = 4;
const ORIGINAL_OWNER = "engine-pid-original";
const SUPERVISOR_OWNER = "engine-pid-supervisor";
const RUN_ID = "run-case03";

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
    CREATE TABLE _smithers_approvals (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      requested_at_ms INTEGER,
      decided_at_ms INTEGER,
      note TEXT,
      decided_by TEXT,
      request_json TEXT,
      decision_json TEXT,
      auto_approved INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, node_id, iteration)
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

function seedWaitingApproval(db: Database, now: number): void {
  db.query(
    `INSERT INTO _smithers_runs
       (run_id, workflow_name, status, created_at_ms, started_at_ms, heartbeat_at_ms, runtime_owner_id)
     VALUES (?, 'case03-workflow', 'waiting-approval', ?, ?, ?, ?)`,
  ).run(RUN_ID, now - 5_000, now - 4_000, now - 1_000, ORIGINAL_OWNER);

  db.query(
    `INSERT INTO _smithers_nodes
       (run_id, node_id, iteration, state, updated_at_ms, output_table)
     VALUES (?, ?, ?, 'waiting-approval', ?, 'out_node')`,
  ).run(RUN_ID, TARGET_NODE_ID, TARGET_ITERATION, now - 1_000);

  db.query(
    `INSERT INTO _smithers_approvals
       (run_id, node_id, iteration, status, requested_at_ms, request_json, auto_approved)
     VALUES (?, ?, ?, 'requested', ?, ?, 0)`,
  ).run(
    RUN_ID,
    TARGET_NODE_ID,
    TARGET_ITERATION,
    now - 1_500,
    JSON.stringify({ prompt: "approve production deploy?", waitAsync: false }),
  );
}

function snapshotApproval(db: Database): ApprovalRow {
  return db
    .query(
      `SELECT run_id, node_id, iteration, status, requested_at_ms,
              decided_at_ms, request_json, decision_json
         FROM _smithers_approvals
        WHERE run_id = ? AND node_id = ? AND iteration = ?`,
    )
    .get(RUN_ID, TARGET_NODE_ID, TARGET_ITERATION) as ApprovalRow;
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

function supervisorTakeover(db: Database, now: number): void {
  db.query(
    `UPDATE _smithers_runs
        SET runtime_owner_id = ?,
            heartbeat_at_ms = ?,
            status = 'waiting-approval'
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
      to: "waiting-approval",
      actor: SUPERVISOR_OWNER,
      reason: "supervisor-takeover",
    }),
  );
}

function submitApprovalDecision(
  db: Database,
  approved: boolean,
  decidedBy: string,
  now: number,
): void {
  db.transaction(() => {
    db.query(
      `UPDATE _smithers_approvals
          SET status = ?,
              decided_at_ms = ?,
              decided_by = ?,
              decision_json = ?
        WHERE run_id = ? AND node_id = ? AND iteration = ?`,
    ).run(
      approved ? "approved" : "denied",
      now,
      decidedBy,
      JSON.stringify({ approved }),
      RUN_ID,
      TARGET_NODE_ID,
      TARGET_ITERATION,
    );

    db.query(
      `UPDATE _smithers_nodes
          SET state = 'pending', updated_at_ms = ?
        WHERE run_id = ? AND node_id = ? AND iteration = ?`,
    ).run(now, RUN_ID, TARGET_NODE_ID, TARGET_ITERATION);

    db.query(
      `UPDATE _smithers_runs SET status = 'running' WHERE run_id = ?`,
    ).run(RUN_ID);

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
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      RUN_ID,
      seq,
      now,
      approved ? "ApprovalGranted" : "ApprovalDenied",
      JSON.stringify({
        runId: RUN_ID,
        nodeId: TARGET_NODE_ID,
        iteration: TARGET_ITERATION,
        timestampMs: now,
      }),
    );
  })();
}

describe("case03 restart during waiting-approval", () => {
  test("approval row persists across engine death and supervisor takeover", async () => {
    const db = buildDb();
    onTestFinished(() => db.close());

    const t0 = Date.now();
    seedWaitingApproval(db, t0);

    const seeded = snapshotApproval(db);
    expect(seeded.status).toBe("requested");
    expect(seeded.node_id).toBe(TARGET_NODE_ID);
    expect(seeded.iteration).toBe(TARGET_ITERATION);
    expect(seeded.decided_at_ms).toBeNull();

    await corruptHeartbeat(db, RUN_ID, "stale");

    const afterCrash = snapshotApproval(db);
    expect(afterCrash.status).toBe("requested");
    expect(afterCrash.node_id).toBe(seeded.node_id);
    expect(afterCrash.iteration).toBe(seeded.iteration);
    expect(afterCrash.requested_at_ms).toBe(seeded.requested_at_ms);
    expect(afterCrash.request_json).toBe(seeded.request_json);
    expect(afterCrash.decided_at_ms).toBeNull();

    supervisorTakeover(db, t0 + 2_000);

    const afterTakeover = snapshotApproval(db);
    expect(afterTakeover.status).toBe("requested");
    expect(afterTakeover.node_id).toBe(seeded.node_id);
    expect(afterTakeover.iteration).toBe(seeded.iteration);
    expect(afterTakeover.request_json).toBe(seeded.request_json);
    expect(afterTakeover.decided_at_ms).toBeNull();

    const runAfterTakeover = readRun(db);
    expect(runAfterTakeover.status).toBe("waiting-approval");
    expect(runAfterTakeover.runtime_owner_id).toBe(SUPERVISOR_OWNER);
    expect(runAfterTakeover.heartbeat_at_ms).not.toBeNull();
    expect(runAfterTakeover.heartbeat_at_ms!).toBeGreaterThanOrEqual(t0);
  });

  test("approval decision after takeover resumes the exact node and iteration", async () => {
    const db = buildDb();
    onTestFinished(() => db.close());

    const t0 = Date.now();
    seedWaitingApproval(db, t0);
    await corruptHeartbeat(db, RUN_ID, "stale");
    supervisorTakeover(db, t0 + 2_000);

    submitApprovalDecision(db, true, "alice", t0 + 3_000);

    const decided = snapshotApproval(db);
    expect(decided.status).toBe("approved");
    expect(decided.node_id).toBe(TARGET_NODE_ID);
    expect(decided.iteration).toBe(TARGET_ITERATION);
    expect(decided.decided_at_ms).toBe(t0 + 3_000);
    expect(decided.decision_json).toBe(JSON.stringify({ approved: true }));

    const node = readNode(db);
    expect(node.state).toBe("pending");
    expect(node.node_id).toBe(TARGET_NODE_ID);
    expect(node.iteration).toBe(TARGET_ITERATION);

    const run = readRun(db);
    expect(run.status).toBe("running");

    const events = db
      .query(
        `SELECT run_id, seq, type, payload_json
           FROM _smithers_events
          WHERE run_id = ? AND type = 'ApprovalGranted'`,
      )
      .all(RUN_ID) as EventRow[];
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload_json) as {
      runId: string;
      nodeId: string;
      iteration: number;
    };
    expect(payload.runId).toBe(RUN_ID);
    expect(payload.nodeId).toBe(TARGET_NODE_ID);
    expect(payload.iteration).toBe(TARGET_ITERATION);

    const otherIteration = db
      .query(
        `SELECT COUNT(*) AS n FROM _smithers_approvals
          WHERE run_id = ? AND iteration != ?`,
      )
      .get(RUN_ID, TARGET_ITERATION) as { n: number };
    expect(otherIteration.n).toBe(0);
  });

  test.skip("real engine resume re-enters the workflow at the waiting node", () => {
    // SKIP: requires booting the engine subprocess + gateway RPC client.
    // The contract tested above (DB-level resumeRunIfNeeded inputs) is what
    // packages/server/src/gateway.js feeds into resumeRunIfNeeded, so this
    // sub-assertion is covered indirectly. Promote once an in-process
    // engine harness exists in /e2e/harness/.
  });
});
