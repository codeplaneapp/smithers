import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

// `smithers pause <run>` used to set `process.exitCode = 2` on a SUCCESSFUL park.
// Exit 2 means "cancelled" per the documented exit-code table (0 ok / 1 failure
// / 2 cancelled / 3 durable wait / 4 bad args), so scripts read a healthy pause
// as a failure. A graceful park is a success — it must exit 0. Real failures
// still exit non-zero (RUN_NOT_ACTIVE = 4).

/**
 * @param {ReturnType<typeof createTempRepo>} repo
 */
function openRepoDb(repo) {
  pinSqliteBackend(repo.dir);
  const sqlite = new Database(repo.path("smithers.db"));
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

/** @type {{ close: () => void } | undefined} */
let openSqlite;
afterEach(() => {
  openSqlite?.close();
  openSqlite = undefined;
});

describe("smithers pause exit code", () => {
  test("a successful park exits 0 (not 2/cancelled)", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    openSqlite = sqlite;
    const now = Date.now();
    // A run a live engine is actively driving: status running + fresh
    // heartbeat, which is exactly what the pause command requires.
    await adapter.insertRun({
      runId: "pause-live",
      workflowName: "pause-fixture",
      status: "running",
      createdAtMs: now - 5_000,
      startedAtMs: now - 5_000,
      finishedAtMs: null,
      heartbeatAtMs: now,
    });

    const result = runSmithers(["pause", "pause-live"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: 60_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.json?.runId).toBe("pause-live");
    expect(result.json?.status).toBe("pause-requested");
    // The pause was actually requested in the ledger.
    const run = await adapter.getRun("pause-live");
    expect(run?.pauseRequestedAtMs).not.toBeNull();
  });

  test("an already-paused run is idempotent and exits 0", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    openSqlite = sqlite;
    const now = Date.now();
    await adapter.insertRun({
      runId: "pause-already",
      workflowName: "pause-fixture",
      status: "paused",
      createdAtMs: now - 5_000,
      startedAtMs: now - 5_000,
      finishedAtMs: null,
      heartbeatAtMs: null,
    });

    const result = runSmithers(["pause", "pause-already"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: 60_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.json?.status).toBe("paused");
  });

  test("pausing a non-live run still fails with RUN_NOT_ACTIVE (exit 4)", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    openSqlite = sqlite;
    const now = Date.now();
    // A suspended run (waiting-approval) is already parked — not gracefully
    // pausable — so pause must reject it as bad input, not exit 0/2.
    await adapter.insertRun({
      runId: "pause-parked",
      workflowName: "pause-fixture",
      status: "waiting-approval",
      createdAtMs: now - 5_000,
      startedAtMs: now - 5_000,
      finishedAtMs: null,
      heartbeatAtMs: null,
    });

    const result = runSmithers(["pause", "pause-parked"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: 60_000,
    });

    expect(result.exitCode).toBe(4);
    expect(result.json?.code).toBe("RUN_NOT_ACTIVE");
  });
});
