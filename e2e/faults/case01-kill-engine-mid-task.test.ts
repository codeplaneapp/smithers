import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { deriveRunState } from "@smithers-orchestrator/db/runState/deriveRunState";
import type { RunRow } from "@smithers-orchestrator/db/adapter/RunRow";
import { corruptHeartbeat } from "../harness/corruptHeartbeat.ts";

const STALE_THRESHOLD_MS = 30_000;

type RawRunRow = {
  run_id: string;
  workflow_name: string;
  status: string;
  created_at_ms: number;
  started_at_ms: number | null;
  heartbeat_at_ms: number | null;
  runtime_owner_id: string | null;
};

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
  startedAtMs: number = heartbeatAtMs - 5_000,
): void {
  db.query(
    `INSERT INTO _smithers_runs
       (run_id, workflow_name, status, created_at_ms, started_at_ms, heartbeat_at_ms, runtime_owner_id)
     VALUES (?, 'case01-workflow', 'running', ?, ?, ?, ?)`,
  ).run(runId, startedAtMs, startedAtMs, heartbeatAtMs, ownerId);
}

function readRow(db: Database, runId: string): RawRunRow {
  const row = db
    .query("SELECT * FROM _smithers_runs WHERE run_id = ?")
    .get(runId) as RawRunRow | null;
  if (!row) throw new Error(`row missing for ${runId}`);
  return row;
}

function toRunRow(raw: RawRunRow): RunRow {
  return {
    runId: raw.run_id,
    parentRunId: null,
    workflowName: raw.workflow_name,
    workflowPath: null,
    workflowHash: null,
    status: raw.status,
    createdAtMs: raw.created_at_ms,
    startedAtMs: raw.started_at_ms,
    finishedAtMs: null,
    heartbeatAtMs: raw.heartbeat_at_ms,
    runtimeOwnerId: raw.runtime_owner_id,
    cancelRequestedAtMs: null,
    hijackRequestedAtMs: null,
    hijackTarget: null,
    vcsType: null,
    vcsRoot: null,
    vcsRevision: null,
    errorJson: null,
    configJson: null,
  };
}

function takeoverByClaim(
  db: Database,
  runId: string,
  expectedOwnerId: string | null,
  expectedHeartbeatAtMs: number | null,
  staleBeforeMs: number,
  newOwnerId: string,
  newHeartbeatAtMs: number,
): boolean {
  db.query(
    `UPDATE _smithers_runs
       SET runtime_owner_id = ?, heartbeat_at_ms = ?
       WHERE run_id = ?
         AND status = 'running'
         AND COALESCE(runtime_owner_id, '') = COALESCE(?, '')
         AND COALESCE(heartbeat_at_ms, -1) = COALESCE(?, -1)
         AND (heartbeat_at_ms IS NULL OR heartbeat_at_ms < ?)`,
  ).run(
    newOwnerId,
    newHeartbeatAtMs,
    runId,
    expectedOwnerId,
    expectedHeartbeatAtMs,
    staleBeforeMs,
  );
  const changed = db.query("SELECT changes() AS count").get() as {
    count: number;
  };
  return Number(changed.count) > 0;
}

