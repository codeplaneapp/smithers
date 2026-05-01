import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

type AnyRow = Record<string, unknown>;

type DbSnapshot = Record<string, AnyRow[]>;

const RUN_ID = "case11-run";
const OWNER_ID = "engine:case11-immutable";
const EVENT_COUNT = 10;

const ALL_TABLES = [
  "_smithers_runs",
  "_smithers_nodes",
  "_smithers_events",
  "_smithers_node_diffs",
  "_smithers_time_travel_audit",
] as const;

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
      last_attempt INTEGER,
      updated_at_ms INTEGER NOT NULL,
      output_table TEXT NOT NULL,
      label TEXT,
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
    CREATE TABLE _smithers_node_diffs (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      base_ref TEXT NOT NULL,
      diff_json TEXT NOT NULL,
      computed_at_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      PRIMARY KEY (run_id, node_id, iteration, base_ref)
    );
    CREATE TABLE _smithers_time_travel_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      from_frame_no INTEGER NOT NULL,
      to_frame_no INTEGER NOT NULL,
      caller TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      result TEXT NOT NULL,
      duration_ms INTEGER
    );
  `);
  return db;
}

function seedRun(db: Database, baseMs: number): void {
  db.query(
    `INSERT INTO _smithers_runs
       (run_id, workflow_name, status, created_at_ms, started_at_ms,
        heartbeat_at_ms, runtime_owner_id)
     VALUES (?, 'case11-workflow', 'running', ?, ?, ?, ?)`,
  ).run(RUN_ID, baseMs - 60_000, baseMs - 50_000, baseMs - 1_000, OWNER_ID);

  const nodeId = "node-A";
  for (let iteration = 0; iteration < EVENT_COUNT; iteration++) {
    const ts = baseMs - (EVENT_COUNT - iteration) * 1_000;
    db.query(
      `INSERT INTO _smithers_events
         (run_id, seq, timestamp_ms, type, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      RUN_ID,
      iteration,
      ts,
      iteration === 0 ? "NodeStarted" : "NodeProgressed",
      JSON.stringify({ nodeId, iteration, value: iteration * 7 }),
    );

    db.query(
      `INSERT INTO _smithers_node_diffs
         (run_id, node_id, iteration, base_ref, diff_json,
          computed_at_ms, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      RUN_ID,
      nodeId,
      iteration,
      iteration === 0 ? "genesis" : `iter-${iteration - 1}`,
      JSON.stringify({ op: "set", path: "/value", value: iteration * 7 }),
      ts,
      48,
    );
  }

  db.query(
    `INSERT INTO _smithers_nodes
       (run_id, node_id, iteration, state, last_attempt,
        updated_at_ms, output_table, label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    RUN_ID,
    nodeId,
    EVENT_COUNT - 1,
    "running",
    1,
    baseMs - 1_000,
    "outputs_node_a",
    "Node A",
  );
}

function captureSnapshot(db: Database): DbSnapshot {
  const snapshot: DbSnapshot = {};
  for (const table of ALL_TABLES) {
    const rows = db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as AnyRow[];
    snapshot[table] = rows;
  }
  return snapshot;
}

type ScrubView = {
  frameNo: number;
  events: AnyRow[];
  reconstructedNodeValue: number | null;
};

function scrubToFrame(db: Database, frameNo: number): ScrubView {
  const events = db
    .query(
      `SELECT seq, type, payload_json, timestamp_ms
         FROM _smithers_events
        WHERE run_id = ? AND seq <= ?
        ORDER BY seq ASC`,
    )
    .all(RUN_ID, frameNo) as AnyRow[];

  const diffs = db
    .query(
      `SELECT iteration, diff_json
         FROM _smithers_node_diffs
        WHERE run_id = ? AND node_id = ? AND iteration <= ?
        ORDER BY iteration ASC`,
    )
    .all(RUN_ID, "node-A", frameNo) as AnyRow[];

  let value: number | null = null;
  for (const diff of diffs) {
    const parsed = JSON.parse(String(diff.diff_json)) as {
      op: string;
      path: string;
      value: number;
    };
    if (parsed.op === "set" && parsed.path === "/value") {
      value = parsed.value;
    }
  }

  return { frameNo, events, reconstructedNodeValue: value };
}

