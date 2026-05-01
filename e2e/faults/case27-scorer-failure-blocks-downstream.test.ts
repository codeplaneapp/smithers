import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

type NodeRow = {
  run_id: string;
  node_id: string;
  iteration: number;
  state: string;
  updated_at_ms: number;
  output_table: string;
  label: string | null;
};

type ScorerRow = {
  id: string;
  run_id: string;
  node_id: string;
  iteration: number;
  attempt: number;
  scorer_id: string;
  scorer_name: string;
  source: string;
  score: number;
  reason: string | null;
  meta_json: string | null;
  scored_at_ms: number;
};

type EventRow = {
  run_id: string;
  seq: number;
  type: string;
  payload_json: string;
};

type GateOutcome =
  | { advanced: true; nextState: "running" }
  | {
      advanced: false;
      reason:
        | "scorer-failed"
        | "scorer-below-threshold"
        | "scorer-pending"
        | "scorer-missing";
      nextState: "blocked" | "pending";
    };

const RUN_ID = "run-case27";
const SCORER_NODE_ID = "produce-plan";
const DESTRUCTIVE_NODE_ID = "deploy-prod";
const SCORER_ID = "faithfulness-v1";
const THRESHOLD = 0.7;

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
      label TEXT,
      PRIMARY KEY (run_id, node_id, iteration)
    );
    CREATE TABLE _smithers_scorers (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 0,
      scorer_id TEXT NOT NULL,
      scorer_name TEXT NOT NULL,
      source TEXT NOT NULL,
      score REAL NOT NULL,
      reason TEXT,
      meta_json TEXT,
      scored_at_ms INTEGER NOT NULL
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

function seedRun(db: Database, now: number): void {
  db.query(
    `INSERT INTO _smithers_runs
       (run_id, workflow_name, status, created_at_ms, started_at_ms, heartbeat_at_ms, runtime_owner_id)
     VALUES (?, 'case27-workflow', 'running', ?, ?, ?, 'engine-1')`,
  ).run(RUN_ID, now - 5_000, now - 4_000, now - 1_000);
  db.query(
    `INSERT INTO _smithers_nodes
       (run_id, node_id, iteration, state, updated_at_ms, output_table, label)
     VALUES (?, ?, 0, 'finished', ?, 'out_plan', 'plan')`,
  ).run(RUN_ID, SCORER_NODE_ID, now - 2_000);
  db.query(
    `INSERT INTO _smithers_nodes
       (run_id, node_id, iteration, state, updated_at_ms, output_table, label)
     VALUES (?, ?, 0, 'pending', ?, 'out_deploy', 'destructive:deploy')`,
  ).run(RUN_ID, DESTRUCTIVE_NODE_ID, now - 2_000);
}

function recordScorerFinished(
  db: Database,
  score: number,
  now: number,
): void {
  db.query(
    `INSERT INTO _smithers_scorers
       (id, run_id, node_id, iteration, attempt, scorer_id, scorer_name, source, score, reason, scored_at_ms)
     VALUES (?, ?, ?, 0, 0, ?, 'faithfulness', 'live', ?, ?, ?)`,
  ).run(
    `srow-${score}-${now}`,
    RUN_ID,
    SCORER_NODE_ID,
    SCORER_ID,
    score,
    score < THRESHOLD ? "below threshold" : null,
    now,
  );
  appendEvent(db, "ScorerFinished", now, {
    runId: RUN_ID,
    nodeId: SCORER_NODE_ID,
    scorerId: SCORER_ID,
    scorerName: "faithfulness",
    score,
    timestampMs: now,
  });
}

function recordScorerFailed(
  db: Database,
  errorMessage: string,
  now: number,
): void {
  appendEvent(db, "ScorerFailed", now, {
    runId: RUN_ID,
    nodeId: SCORER_NODE_ID,
    scorerId: SCORER_ID,
    scorerName: "faithfulness",
    error: errorMessage,
    timestampMs: now,
  });
}

function recordScorerStarted(db: Database, now: number): void {
  appendEvent(db, "ScorerStarted", now, {
    runId: RUN_ID,
    nodeId: SCORER_NODE_ID,
    scorerId: SCORER_ID,
    scorerName: "faithfulness",
    timestampMs: now,
  });
}

function appendEvent(
  db: Database,
  type: string,
  now: number,
  payload: Record<string, unknown>,
): void {
  const seq = nextEventSeq(db);
  db.query(
    `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(RUN_ID, seq, now, type, JSON.stringify(payload));
}

function nextEventSeq(db: Database): number {
  const row = db
    .query(
      "SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM _smithers_events WHERE run_id = ?",
    )
    .get(RUN_ID) as { next_seq: number };
  return row.next_seq;
}

function readNode(db: Database, nodeId: string): NodeRow {
  return db
    .query(
      "SELECT * FROM _smithers_nodes WHERE run_id = ? AND node_id = ? AND iteration = 0",
    )
    .get(RUN_ID, nodeId) as NodeRow;
}

function readScorerRows(db: Database, nodeId: string): ScorerRow[] {
  return db
    .query(
      "SELECT * FROM _smithers_scorers WHERE run_id = ? AND node_id = ? ORDER BY scored_at_ms ASC",
    )
    .all(RUN_ID, nodeId) as ScorerRow[];
}

function readEventsByType(db: Database, type: string): EventRow[] {
  return db
    .query(
      "SELECT run_id, seq, type, payload_json FROM _smithers_events WHERE run_id = ? AND type = ? ORDER BY seq ASC",
    )
    .all(RUN_ID, type) as EventRow[];
}

function evaluateGate(db: Database, now: number): GateOutcome {
  const rows = readScorerRows(db, SCORER_NODE_ID).filter(
    (row) => row.scorer_id === SCORER_ID,
  );
  const failedEvents = readEventsByType(db, "ScorerFailed").filter((evt) => {
    const payload = JSON.parse(evt.payload_json) as { scorerId?: string };
    return payload.scorerId === SCORER_ID;
  });
  const startedEvents = readEventsByType(db, "ScorerStarted").filter((evt) => {
    const payload = JSON.parse(evt.payload_json) as { scorerId?: string };
    return payload.scorerId === SCORER_ID;
  });

  if (failedEvents.length > 0 && rows.length === 0) {
    block(db, "scorer-failed", now);
    return { advanced: false, reason: "scorer-failed", nextState: "blocked" };
  }
  if (rows.length === 0 && startedEvents.length > 0) {
    return {
      advanced: false,
      reason: "scorer-pending",
      nextState: "pending",
    };
  }
  if (rows.length === 0) {
    return {
      advanced: false,
      reason: "scorer-missing",
      nextState: "pending",
    };
  }
  const latest = rows[rows.length - 1]!;
  if (latest.score < THRESHOLD) {
    block(db, "scorer-below-threshold", now);
    return {
      advanced: false,
      reason: "scorer-below-threshold",
      nextState: "blocked",
    };
  }
  db.query(
    `UPDATE _smithers_nodes SET state = 'running', updated_at_ms = ?
       WHERE run_id = ? AND node_id = ? AND iteration = 0`,
  ).run(now, RUN_ID, DESTRUCTIVE_NODE_ID);
  appendEvent(db, "DestructiveNodeAdvanced", now, {
    runId: RUN_ID,
    nodeId: DESTRUCTIVE_NODE_ID,
    gatedBy: { scorerId: SCORER_ID, sourceNodeId: SCORER_NODE_ID },
    score: latest.score,
    threshold: THRESHOLD,
    timestampMs: now,
  });
  return { advanced: true, nextState: "running" };
}

function block(
  db: Database,
  reason: "scorer-failed" | "scorer-below-threshold",
  now: number,
): void {
  db.query(
    `UPDATE _smithers_nodes SET state = 'blocked', updated_at_ms = ?
       WHERE run_id = ? AND node_id = ? AND iteration = 0`,
  ).run(now, RUN_ID, DESTRUCTIVE_NODE_ID);
  appendEvent(db, "NodeGatedByScorerFailure", now, {
    runId: RUN_ID,
    nodeId: DESTRUCTIVE_NODE_ID,
    gatedBy: { scorerId: SCORER_ID, sourceNodeId: SCORER_NODE_ID },
    reason,
    threshold: THRESHOLD,
    timestampMs: now,
  });
}

describe("case 27: scorer failure blocks destructive downstream step", () => {
  test("scorer schema invariants: failure-or-low-score is queryable per (run, node, scorer)", () => {
    const db = buildDb();
    try {
      const t0 = Date.now();
      seedRun(db, t0);
      recordScorerFinished(db, 0.42, t0 + 100);
      const rows = readScorerRows(db, SCORER_NODE_ID);
      expect(rows.length).toBe(1);
      expect(rows[0]!.score).toBeLessThan(THRESHOLD);
      const destructive = readNode(db, DESTRUCTIVE_NODE_ID);
      expect(destructive.state).toBe("pending");
      expect(destructive.label).toContain("destructive:");
    } finally {
      db.close();
    }
  });

  test("A: scorer FAILS (ScorerFailed event, no row) -> destructive node is blocked, gating event recorded", () => {
    const db = buildDb();
    try {
      const t0 = Date.now();
      seedRun(db, t0);
      recordScorerStarted(db, t0 + 50);
      recordScorerFailed(db, "llm provider 500", t0 + 200);

      const outcome = evaluateGate(db, t0 + 300);
      expect(outcome.advanced).toBe(false);
      if (!outcome.advanced) {
        expect(outcome.reason).toBe("scorer-failed");
        expect(outcome.nextState).toBe("blocked");
      }

      const destructive = readNode(db, DESTRUCTIVE_NODE_ID);
      expect(destructive.state).toBe("blocked");
      expect(destructive.state).not.toBe("running");
      expect(destructive.state).not.toBe("succeeded");

      const gated = readEventsByType(db, "NodeGatedByScorerFailure");
      expect(gated.length).toBe(1);
      const payload = JSON.parse(gated[0]!.payload_json) as {
        runId: string;
        nodeId: string;
        gatedBy: { scorerId: string; sourceNodeId: string };
        reason: string;
      };
      expect(payload.runId).toBe(RUN_ID);
      expect(payload.nodeId).toBe(DESTRUCTIVE_NODE_ID);
      expect(payload.gatedBy.scorerId).toBe(SCORER_ID);
      expect(payload.gatedBy.sourceNodeId).toBe(SCORER_NODE_ID);
      expect(payload.reason).toBe("scorer-failed");

      const advanced = readEventsByType(db, "DestructiveNodeAdvanced");
      expect(advanced.length).toBe(0);
    } finally {
      db.close();
    }
  });

  test("A2: scorer score BELOW threshold -> destructive node is blocked", () => {
    const db = buildDb();
    try {
      const t0 = Date.now();
      seedRun(db, t0);
      recordScorerFinished(db, 0.31, t0 + 200);

      const outcome = evaluateGate(db, t0 + 300);
      expect(outcome.advanced).toBe(false);
      if (!outcome.advanced) {
        expect(outcome.reason).toBe("scorer-below-threshold");
      }
      expect(readNode(db, DESTRUCTIVE_NODE_ID).state).toBe("blocked");
      const gated = readEventsByType(db, "NodeGatedByScorerFailure");
      expect(gated.length).toBe(1);
      const payload = JSON.parse(gated[0]!.payload_json) as { reason: string };
      expect(payload.reason).toBe("scorer-below-threshold");
    } finally {
      db.close();
    }
  });

  test("B: scorer PASSES (score above threshold) -> destructive node advances to running", () => {
    const db = buildDb();
    try {
      const t0 = Date.now();
      seedRun(db, t0);
      recordScorerFinished(db, 0.92, t0 + 200);

      expect(readNode(db, DESTRUCTIVE_NODE_ID).state).toBe("pending");
      const outcome = evaluateGate(db, t0 + 300);
      expect(outcome.advanced).toBe(true);
      if (outcome.advanced) {
        expect(outcome.nextState).toBe("running");
      }
      expect(readNode(db, DESTRUCTIVE_NODE_ID).state).toBe("running");
      expect(readEventsByType(db, "NodeGatedByScorerFailure").length).toBe(0);
      const advanced = readEventsByType(db, "DestructiveNodeAdvanced");
      expect(advanced.length).toBe(1);
      const payload = JSON.parse(advanced[0]!.payload_json) as {
        nodeId: string;
        score: number;
        threshold: number;
      };
      expect(payload.nodeId).toBe(DESTRUCTIVE_NODE_ID);
      expect(payload.score).toBeGreaterThanOrEqual(THRESHOLD);
      expect(payload.threshold).toBe(THRESHOLD);
    } finally {
      db.close();
    }
  });

  test("C: scorer IN-FLIGHT (started, no row, no fail) -> destructive node held in pending", () => {
    const db = buildDb();
    try {
      const t0 = Date.now();
      seedRun(db, t0);
      recordScorerStarted(db, t0 + 50);

      const outcome = evaluateGate(db, t0 + 100);
      expect(outcome.advanced).toBe(false);
      if (!outcome.advanced) {
        expect(outcome.reason).toBe("scorer-pending");
        expect(outcome.nextState).toBe("pending");
      }
      const destructive = readNode(db, DESTRUCTIVE_NODE_ID);
      expect(destructive.state).toBe("pending");
      expect(destructive.state).not.toBe("running");
      expect(destructive.state).not.toBe("blocked");
      expect(readEventsByType(db, "NodeGatedByScorerFailure").length).toBe(0);
      expect(readEventsByType(db, "DestructiveNodeAdvanced").length).toBe(0);

      recordScorerFinished(db, 0.95, t0 + 500);
      const second = evaluateGate(db, t0 + 600);
      expect(second.advanced).toBe(true);
      expect(readNode(db, DESTRUCTIVE_NODE_ID).state).toBe("running");
    } finally {
      db.close();
    }
  });

  test.skip("engine enforces scorer-gates-destructive-step contract end-to-end", () => {
    // SKIP: as of packages/engine/src/engine.js (around line 3710), scorers run
    // fire-and-forget via runScorersAsync() AFTER the upstream task already
    // finished, and there is no read-side check anywhere in the engine that
    // inspects _smithers_scorers / ScorerFailed events before letting a
    // downstream node advance. The _smithers_nodes.state machine has no
    // 'blocked' transition driven by scorer outcome, and scorer rows don't
    // carry a `status` column (only `score` is recorded; failures are
    // signalled by ScorerFailed events with NO row written; see
    // packages/scorers/src/run-scorers.js:81-94).
    //
    // The sub-tests above pin the *intended* schema-level contract:
    //   - destructive nodes carry a label / marker (here `destructive:*`),
    //   - low score or ScorerFailed event for a gating scorer must keep the
    //     downstream node out of `running` and write a
    //     NodeGatedByScorerFailure event,
    //   - in-flight scorer holds the downstream node in `pending`.
    //
    // Promote this case once the engine grows a real gate. The right home is
    // the readiness check in packages/engine/src/engine.js where a node moves
    // from `pending` -> `running`; it should consult _smithers_scorers and the
    // event log for any scorer bound as a gate to an upstream node and refuse
    // to advance unless score >= threshold.
  });
});
