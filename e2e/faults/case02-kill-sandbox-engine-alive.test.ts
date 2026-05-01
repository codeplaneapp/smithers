import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { deriveRunState } from "@smithers-orchestrator/db/runState/deriveRunState";
import { RUN_STATE_HEARTBEAT_STALE_MS } from "@smithers-orchestrator/db/runState/RUN_STATE_HEARTBEAT_STALE_MS";
import type { RunRow } from "@smithers-orchestrator/db/adapter/RunRow";
import type { SandboxHandle } from "@smithers-orchestrator/sandbox/SandboxHandle";
import { stallSandbox } from "../harness/stallSandbox.ts";
import { corruptHeartbeat } from "../harness/corruptHeartbeat.ts";

const ENGINE_OWNER_ID = "pid:11111:engine-alive";

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

function seedRunningRun(db: Database, runId: string, heartbeatAtMs: number): void {
  db.query(
    `INSERT INTO _smithers_runs
       (run_id, workflow_name, status, created_at_ms, started_at_ms, heartbeat_at_ms, runtime_owner_id)
     VALUES (?, 'case02-fault', 'running', ?, ?, ?, ?)`,
  ).run(
    runId,
    heartbeatAtMs - 60_000,
    heartbeatAtMs - 60_000,
    heartbeatAtMs,
    ENGINE_OWNER_ID,
  );
}

function readRunRow(db: Database, runId: string): RunRow {
  const raw = db
    .query(
      "SELECT run_id, workflow_name, status, created_at_ms, started_at_ms, heartbeat_at_ms, runtime_owner_id FROM _smithers_runs WHERE run_id = ?",
    )
    .get(runId) as RawRunRow | null;
  if (!raw) throw new Error(`run ${runId} not found`);
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

type Sandbox = {
  handle: SandboxHandle;
  cleanup: () => void;
};

function createSandbox(runId: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), `case02-sbx-${runId}-`));
  const sandboxRoot = join(root, "sandbox");
  const requestPath = join(sandboxRoot, "request");
  const resultPath = join(sandboxRoot, "result");
  mkdirSync(requestPath, { recursive: true });
  mkdirSync(resultPath, { recursive: true });
  writeFileSync(join(requestPath, "marker.txt"), "ok", "utf8");
  return {
    handle: {
      runtime: "bubblewrap",
      runId,
      sandboxId: `sbx-${runId}`,
      sandboxRoot,
      requestPath,
      resultPath,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("case02 kill-sandbox-engine-alive", () => {
  test("sandbox stalled (request path missing) — fault is observable on the filesystem while engine row stays fresh", async () => {
    const runId = "case02-stall-fault";
    const db = buildDb();
    const { handle, cleanup: sbxCleanup } = createSandbox(runId);
    try {
      const now = Date.now();
      seedRunningRun(db, runId, now);

      const stall = await stallSandbox(handle, 5_000);
      try {
        expect(existsSync(handle.requestPath)).toBe(false);
        expect(existsSync(`${handle.requestPath}.stalled`)).toBe(true);

        const view = deriveRunState({ run: readRunRow(db, runId), now });
        expect(view.state).toBe("running");
        expect(view.unhealthy).toBeUndefined();
      } finally {
        stall.release();
      }
    } finally {
      sbxCleanup();
      db.close();
    }
  });

  test("heartbeat past stale threshold with live owner → run classified stale + unhealthy", async () => {
    const runId = "case02-stale";
    const db = buildDb();
    try {
      const now = Date.now();
      seedRunningRun(db, runId, now);

      await corruptHeartbeat(db, runId, "stale");

      const view = deriveRunState({ run: readRunRow(db, runId) });
      expect(view.runId).toBe(runId);
      expect(view.state).toBe("stale");
      expect(view.unhealthy).toBeDefined();
      expect(view.unhealthy?.kind).toBe("engine-heartbeat-stale");
    } finally {
      db.close();
    }
  });

  test("heartbeat past orphan threshold with no owner → orphaned (recovery state-machine entry per ticket 0018)", async () => {
    const runId = "case02-orphaned";
    const db = buildDb();
    try {
      const now = Date.now();
      seedRunningRun(db, runId, now);
      await corruptHeartbeat(db, runId, "stale");
      db.query("UPDATE _smithers_runs SET runtime_owner_id = NULL WHERE run_id = ?").run(runId);

      const view = deriveRunState({ run: readRunRow(db, runId) });
      expect(view.state).toBe("orphaned");
      expect(view.unhealthy?.kind).toBe("engine-heartbeat-stale");
    } finally {
      db.close();
    }
  });

  test("just-inside the SLO window, run remains running (red on regression of threshold)", async () => {
    const runId = "case02-edge";
    const db = buildDb();
    try {
      const now = Date.now();
      const heartbeat = now - (RUN_STATE_HEARTBEAT_STALE_MS - 1_000);
      seedRunningRun(db, runId, heartbeat);

      const view = deriveRunState({ run: readRunRow(db, runId), now });
      expect(view.state).toBe("running");
      expect(view.unhealthy).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test.skip(
    "fresh engine heartbeat + stale sandbox heartbeat → unhealthy reason points at sandbox (blocked: dual-heartbeat schema absent; ticket 0016)",
    () => {
      // When ticket 0016's sandbox-heartbeat surface lands and
      // computeRunState distinguishes the two streams, this asserts
      // an alive engine + dead sandbox produces unhealthy with a
      // sandbox-specific reason rather than engine-heartbeat-stale.
    },
  );
});
