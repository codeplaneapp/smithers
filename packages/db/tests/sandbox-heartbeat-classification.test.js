import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";
import { computeRunState } from "../src/runState/computeRunState.js";

const NOW = 1_700_000_000_000;
const STALE_THRESHOLD_MS = 30_000;

function createAdapter() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

async function insertRunningRun(adapter, runId = "sandbox-heartbeat-run") {
  await adapter.insertRun({
    runId,
    workflowName: "sandbox-heartbeat",
    status: "running",
    createdAtMs: NOW - 60_000,
    startedAtMs: NOW - 60_000,
    heartbeatAtMs: NOW,
    runtimeOwnerId: `pid:${process.pid}:engine`,
  });
}

describe("sandbox heartbeat classification", () => {
  test("migrates the sandbox heartbeat column for a persisted legacy sandbox row", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
          CREATE TABLE _smithers_sandboxes (
            run_id TEXT NOT NULL,
            sandbox_id TEXT NOT NULL,
            runtime TEXT NOT NULL DEFAULT 'bubblewrap',
            remote_run_id TEXT,
            workspace_id TEXT,
            container_id TEXT,
            config_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            shipped_at_ms INTEGER,
            completed_at_ms INTEGER,
            bundle_path TEXT,
            PRIMARY KEY (run_id, sandbox_id)
          );
          INSERT INTO _smithers_sandboxes
            (run_id, sandbox_id, config_json, status)
          VALUES ('legacy-run', 'legacy-sandbox', '{}', 'shipped');
        `);

    ensureSmithersTables(drizzle(sqlite));

    const columns = sqlite
      .query("PRAGMA table_info('_smithers_sandboxes')")
      .all()
      .map((column) => column.name);
    expect(columns).toContain("heartbeat_at_ms");
    expect(
      sqlite.query("SELECT sandbox_id, heartbeat_at_ms FROM _smithers_sandboxes WHERE run_id = ?").get("legacy-run"),
    ).toEqual({ sandbox_id: "legacy-sandbox", heartbeat_at_ms: null });
    sqlite.close();
  });

  test("keeps a fresh engine running while surfacing a stale active sandbox", async () => {
    const { sqlite, adapter } = createAdapter();
    try {
      await insertRunningRun(adapter);
      await adapter.upsertSandbox({
        runId: "sandbox-heartbeat-run",
        sandboxId: "stale-sandbox",
        runtime: "bubblewrap",
        remoteRunId: null,
        workspaceId: null,
        containerId: null,
        configJson: "{}",
        status: "shipped",
        heartbeatAtMs: NOW - STALE_THRESHOLD_MS - 1,
        shippedAtMs: NOW - STALE_THRESHOLD_MS - 1,
        completedAtMs: null,
        bundlePath: null,
      });

      const view = await computeRunState(adapter, "sandbox-heartbeat-run", {
        now: NOW,
        staleThresholdMs: STALE_THRESHOLD_MS,
      });

      expect(view).toEqual({
        runId: "sandbox-heartbeat-run",
        state: "running",
        unhealthy: { kind: "sandbox-unreachable" },
        computedAt: new Date(NOW).toISOString(),
      });
    } finally {
      sqlite.close();
    }
  });

  test("persists only forward heartbeats while the sandbox remains active", async () => {
    const { sqlite, adapter } = createAdapter();
    try {
      await adapter.upsertSandbox({
        runId: "heartbeat-write-run",
        sandboxId: "heartbeat-write-sandbox",
        runtime: "bubblewrap",
        remoteRunId: null,
        workspaceId: null,
        containerId: null,
        configJson: "{}",
        status: "shipped",
        heartbeatAtMs: NOW - 1_000,
        shippedAtMs: NOW - 1_000,
        completedAtMs: null,
        bundlePath: null,
      });

      await adapter.heartbeatSandbox("heartbeat-write-run", "heartbeat-write-sandbox", NOW);
      await adapter.heartbeatSandbox("heartbeat-write-run", "heartbeat-write-sandbox", NOW - 1);

      expect((await adapter.getSandbox("heartbeat-write-run", "heartbeat-write-sandbox"))?.heartbeatAtMs).toBe(NOW);
    } finally {
      sqlite.close();
    }
  });

  test("does not treat completed sandboxes as a live heartbeat dependency", async () => {
    const { sqlite, adapter } = createAdapter();
    try {
      await insertRunningRun(adapter, "completed-sandbox-run");
      await adapter.upsertSandbox({
        runId: "completed-sandbox-run",
        sandboxId: "completed-sandbox",
        runtime: "bubblewrap",
        remoteRunId: null,
        workspaceId: null,
        containerId: null,
        configJson: "{}",
        status: "finished",
        heartbeatAtMs: NOW - STALE_THRESHOLD_MS - 1,
        shippedAtMs: NOW - STALE_THRESHOLD_MS - 1,
        completedAtMs: NOW - 1,
        bundlePath: null,
      });

      const view = await computeRunState(adapter, "completed-sandbox-run", {
        now: NOW,
        staleThresholdMs: STALE_THRESHOLD_MS,
      });

      expect(view.state).toBe("running");
      expect(view.unhealthy).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });
});