describe("case 11: frame scrub for view-only time travel", () => {
  test("scrubbing across all frames mutates zero rows", () => {
    const db = buildDb();
    try {
      const baseMs = Date.now();
      seedRun(db, baseMs);

      const baseline = captureSnapshot(db);
      expect(baseline._smithers_events).toHaveLength(EVENT_COUNT);
      expect(baseline._smithers_node_diffs).toHaveLength(EVENT_COUNT);
      expect(baseline._smithers_runs).toHaveLength(1);
      expect(baseline._smithers_nodes).toHaveLength(1);
      expect(baseline._smithers_time_travel_audit).toHaveLength(0);

      const views: ScrubView[] = [];
      for (let frame = 0; frame < EVENT_COUNT; frame++) {
        views.push(scrubToFrame(db, frame));
      }
      views.push(scrubToFrame(db, 0));
      views.push(scrubToFrame(db, EVENT_COUNT - 1));
      views.push(scrubToFrame(db, 4));

      const after = captureSnapshot(db);

      expect(JSON.stringify(after)).toBe(JSON.stringify(baseline));
      for (const table of ALL_TABLES) {
        expect(after[table]).toEqual(baseline[table]);
      }

      expect(views[0]?.events).toHaveLength(1);
      expect(views[0]?.reconstructedNodeValue).toBe(0);
      expect(views[EVENT_COUNT - 1]?.events).toHaveLength(EVENT_COUNT);
      expect(views[EVENT_COUNT - 1]?.reconstructedNodeValue).toBe(
        (EVENT_COUNT - 1) * 7,
      );
      expect(views[4]?.reconstructedNodeValue).toBe(4 * 7);
    } finally {
      db.close();
    }
  });

  test("scrub never writes a time-travel audit row (audit is for mutators only)", () => {
    const db = buildDb();
    try {
      const baseMs = Date.now();
      seedRun(db, baseMs);

      const beforeAudit = db
        .query(
          `SELECT COUNT(*) AS n FROM _smithers_time_travel_audit
            WHERE run_id = ?`,
        )
        .get(RUN_ID) as { n: number };
      expect(Number(beforeAudit.n)).toBe(0);

      for (let frame = 0; frame < EVENT_COUNT; frame++) {
        scrubToFrame(db, frame);
      }

      const afterAudit = db
        .query(
          `SELECT COUNT(*) AS n FROM _smithers_time_travel_audit
            WHERE run_id = ?`,
        )
        .get(RUN_ID) as { n: number };
      expect(Number(afterAudit.n)).toBe(0);

      const scrubbyAudit = db
        .query(
          `SELECT COUNT(*) AS n FROM _smithers_time_travel_audit
            WHERE caller LIKE '%scrub%' OR caller LIKE '%view%'`,
        )
        .get() as { n: number };
      expect(Number(scrubbyAudit.n)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("engine ownership and node row are untouched after scrub", () => {
    const db = buildDb();
    try {
      const baseMs = Date.now();
      seedRun(db, baseMs);

      const runBefore = db
        .query(`SELECT * FROM _smithers_runs WHERE run_id = ?`)
        .get(RUN_ID) as AnyRow;
      const nodeBefore = db
        .query(`SELECT * FROM _smithers_nodes WHERE run_id = ?`)
        .get(RUN_ID) as AnyRow;
      expect(runBefore.runtime_owner_id).toBe(OWNER_ID);

      for (let frame = EVENT_COUNT - 1; frame >= 0; frame--) {
        scrubToFrame(db, frame);
      }

      const runAfter = db
        .query(`SELECT * FROM _smithers_runs WHERE run_id = ?`)
        .get(RUN_ID) as AnyRow;
      const nodeAfter = db
        .query(`SELECT * FROM _smithers_nodes WHERE run_id = ?`)
        .get(RUN_ID) as AnyRow;

      expect(runAfter).toEqual(runBefore);
      expect(nodeAfter).toEqual(nodeBefore);
      expect(runAfter.runtime_owner_id).toBe(OWNER_ID);
      expect(runAfter.status).toBe("running");
    } finally {
      db.close();
    }
  });

  test("regression guard: a write masquerading as scrub fails the snapshot diff", () => {
    const db = buildDb();
    try {
      const baseMs = Date.now();
      seedRun(db, baseMs);

      const baseline = captureSnapshot(db);

      db.query(
        `INSERT INTO _smithers_time_travel_audit
           (run_id, from_frame_no, to_frame_no, caller, timestamp_ms, result, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(RUN_ID, 9, 4, "rewind", baseMs, "ok", 12);

      const after = captureSnapshot(db);
      expect(JSON.stringify(after)).not.toBe(JSON.stringify(baseline));
      expect(after._smithers_time_travel_audit).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
