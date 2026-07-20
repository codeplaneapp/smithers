import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { corruptHeartbeat } from "./corruptHeartbeat.ts";

const STALE_THRESHOLD_MS = 30_000;

type RawRunRow = { heartbeat_at_ms: number | null };

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
  `);
  return db;
}

function seedRun(db: Database, runId: string, heartbeatAtMs: number): void {
  db.query(
    `INSERT INTO _smithers_runs
       (run_id, workflow_name, status, created_at_ms, started_at_ms, heartbeat_at_ms, runtime_owner_id)
     VALUES (?, 'fault-test', 'running', ?, ?, ?, 'owner-1')`,
  ).run(runId, heartbeatAtMs - 1_000, heartbeatAtMs - 1_000, heartbeatAtMs);
}

function readHeartbeat(db: Database, runId: string): number | null {
  const row = db
    .query("SELECT heartbeat_at_ms FROM _smithers_runs WHERE run_id = ?")
    .get(runId) as RawRunRow | null;
  return row ? row.heartbeat_at_ms : null;
}

describe("corruptHeartbeat", () => {
  test("stale mode backdates heartbeat past the stale threshold", async () => {
    const db = buildDb();
    try {
      const runId = "run-stale";
      const before = Date.now();
      seedRun(db, runId, before);

      await corruptHeartbeat(db, runId, "stale");

      const heartbeat = readHeartbeat(db, runId);
      const after = Date.now();
      expect(heartbeat).not.toBeNull();
      expect(heartbeat!).toBeLessThanOrEqual(after - 10 * STALE_THRESHOLD_MS);
      expect(after - heartbeat!).toBeGreaterThan(STALE_THRESHOLD_MS);
    } finally {
      db.close();
    }
  });

  test("missing mode clears the heartbeat column to NULL", async () => {
    const db = buildDb();
    try {
      const runId = "run-missing";
      seedRun(db, runId, Date.now());

      await corruptHeartbeat(db, runId, "missing");

      expect(readHeartbeat(db, runId)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("future mode forwards heartbeat ~1h ahead", async () => {
    const db = buildDb();
    try {
      const runId = "run-future";
      const before = Date.now();
      seedRun(db, runId, before);

      await corruptHeartbeat(db, runId, "future");

      const heartbeat = readHeartbeat(db, runId);
      const after = Date.now();
      expect(heartbeat).not.toBeNull();
      expect(heartbeat!).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
      expect(heartbeat!).toBeLessThanOrEqual(after + 60 * 60 * 1000 + 5_000);
    } finally {
      db.close();
    }
  });
});
