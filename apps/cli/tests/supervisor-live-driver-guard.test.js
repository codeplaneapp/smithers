// Issue #1056, supervisor half: the automated resume path must refuse a run
// whose driver process is genuinely alive, and the refusal must leave the run
// row and its attempts byte-identical — a supervisor that half-claims a live
// run is exactly the split-brain the ticket is about.
//
// Real SmithersDb, real supervisor poll, real OS processes for the drivers.
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { formatRuntimeOwnerId } from "@smthrs/db/runtime-owner";
import { supervisorPollEffect } from "../src/supervisor.js";

/** @type {Array<import("node:child_process").ChildProcess>} */
const spawned = [];
afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
});

function spawnLiveDriver() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  spawned.push(child);
  return child;
}

async function spawnDeadDriver() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), sqlite };
}

async function seedStaleRun(adapter, runId, ownerPid) {
  const now = Date.now();
  const runtimeOwnerId = formatRuntimeOwnerId(ownerPid, hostname(), "driver-session");
  await adapter.insertRun({
    runId,
    workflowName: "supervised",
    workflowPath: `/tmp/${runId}.tsx`,
    status: "running",
    createdAtMs: now - 300_000,
    startedAtMs: now - 300_000,
    // Stale heartbeat: the ONLY thing that could still say "live" is the pid.
    heartbeatAtMs: now - 300_000,
    runtimeOwnerId,
  });
  await adapter.insertAttempt({
    runId,
    nodeId: "work",
    iteration: 0,
    attempt: 1,
    state: "in-progress",
    startedAtMs: now - 250_000,
  });
  return { runtimeOwnerId, run: await adapter.getRun(runId), attempts: await adapter.listAttempts(runId, "work", 0) };
}

describe("supervisor auto-resume vs a live driver (#1056)", () => {
  test("refuses a stale-heartbeat run whose driver process is genuinely alive, and mutates nothing", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      const driver = spawnLiveDriver();
      const before = await seedStaleRun(adapter, "supervised-live-driver", driver.pid);

      const summary = await Effect.runPromise(
        supervisorPollEffect({
          adapter,
          staleThresholdMs: 30_000,
          deps: {
            workflowExists: () => true,
            spawnResumeDetached: () => {
              throw new Error("supervisor must not spawn a second engine for a live driver");
            },
          },
        }),
      );
      expect(summary.staleCount).toBe(1);
      expect(summary.resumedCount).toBe(0);
      expect(summary.skippedCount).toBe(1);

      const after = await adapter.getRun("supervised-live-driver");
      expect(after?.status).toBe("running");
      expect(after?.runtimeOwnerId).toBe(before.runtimeOwnerId);
      expect(after?.heartbeatAtMs).toBe(before.run?.heartbeatAtMs ?? null);
      expect(await adapter.listAttempts("supervised-live-driver", "work", 0)).toEqual(before.attempts);
    } finally {
      sqlite.close();
    }
  });

  test("still recovers a stale run whose driver process is verifiably gone", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      const deadPid = await spawnDeadDriver();
      await seedStaleRun(adapter, "supervised-dead-driver", deadPid);
      const resumed = [];

      const summary = await Effect.runPromise(
        supervisorPollEffect({
          adapter,
          staleThresholdMs: 30_000,
          deps: {
            workflowExists: () => true,
            spawnResumeDetached: (_target, runId) => {
              resumed.push(runId);
              return 4242;
            },
          },
        }),
      );
      expect(summary.staleCount).toBe(1);
      expect(summary.resumedCount).toBe(1);
      expect(resumed).toEqual(["supervised-dead-driver"]);
    } finally {
      sqlite.close();
    }
  });
});
