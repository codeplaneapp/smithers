import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import type { RunRow } from "@smithers-orchestrator/db/adapter/RunRow";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { deriveRunState } from "@smithers-orchestrator/db/runState/deriveRunState";
import { corruptHeartbeat } from "../harness/corruptHeartbeat.ts";

// case01 - stale heartbeat and exclusive supervisor claim against the REAL DB.
//
// The run row is written through SmithersDb on a createSmithers sqlite database,
// then the heartbeat is corrupted through the sanctioned fault injector. Stale
// discovery, claim CAS, and run-state classification all use product code.

const STALE_THRESHOLD_MS = 30_000;
const WORKFLOW_NAME = "case01-workflow";

const dbPaths: string[] = [];
const dbClients: Database[] = [];

function makeDbPath(): string {
  return join(
    tmpdir(),
    `smithers-case01-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function queryClient(db: unknown): Database {
  const client = (db as { $client?: unknown; session?: { client?: unknown } }).$client
    ?? (db as { session?: { client?: unknown } }).session?.client;
  if (!client || typeof (client as { query?: unknown }).query !== "function") {
    throw new Error("Expected createSmithers to expose a Bun SQLite client");
  }
  return client as Database;
}

function createRealDb(): { adapter: SmithersDb; sqlite: Database } {
  const dbPath = makeDbPath();
  dbPaths.push(dbPath);
  const { db } = createSmithers(
    {
      input: z.object({}),
      result: z.object({ value: z.number() }),
    },
    { dbPath },
  );
  ensureSmithersTables(db);
  const sqlite = queryClient(db);
  dbClients.push(sqlite);
  return { adapter: new SmithersDb(db), sqlite };
}

async function getRun(adapter: SmithersDb, runId: string): Promise<RunRow> {
  const run = await adapter.getRun(runId);
  if (!run) throw new Error(`row missing for ${runId}`);
  return run;
}

async function seedRunningRun(
  adapter: SmithersDb,
  runId: string,
  ownerId: string,
  heartbeatAtMs: number,
  startedAtMs: number = heartbeatAtMs - 5_000,
): Promise<void> {
  await adapter.insertRun({
    runId,
    workflowName: WORKFLOW_NAME,
    status: "running",
    createdAtMs: startedAtMs,
    startedAtMs,
    heartbeatAtMs: null,
    runtimeOwnerId: ownerId,
  });
  await adapter.heartbeatRun(runId, ownerId, heartbeatAtMs);
}

describe("case 01: kill engine mid-task", () => {
  afterEach(() => {
    for (const client of dbClients) {
      try {
        client.close();
      } catch {
        // already closed
      }
    }
    dbClients.length = 0;
    for (const dbPath of dbPaths) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
    dbPaths.length = 0;
  });

  test("killed engine -> orphaned within SLO; supervisor takeover is exclusive", async () => {
    const { adapter, sqlite } = createRealDb();
    const runId = "case01-run";
    const originalOwnerId = "pid:99999:engine-victim";
    const seedHeartbeatAtMs = Date.now() - 1_000;
    const seedStartedAtMs = Date.now() - 10 * STALE_THRESHOLD_MS;

    await seedRunningRun(
      adapter,
      runId,
      originalOwnerId,
      seedHeartbeatAtMs,
      seedStartedAtMs,
    );

    const fresh = deriveRunState({
      run: await getRun(adapter, runId),
      staleThresholdMs: STALE_THRESHOLD_MS,
    });
    expect(fresh.state).toBe("running");

    await corruptHeartbeat(sqlite, runId, "stale");

    const staleRun = await getRun(adapter, runId);
    const stale = deriveRunState({
      run: staleRun,
      staleThresholdMs: STALE_THRESHOLD_MS,
    });
    // The dead engine pid is verified, so a killed engine reads "orphaned"
    // (a live-but-lagging owner reads "stale").
    expect(stale.state).toBe("orphaned");
    expect(stale.unhealthy?.kind).toBe("engine-heartbeat-stale");

    const claimHeartbeatAtMs = Date.now();
    const staleBeforeMs = claimHeartbeatAtMs - STALE_THRESHOLD_MS;
    const staleRows = await adapter.listStaleRunningRuns(staleBeforeMs);
    expect(staleRows).toEqual([
      expect.objectContaining({
        runId,
        runtimeOwnerId: originalOwnerId,
        status: "running",
      }),
    ]);

    const supervisorOwnerId = "supervisor:case01-takeover";
    const firstClaim = await adapter.claimRunForResume({
      runId,
      expectedRuntimeOwnerId: staleRun.runtimeOwnerId,
      expectedHeartbeatAtMs: staleRun.heartbeatAtMs,
      staleBeforeMs,
      claimOwnerId: supervisorOwnerId,
      claimHeartbeatAtMs,
    });
    expect(firstClaim).toBe(true);

    const secondClaim = await adapter.claimRunForResume({
      runId,
      expectedRuntimeOwnerId: staleRun.runtimeOwnerId,
      expectedHeartbeatAtMs: staleRun.heartbeatAtMs,
      staleBeforeMs,
      claimOwnerId: "supervisor:would-be-double-resume",
      claimHeartbeatAtMs,
    });
    expect(secondClaim).toBe(false);

    const afterClaim = await getRun(adapter, runId);
    expect(afterClaim.runtimeOwnerId).toBe(supervisorOwnerId);
    expect(afterClaim.heartbeatAtMs).toBe(claimHeartbeatAtMs);

    const recovered = deriveRunState({
      run: afterClaim,
      staleThresholdMs: STALE_THRESHOLD_MS,
      now: claimHeartbeatAtMs,
    });
    expect(recovered.state).toBe("running");
  });

  test("contract regression guard: missing-heartbeat path with a dead owner flips state to orphaned", async () => {
    const { adapter, sqlite } = createRealDb();
    const runId = "case01-missing-heartbeat";
    const longAgoMs = Date.now() - 10 * STALE_THRESHOLD_MS;

    await seedRunningRun(adapter, runId, "pid:88888:engine-missing", longAgoMs, longAgoMs);

    await corruptHeartbeat(sqlite, runId, "missing");

    const view = deriveRunState({
      run: await getRun(adapter, runId),
      staleThresholdMs: STALE_THRESHOLD_MS,
    });
    expect(view.state).toBe("orphaned");
  });

  test("contract regression guard: orphaned (no owner) is distinct from stale", async () => {
    const { adapter, sqlite } = createRealDb();
    const runId = "case01-orphan";
    const longAgoMs = Date.now() - 10 * STALE_THRESHOLD_MS;

    await adapter.insertRun({
      runId,
      workflowName: WORKFLOW_NAME,
      status: "running",
      createdAtMs: longAgoMs,
      startedAtMs: longAgoMs,
      heartbeatAtMs: longAgoMs,
      runtimeOwnerId: null,
    });

    await corruptHeartbeat(sqlite, runId, "stale");

    const view = deriveRunState({
      run: await getRun(adapter, runId),
      staleThresholdMs: STALE_THRESHOLD_MS,
    });
    expect(view.state).toBe("orphaned");
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
