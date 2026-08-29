import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { takeoverRun } from "./takeoverRun.ts";

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

function seed(
  db: Database,
  runId: string,
  ownerId: string | null,
  heartbeatAtMs: number | null,
): void {
  db.query(
    `INSERT INTO _smithers_runs
       (run_id, workflow_name, status, created_at_ms, started_at_ms, heartbeat_at_ms, runtime_owner_id)
     VALUES (?, 'wf', 'running', 0, 0, ?, ?)`,
  ).run(runId, heartbeatAtMs, ownerId);
}

describe("takeoverRun", () => {
  test("claims a run with a stale heartbeat", () => {
    const db = buildDb();
    try {
      seed(db, "r1", "old-owner", Date.now() - 10 * 60_000);
      const result = takeoverRun(db, "r1", "new-owner");
      expect(result.claimed).toBe(true);
      const row = db
        .query("SELECT runtime_owner_id, heartbeat_at_ms FROM _smithers_runs WHERE run_id = ?")
        .get("r1") as { runtime_owner_id: string; heartbeat_at_ms: number };
      expect(row.runtime_owner_id).toBe("new-owner");
      expect(row.heartbeat_at_ms).toBe(result.newHeartbeatAtMs);
    } finally {
      db.close();
    }
  });

  test("refuses to claim a run with a fresh heartbeat", () => {
    const db = buildDb();
    try {
      seed(db, "r1", "old-owner", Date.now());
      const result = takeoverRun(db, "r1", "new-owner");
      expect(result.claimed).toBe(false);
      const row = db
        .query("SELECT runtime_owner_id FROM _smithers_runs WHERE run_id = ?")
        .get("r1") as { runtime_owner_id: string };
      expect(row.runtime_owner_id).toBe("old-owner");
    } finally {
      db.close();
    }
  });

  test("two concurrent takeovers: only one wins", () => {
    const db = buildDb();
    try {
      seed(db, "r1", "old-owner", Date.now() - 10 * 60_000);
      const a = takeoverRun(db, "r1", "owner-a");
      const b = takeoverRun(db, "r1", "owner-b");
      expect(a.claimed).toBe(true);
      expect(b.claimed).toBe(false);
    } finally {
      db.close();
    }
  });

  test("missing run returns claimed=false", () => {
    const db = buildDb();
    try {
      const result = takeoverRun(db, "nonexistent", "new-owner");
      expect(result.claimed).toBe(false);
    } finally {
      db.close();
    }
  });
});
