import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { corruptHeartbeat } from "../harness/corruptHeartbeat.ts";
import { takeoverRun } from "../harness/takeoverRun.ts";

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
  `);
  return db;
}

function seedRunningRun(
  db: Database,
  runId: string,
  ownerId: string,
  heartbeatAtMs: number,
): void {
  db.query(
    `INSERT INTO _smithers_runs
       (run_id, workflow_name, status, created_at_ms, started_at_ms, heartbeat_at_ms, runtime_owner_id)
     VALUES (?, 'case06-workflow', 'running', ?, ?, ?, ?)`,
  ).run(runId, heartbeatAtMs - 5_000, heartbeatAtMs - 5_000, heartbeatAtMs, ownerId);
}

function fencedHeartbeatBump(
  db: Database,
  runId: string,
  callerOwnerId: string,
  newHeartbeatAtMs: number,
): boolean {
  db.query(
    `UPDATE _smithers_runs
       SET heartbeat_at_ms = ?
     WHERE run_id = ?
       AND runtime_owner_id = ?`,
  ).run(newHeartbeatAtMs, runId, callerOwnerId);
  const { count } = db.query("SELECT changes() AS count").get() as {
    count: number;
  };
  return Number(count) > 0;
}

describe("case 06: concurrent resume vs supervisor takeover", () => {
  test("CAS-on-runtime_owner_id: exactly one of (resume, supervisor) wins", () => {
    const db = buildDb();
    const runId = "case06-run";
    const originalOwnerId = "pid:11111:engine-victim";

    try {
      seedRunningRun(db, runId, originalOwnerId, Date.now());
      corruptHeartbeat(db, runId, "stale");

      const resumerOwnerId = "resume-cli:case06";
      const supervisorOwnerId = "supervisor:case06";

      const resumeResult = takeoverRun(db, runId, resumerOwnerId, {
        staleThresholdMs: STALE_THRESHOLD_MS,
      });
      const supervisorResult = takeoverRun(db, runId, supervisorOwnerId, {
        staleThresholdMs: STALE_THRESHOLD_MS,
      });

      const winners = [resumeResult.claimed, supervisorResult.claimed].filter(
        (claimed) => claimed,
      );
      expect(winners.length).toBe(1);
      expect(resumeResult.claimed).toBe(true);
      expect(supervisorResult.claimed).toBe(false);

      const row = db
        .query(
          "SELECT runtime_owner_id FROM _smithers_runs WHERE run_id = ?",
        )
        .get(runId) as { runtime_owner_id: string };
      expect(row.runtime_owner_id).toBe(resumerOwnerId);
    } finally {
      db.close();
    }
  });

  test("supervisor wins when called first; resume is fenced out", () => {
    const db = buildDb();
    const runId = "case06-supervisor-first";
    const originalOwnerId = "pid:22222:engine-victim";

    try {
      seedRunningRun(db, runId, originalOwnerId, Date.now());
      corruptHeartbeat(db, runId, "stale");

      const resumerOwnerId = "resume-cli:case06b";
      const supervisorOwnerId = "supervisor:case06b";

      const supervisorResult = takeoverRun(db, runId, supervisorOwnerId, {
        staleThresholdMs: STALE_THRESHOLD_MS,
      });
      const resumeResult = takeoverRun(db, runId, resumerOwnerId, {
        staleThresholdMs: STALE_THRESHOLD_MS,
      });

      expect(supervisorResult.claimed).toBe(true);
      expect(resumeResult.claimed).toBe(false);

      const row = db
        .query(
          "SELECT runtime_owner_id FROM _smithers_runs WHERE run_id = ?",
        )
        .get(runId) as { runtime_owner_id: string };
      expect(row.runtime_owner_id).toBe(supervisorOwnerId);
    } finally {
      db.close();
    }
  });

  test("post-takeover writes are fenced: only the winner can mutate run state", () => {
    const db = buildDb();
    const runId = "case06-fence";
    const originalOwnerId = "pid:33333:engine-victim";

    try {
      seedRunningRun(db, runId, originalOwnerId, Date.now());
      corruptHeartbeat(db, runId, "stale");

      const resumerOwnerId = "resume-cli:case06c";
      const supervisorOwnerId = "supervisor:case06c";

      const resumeResult = takeoverRun(db, runId, resumerOwnerId, {
        staleThresholdMs: STALE_THRESHOLD_MS,
      });
      const supervisorResult = takeoverRun(db, runId, supervisorOwnerId, {
        staleThresholdMs: STALE_THRESHOLD_MS,
      });

      expect(resumeResult.claimed).toBe(true);
      expect(supervisorResult.claimed).toBe(false);

      const loserBumped = fencedHeartbeatBump(
        db,
        runId,
        supervisorOwnerId,
        Date.now() + 1_000,
      );
      expect(loserBumped).toBe(false);

      const stillStaleOwner = fencedHeartbeatBump(
        db,
        runId,
        originalOwnerId,
        Date.now() + 2_000,
      );
      expect(stillStaleOwner).toBe(false);

      const winnerBumpAtMs = Date.now() + 3_000;
      const winnerBumped = fencedHeartbeatBump(
        db,
        runId,
        resumerOwnerId,
        winnerBumpAtMs,
      );
      expect(winnerBumped).toBe(true);

      const row = db
        .query(
          "SELECT runtime_owner_id, heartbeat_at_ms FROM _smithers_runs WHERE run_id = ?",
        )
        .get(runId) as { runtime_owner_id: string; heartbeat_at_ms: number };
      expect(row.runtime_owner_id).toBe(resumerOwnerId);
      expect(row.heartbeat_at_ms).toBe(winnerBumpAtMs);
    } finally {
      db.close();
    }
  });
});