describe("case 01: kill engine mid-task", () => {
  test("killed engine -> stale within SLO; supervisor takeover is exclusive", async () => {
    const db = buildDb();
    const runId = "case01-run";
    const originalOwnerId = "pid:99999:engine-victim";
    const seedHeartbeatAtMs = Date.now() - 1_000;
    const seedStartedAtMs = Date.now() - 10 * STALE_THRESHOLD_MS;

    try {
      seedRunningRun(
        db,
        runId,
        originalOwnerId,
        seedHeartbeatAtMs,
        seedStartedAtMs,
      );

      const fresh = deriveRunState({
        run: toRunRow(readRow(db, runId)),
        staleThresholdMs: STALE_THRESHOLD_MS,
      });
      expect(fresh.state).toBe("running");

      await corruptHeartbeat(db, runId, "stale");

      const stale = deriveRunState({
        run: toRunRow(readRow(db, runId)),
        staleThresholdMs: STALE_THRESHOLD_MS,
      });
      expect(stale.state).toBe("stale");
      expect(stale.unhealthy?.kind).toBe("engine-heartbeat-stale");

      const supervisorOwnerId = "supervisor:case01-takeover";
      const claimHeartbeatAtMs = Date.now();
      const staleBeforeMs = claimHeartbeatAtMs - STALE_THRESHOLD_MS;
      const beforeClaim = readRow(db, runId);

      const firstClaim = takeoverByClaim(
        db,
        runId,
        beforeClaim.runtime_owner_id,
        beforeClaim.heartbeat_at_ms,
        staleBeforeMs,
        supervisorOwnerId,
        claimHeartbeatAtMs,
      );
      expect(firstClaim).toBe(true);

      const secondClaim = takeoverByClaim(
        db,
        runId,
        beforeClaim.runtime_owner_id,
        beforeClaim.heartbeat_at_ms,
        staleBeforeMs,
        "supervisor:would-be-double-resume",
        claimHeartbeatAtMs,
      );
      expect(secondClaim).toBe(false);

      const afterClaim = readRow(db, runId);
      expect(afterClaim.runtime_owner_id).toBe(supervisorOwnerId);
      expect(afterClaim.heartbeat_at_ms).toBe(claimHeartbeatAtMs);

      const recovered = deriveRunState({
        run: toRunRow(afterClaim),
        staleThresholdMs: STALE_THRESHOLD_MS,
        now: claimHeartbeatAtMs,
      });
      expect(recovered.state).toBe("running");
    } finally {
      db.close();
    }
  });

  test("contract regression guard: missing-heartbeat path still flips state to stale", async () => {
    const db = buildDb();
    const runId = "case01-missing-heartbeat";
    const longAgoMs = Date.now() - 10 * STALE_THRESHOLD_MS;

    try {
      seedRunningRun(db, runId, "pid:88888:engine-missing", longAgoMs);
      db.query(
        "UPDATE _smithers_runs SET started_at_ms = ? WHERE run_id = ?",
      ).run(longAgoMs, runId);

      await corruptHeartbeat(db, runId, "missing");

      const view = deriveRunState({
        run: toRunRow(readRow(db, runId)),
        staleThresholdMs: STALE_THRESHOLD_MS,
      });
      expect(view.state).toBe("stale");
    } finally {
      db.close();
    }
  });

  test("contract regression guard: orphaned (no owner) is distinct from stale", async () => {
    const db = buildDb();
    const runId = "case01-orphan";
    const longAgoMs = Date.now() - 10 * STALE_THRESHOLD_MS;

    try {
      db.query(
        `INSERT INTO _smithers_runs
           (run_id, workflow_name, status, created_at_ms, started_at_ms, heartbeat_at_ms, runtime_owner_id)
         VALUES (?, 'case01-workflow', 'running', ?, ?, ?, NULL)`,
      ).run(runId, longAgoMs, longAgoMs, longAgoMs);

      await corruptHeartbeat(db, runId, "stale");

      const view = deriveRunState({
        run: toRunRow(readRow(db, runId)),
        staleThresholdMs: STALE_THRESHOLD_MS,
      });
      expect(view.state).toBe("orphaned");
    } finally {
      db.close();
    }
  });

  test.skip("resume completes with exactly-one delivery via 0019 dedupe keys", () => {
    // Skipped: ticket 0019 (tool side-effect / idempotency metadata) is not
    // implemented yet. The migration packages/db/migrations/0015_tool_call_keys.sql
    // referenced in 0019 does not exist (only 0011, 0012 are present), and
    // SmithersDb has no tool-call-key API. Re-enable once 0019 lands; the test
    // should:
    //   1. seed a tool_call_keys row for (runId, toolName, key) before takeover
    //   2. simulate a duplicate replay attempt with the same key after takeover
    //   3. assert the duplicate is deduped (no second event row, returns cached
    //      result, ToolCallReplayed or `deduped` badge surface is emitted)
    expect(true).toBe(true);
  });
});
