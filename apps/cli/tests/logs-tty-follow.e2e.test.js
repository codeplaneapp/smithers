import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

// `logs <run>` used to follow live runs even without -f, hanging pipes/scripts
// (stdout is not a TTY there). The fix makes follow TTY-conditional: a piped /
// redirected `logs` snapshots and exits; -f/--follow forces follow; --no-follow
// forces snapshot. runSmithers spawns the CLI with piped (non-TTY) stdout, so
// the default here would always snapshot-and-exit — which makes a --no-follow
// test vacuous unless the default is first forced to follow. The
// SMITHERS_LOGS_ASSUME_TTY=1 seam forces that would-follow default in this
// non-interactive harness, so --no-follow's override is genuinely exercised.

const BUN_BINARY = process.execPath;
const CLI_ENTRY = resolve(import.meta.dir, "../src/index.js");
const QUIET_ENV = {
  SMITHERS_NO_SKILL_REFRESH: "1",
  SMITHERS_NO_UPDATE_CHECK: "1",
};

/**
 * Child env for a spawned `logs` CLI. A spawned child MUST run the CLI main, but
 * several sibling test files in the same bun process set
 * SMITHERS_CLI_DISABLE_AUTO_MAIN=1 on the shared process.env and never restore
 * it — and bun runs files in one process. Inheriting it makes the child no-op
 * and exit 0 without ever running the CLI, silently defeating a follow/snapshot
 * assertion (and making the --no-follow test vacuously "pass" on a no-op exit).
 * Strip it so this file's spawn tests are robust to file ordering.
 * @param {Record<string, string>} [extra]
 */
function childEnv(extra = {}) {
  const env = { ...process.env, ...QUIET_ENV, ...extra };
  delete env.SMITHERS_CLI_DISABLE_AUTO_MAIN;
  return env;
}

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

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} status
 * @param {number | null} heartbeatAtMs
 */
async function insertRun(adapter, runId, status, heartbeatAtMs) {
  const now = Date.now();
  await adapter.insertRun({
    runId,
    workflowName: "logs-fixture",
    status,
    createdAtMs: now - 5_000,
    startedAtMs: now - 5_000,
    finishedAtMs: status === "finished" ? now - 1_000 : null,
    heartbeatAtMs,
    // A live, verifiably-owned run so computeRunStateFromRow classifies it as
    // active ("running") rather than stale/orphaned.
    runtimeOwnerId: status === "running" ? `pid:${process.pid}:test-driver` : null,
  });
}

/** @type {{ close: () => void } | undefined} */
let openSqlite;
/** @type {import("node:child_process").ChildProcess | undefined} */
let liveChild;
afterEach(() => {
  if (liveChild && liveChild.exitCode === null && !liveChild.killed) {
    liveChild.kill("SIGKILL");
  }
  liveChild = undefined;
  openSqlite?.close();
  openSqlite = undefined;
});

describe("logs TTY-conditional follow", () => {
  test("a finished run always snapshots and exits (0)", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    openSqlite = sqlite;
    await insertRun(adapter, "logs-finished", "finished", null);

    const result = runSmithers(["logs", "logs-finished"], {
      cwd: repo.dir,
      timeoutMs: 20_000,
    });
    expect(result.exitCode).toBe(0);
  });

  test("a LIVE run piped (non-TTY) snapshots and exits instead of hanging", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    openSqlite = sqlite;
    // A genuinely live run: without the fix, `logs` would follow this
    // forever over a pipe and this test would time out (exit 143).
    await insertRun(adapter, "logs-live", "running", Date.now());

    const result = runSmithers(["logs", "logs-live"], {
      cwd: repo.dir,
      timeoutMs: 20_000,
    });
    expect(result.exitCode).toBe(0);
  });

  test("SMITHERS_LOGS_ASSUME_TTY makes the default follow a live run (seam is not a no-op)", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    openSqlite = sqlite;
    // Forced TTY-default + neither -f nor --no-follow: the follow branch must
    // engage, so this stays alive tailing the live run instead of
    // snapshotting. This proves the seam genuinely flips the default to
    // follow — the premise that makes the --no-follow assertion below
    // non-vacuous (a piped default already snapshots regardless).
    await insertRun(adapter, "logs-assume-tty", "running", Date.now());

    liveChild = spawn(BUN_BINARY, ["run", CLI_ENTRY, "logs", "logs-assume-tty"], {
      cwd: repo.dir,
      env: childEnv({ SMITHERS_LOGS_ASSUME_TTY: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise((resolveExit) => {
      liveChild.once("close", (code) => resolveExit(code ?? 1));
    });

    // With the forced default it must be actively following (not exited).
    await new Promise((r) => setTimeout(r, 2_000));
    expect(liveChild.exitCode).toBeNull();

    // Drive the run terminal; the follow loop notices and exits cleanly.
    await adapter.updateRun("logs-assume-tty", { status: "finished", finishedAtMs: Date.now() });
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 15_000))]);
    expect(code).toBe(0);
  }, 30_000);

  test("--no-follow forces a snapshot even when the default WOULD follow", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    openSqlite = sqlite;
    await insertRun(adapter, "logs-live-nofollow", "running", Date.now());

    // SMITHERS_LOGS_ASSUME_TTY=1 forces the default-follow path (proven live
    // by the control test above), so a bare `logs` on this live run would
    // hang. --no-follow must override that and snapshot-and-exit. A direct
    // spawn (not runSmithers) with a scrubbed env is used so the child truly
    // runs the CLI: if --no-follow is honored it exits 0 promptly; if not, it
    // follows the live run forever and the race below resolves "timeout".
    // exit 0 here is load-bearing — it can no longer pass on a non-TTY pipe
    // default or a no-op'd CLI.
    liveChild = spawn(BUN_BINARY, ["run", CLI_ENTRY, "logs", "logs-live-nofollow", "--no-follow"], {
      cwd: repo.dir,
      env: childEnv({ SMITHERS_LOGS_ASSUME_TTY: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise((resolveExit) => {
      liveChild.once("close", (code) => resolveExit(code ?? 1));
    });
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 15_000))]);
    expect(code).toBe(0);
  }, 30_000);

  test("-f forces follow on a live run; it exits only once the run goes terminal", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    openSqlite = sqlite;
    // A fresh-heartbeat live run: computeRunStateFromRow classifies it active,
    // so with -f the follow loop keeps tailing instead of snapshotting.
    await insertRun(adapter, "logs-follow", "running", Date.now());

    liveChild = spawn(BUN_BINARY, ["run", CLI_ENTRY, "logs", "logs-follow", "-f"], {
      cwd: repo.dir,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise((resolveExit) => {
      liveChild.once("close", (code) => resolveExit(code ?? 1));
    });

    // With -f it must be actively following (not exited) while the run is live.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(liveChild.exitCode).toBeNull();

    // Drive the run terminal; the follow loop notices and exits cleanly.
    await adapter.updateRun("logs-follow", { status: "finished", finishedAtMs: Date.now() });
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 15_000))]);
    expect(code).toBe(0);
  }, 30_000);
});
