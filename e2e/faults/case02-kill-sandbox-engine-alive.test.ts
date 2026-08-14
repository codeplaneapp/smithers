import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { computeRunState } from "@smthrs/db/runState/computeRunState";
import { deriveRunState } from "@smthrs/db/runState/deriveRunState";
import { RUN_STATE_HEARTBEAT_STALE_MS } from "@smthrs/db/runState/RUN_STATE_HEARTBEAT_STALE_MS";
import type { SandboxHandle } from "@smthrs/sandbox/SandboxHandle";
import { stallSandbox } from "../harness/stallSandbox.ts";
import { corruptHeartbeat } from "../harness/corruptHeartbeat.ts";

const ENGINE_OWNER_ID = "pid:11111:engine-alive";

function createDb(): { adapter: SmithersDb; sqlite: Database } {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  const adapter = new SmithersDb(db);
  return { adapter, sqlite };
}

async function seedRunningRun(
  adapter: SmithersDb,
  runId: string,
  heartbeatAtMs: number,
): Promise<void> {
  await adapter.insertRun({
    runId,
    workflowName: "case02-fault",
    status: "running",
    createdAtMs: heartbeatAtMs - 60_000,
    startedAtMs: heartbeatAtMs - 60_000,
    heartbeatAtMs,
    runtimeOwnerId: ENGINE_OWNER_ID,
  });
}

async function readRunRow(adapter: SmithersDb, runId: string) {
  const run = await adapter.getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  return run;
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
    const { adapter, sqlite } = createDb();
    const { handle, cleanup: sbxCleanup } = createSandbox(runId);
    try {
      const now = Date.now();
      await seedRunningRun(adapter, runId, now);

      const stall = await stallSandbox(handle, 5_000);
      try {
        expect(existsSync(handle.requestPath)).toBe(false);
        expect(existsSync(`${handle.requestPath}.stalled`)).toBe(true);

        const view = deriveRunState({ run: await readRunRow(adapter, runId), now });
        expect(view.state).toBe("running");
        expect(view.unhealthy).toBeUndefined();
      } finally {
        await stall.release();
      }
    } finally {
      sbxCleanup();
      sqlite.close();
    }
  });

  test("heartbeat past stale threshold with live owner → run classified stale + unhealthy", async () => {
    const runId = "case02-stale";
    const { adapter, sqlite } = createDb();
    try {
      const now = Date.now();
      await seedRunningRun(adapter, runId, now);
      // "stale" requires a demonstrably LIVE owner (a dead pid reads
      // "orphaned"); use this test process as the live engine owner.
      await adapter.updateRun(runId, { runtimeOwnerId: `pid:${process.pid}:engine-alive` });

      await corruptHeartbeat(sqlite, runId, "stale");

      const view = deriveRunState({ run: await readRunRow(adapter, runId) });
      expect(view.runId).toBe(runId);
      expect(view.state).toBe("stale");
      expect(view.unhealthy).toBeDefined();
      expect(view.unhealthy?.kind).toBe("engine-heartbeat-stale");
    } finally {
      sqlite.close();
    }
  });

  test("heartbeat past orphan threshold with no owner → orphaned (recovery state-machine entry per ticket 0018)", async () => {
    const runId = "case02-orphaned";
    const { adapter, sqlite } = createDb();
    try {
      const now = Date.now();
      await seedRunningRun(adapter, runId, now);
      await corruptHeartbeat(sqlite, runId, "stale");
      await adapter.updateRun(runId, { runtimeOwnerId: null });

      const view = deriveRunState({ run: await readRunRow(adapter, runId) });
      expect(view.state).toBe("orphaned");
      expect(view.unhealthy?.kind).toBe("engine-heartbeat-stale");
    } finally {
      sqlite.close();
    }
  });

  test("just-inside the SLO window, run remains running (red on regression of threshold)", async () => {
    const runId = "case02-edge";
    const { adapter, sqlite } = createDb();
    try {
      const now = Date.now();
      const heartbeat = now - (RUN_STATE_HEARTBEAT_STALE_MS - 1_000);
      await seedRunningRun(adapter, runId, heartbeat);

      const view = deriveRunState({ run: await readRunRow(adapter, runId), now });
      expect(view.state).toBe("running");
      expect(view.unhealthy).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  test("fresh engine heartbeat + stale sandbox heartbeat → sandbox-specific unhealthy reason", async () => {
    const runId = "case02-fresh-engine-stale-sandbox";
    const { adapter, sqlite } = createDb();
    try {
      const now = Date.now();
      await seedRunningRun(adapter, runId, now);
      await adapter.updateRun(runId, { runtimeOwnerId: `pid:${process.pid}:engine-alive` });
      await adapter.upsertSandbox({
        runId,
        sandboxId: "stale-sandbox",
        runtime: "bubblewrap",
        remoteRunId: null,
        workspaceId: null,
        containerId: null,
        configJson: "{}",
        status: "shipped",
        heartbeatAtMs: now - RUN_STATE_HEARTBEAT_STALE_MS - 1,
        shippedAtMs: now - RUN_STATE_HEARTBEAT_STALE_MS - 1,
        completedAtMs: null,
        bundlePath: null,
      });

      const view = await computeRunState(adapter, runId, { now });
      expect(view.state).toBe("running");
      expect(view.unhealthy).toEqual({ kind: "sandbox-unreachable" });
      expect(view.unhealthy?.kind).not.toBe("engine-heartbeat-stale");
    } finally {
      sqlite.close();
    }
  });
});
