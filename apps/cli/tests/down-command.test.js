import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const CLI_ENTRY = resolve(import.meta.dir, "../src/index.js");

// Sibling test files set SMITHERS_CLI_DISABLE_AUTO_MAIN=1 on the shared
// process.env and never restore it; bun runs all files in one process, so a
// spawned `logs` CLI would no-op. Strip it for our spawned children.
function logsChildEnv(extra = {}) {
  const env = {
    ...process.env,
    SMITHERS_NO_SKILL_REFRESH: "1",
    SMITHERS_NO_UPDATE_CHECK: "1",
    ...extra,
  };
  delete env.SMITHERS_CLI_DISABLE_AUTO_MAIN;
  return env;
}

const CLI_COMMAND_TIMEOUT_MS = 120_000;
const STALE_LOG_EXIT_TIMEOUT_MS = 5_000;
const FRESH_HEARTBEAT_LEEWAY_MS = 120_000;

const spawnedPids = [];
afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForPidExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid) && Date.now() < deadline) await Bun.sleep(50);
  return !pidAlive(pid);
}

async function spawnOwnerGroup(pidFile) {
  const launcher = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
         const { writeFileSync } = require("node:fs");
         const owner = spawn(process.execPath, ["-e", ${JSON.stringify(`const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const agent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); writeFileSync(process.env.SMITHERS_TEST_PID_FILE, process.pid + ":" + agent.pid); setInterval(() => {}, 1000);`)}], { detached: true, stdio: "ignore", env: process.env });
         owner.unref();`,
    ],
    {
      stdio: "ignore",
      env: { ...process.env, SMITHERS_TEST_PID_FILE: pidFile },
    },
  );
  await new Promise((resolvePromise) => launcher.on("exit", resolvePromise));
  const deadline = Date.now() + 10_000;
  while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(50);
  const [ownerPid, agentPid] = readFileSync(pidFile, "utf8").trim().split(":").map(Number);
  spawnedPids.push(ownerPid, agentPid);
  return { ownerPid, agentPid };
}

function freshHeartbeatMs() {
  return Date.now() + FRESH_HEARTBEAT_LEEWAY_MS;
}

/**
 * @param {ReturnType<typeof createTempRepo>} repo
 */
function openRepoDb(repo) {
  pinSqliteBackend(repo.dir);
  const sqlite = new Database(repo.path("smithers.db"));
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return {
    sqlite,
    adapter: new SmithersDb(db),
  };
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {Record<string, unknown>} [overrides]
 */
async function insertRunningRun(adapter, runId, overrides = {}) {
  const now = Date.now();
  await adapter.insertRun({
    runId,
    workflowName: "down-fixture",
    workflowPath: "workflow.tsx",
    status: "running",
    createdAtMs: now - 10_000,
    startedAtMs: now - 9_000,
    finishedAtMs: null,
    // Default to a fresh heartbeat (isRunHeartbeatFresh => true).
    heartbeatAtMs: now,
    ...overrides,
  });
}

describe("smithers down --force staleness check", () => {
  // Regression: `down` declared a `--force` flag but never read it, so it
  // unconditionally cancelled every active run. A run whose heartbeat is
  // still fresh must be treated as live and skipped unless --force is passed.
  test(
    "without --force, a run with a FRESH heartbeat is skipped (not cancelled)",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        await insertRunningRun(adapter, "fresh-run", { heartbeatAtMs: freshHeartbeatMs() });

        const result = runSmithers(["down"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: CLI_COMMAND_TIMEOUT_MS,
        });

        expect(result.exitCode).toBe(0);
        expect(result.json).toMatchObject({ cancelled: 0, skipped: 1 });
        expect(result.stderr).toContain("Skipped (still live): fresh-run");

        // The fresh run must remain untouched.
        const after = await adapter.getRun("fresh-run");
        expect(after?.status).toBe("running");
      } finally {
        sqlite.close();
      }
    },
    CLI_COMMAND_TIMEOUT_MS,
  );

  test.skipIf(process.platform === "win32")(
    "with --force, a LIVE run's owner group is terminated and the run finalized",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        const { ownerPid, agentPid } = await spawnOwnerGroup(repo.path("owner-group.pid"));
        await insertRunningRun(adapter, "fresh-run", {
          heartbeatAtMs: freshHeartbeatMs(),
          runtimeOwnerId: `pid:${ownerPid}:down-test`,
        });
        expect(pidAlive(ownerPid)).toBe(true);
        expect(pidAlive(agentPid)).toBe(true);

        const result = runSmithers(["down", "--force"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: CLI_COMMAND_TIMEOUT_MS,
        });

        expect(result.exitCode).toBe(0);
        expect(result.json).toMatchObject({ cancelled: 1, skipped: 0 });
        expect(result.stderr).toContain("Cancelled: fresh-run");

        const after = await adapter.getRun("fresh-run");
        expect(after?.cancelRequestedAtMs ?? 0).toBeGreaterThan(0);
        expect(after?.status).toBe("cancelled");
        expect(await waitForPidExit(ownerPid)).toBe(true);
        expect(await waitForPidExit(agentPid)).toBe(true);
      } finally {
        sqlite.close();
      }
    },
    CLI_COMMAND_TIMEOUT_MS,
  );

  test(
    "without --force, a run with a STALE heartbeat is still cancelled",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        // Heartbeat well past the staleness threshold (30s).
        await insertRunningRun(adapter, "stale-run", { heartbeatAtMs: Date.now() - 120_000 });

        const result = runSmithers(["down"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: CLI_COMMAND_TIMEOUT_MS,
        });

        expect(result.exitCode).toBe(0);
        expect(result.json).toMatchObject({ cancelled: 1, skipped: 0 });

        const after = await adapter.getRun("stale-run");
        expect(after?.status).toBe("cancelled");
        expect(after).toMatchObject({
          cancelRequestSource: "cli",
          cancelRequestDetail: "smithers down",
        });
        expect(Number.isSafeInteger(after?.cancelRequestClientPid)).toBe(true);
        expect(after?.cancelRequestClientPid ?? 0).toBeGreaterThan(0);
      } finally {
        sqlite.close();
      }
    },
    CLI_COMMAND_TIMEOUT_MS,
  );

  test(
    "removes a cancelled run's recorded detached log",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        const logFile = repo.write("operator-logs/stale-with-log.log", "detached output\n");
        await insertRunningRun(adapter, "stale-with-log", {
          heartbeatAtMs: Date.now() - 120_000,
          configJson: JSON.stringify({ logFile }),
        });

        const result = runSmithers(["down"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: CLI_COMMAND_TIMEOUT_MS,
        });

        expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect((await adapter.getRun("stale-with-log"))?.status).toBe("cancelled");
        expect(existsSync(logFile)).toBe(false);
      } finally {
        sqlite.close();
      }
    },
    CLI_COMMAND_TIMEOUT_MS,
  );

  test(
    "stale runs with no owner or a dead owner both finalize cleanly",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        await insertRunningRun(adapter, "no-owner", { heartbeatAtMs: Date.now() - 120_000 });
        await insertRunningRun(adapter, "dead-owner", {
          heartbeatAtMs: Date.now() - 120_000,
          runtimeOwnerId: "pid:2147483647:down-test",
        });

        const result = runSmithers(["down"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: CLI_COMMAND_TIMEOUT_MS,
        });

        expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.json).toMatchObject({ cancelled: 2, skipped: 0 });
        expect((await adapter.getRun("no-owner"))?.status).toBe("cancelled");
        expect((await adapter.getRun("dead-owner"))?.status).toBe("cancelled");
      } finally {
        sqlite.close();
      }
    },
    CLI_COMMAND_TIMEOUT_MS,
  );

  test(
    "direct stale cancellation closes approval and human waits",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        const runId = "stale-waits";
        await insertRunningRun(adapter, runId, {
          status: "waiting-approval",
          heartbeatAtMs: null,
        });
        await adapter.insertNode({
          runId,
          nodeId: "gate",
          iteration: 0,
          state: "waiting-approval",
          lastAttempt: null,
          updatedAtMs: Date.now(),
          outputTable: "",
          label: "Gate",
        });
        await adapter.insertOrUpdateApproval({
          runId,
          nodeId: "gate",
          iteration: 0,
          status: "requested",
          requestedAtMs: Date.now(),
          decidedAtMs: null,
          note: null,
          decidedBy: null,
          requestJson: '{"title":"Gate"}',
          decisionJson: null,
          autoApproved: false,
        });
        await adapter.insertHumanRequest({
          requestId: "human:stale-waits:ask:0",
          runId,
          nodeId: "ask",
          iteration: 0,
          kind: "ask",
          status: "pending",
          prompt: "Continue?",
          schemaJson: null,
          optionsJson: null,
          responseJson: null,
          requestedAtMs: Date.now(),
          answeredAtMs: null,
          answeredBy: null,
          timeoutAtMs: null,
        });

        const result = runSmithers(["down"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: CLI_COMMAND_TIMEOUT_MS,
        });

        expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect((await adapter.getRun(runId))?.status).toBe("cancelled");
        expect(await adapter.listPendingApprovals(runId)).toEqual([]);
        expect((await adapter.getApproval(runId, "gate", 0))?.status).toBe("denied");
        expect((await adapter.getNode(runId, "gate", 0))?.state).toBe("cancelled");
        expect((await adapter.getHumanRequest("human:stale-waits:ask:0"))?.status).toBe("cancelled");
        expect((await adapter.listEventHistory(runId, { afterSeq: -1, limit: 50 })).map((row) => row.type)).toContain(
          "RunCancelled",
        );
      } finally {
        sqlite.close();
      }
    },
    CLI_COMMAND_TIMEOUT_MS,
  );

  test(
    "cancels 101 stale running rows in one json invocation",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        const now = Date.now();
        const runIds = Array.from({ length: 101 }, (_, index) => `stale-run-${String(index).padStart(3, "0")}`);
        for (const [index, runId] of runIds.entries()) {
          await insertRunningRun(adapter, runId, {
            createdAtMs: now - index,
            startedAtMs: now - 10_000 - index,
            heartbeatAtMs: now - 120_000 - index,
          });
        }

        const result = runSmithers(["down"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: CLI_COMMAND_TIMEOUT_MS,
        });

        expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.json?.cancelled).toBe(101);
        expect(result.json?.skipped).toBe(0);
        expect(await adapter.listRuns(200, "running")).toEqual([]);
        const rows = await Promise.all(runIds.map((runId) => adapter.getRun(runId)));
        expect(rows.every((row) => row?.status === "cancelled")).toBe(true);
      } finally {
        sqlite.close();
      }
    },
    CLI_COMMAND_TIMEOUT_MS,
  );
});

describe("smithers cancel live-run handling", () => {
  // Regression: `cancel` only bare-flipped status to "cancelled" and never set
  // cancel_requested_at_ms, so a live engine in another process never observed
  // the cancellation and overwrote status with "finished" on completion — the
  // agents kept running. A live run must be cancelled via the durable flag.
  test(
    "a LIVE run is cancelled via the durable cancel request, not a bare flip",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        await insertRunningRun(adapter, "live-run", { heartbeatAtMs: freshHeartbeatMs() });

        const result = runSmithers(["cancel", "live-run"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: CLI_COMMAND_TIMEOUT_MS,
        });

        expect(result.json).toMatchObject({ runId: "live-run", status: "cancel-requested" });

        const after = await adapter.getRun("live-run");
        expect(after?.cancelRequestedAtMs ?? 0).toBeGreaterThan(0);
        // Status is left for the engine to settle, NOT prematurely flipped.
        expect(after?.status).toBe("running");
        expect(after).toMatchObject({
          cancelRequestSource: "cli",
          cancelRequestDetail: "smithers cancel live-run",
        });
        expect(Number.isSafeInteger(after?.cancelRequestClientPid)).toBe(true);
        expect(after?.cancelRequestClientPid ?? 0).toBeGreaterThan(0);
      } finally {
        sqlite.close();
      }
    },
    CLI_COMMAND_TIMEOUT_MS,
  );

  test(
    "a STALE (dead-engine) run is directly flipped to cancelled",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        // Heartbeat well past the 30s staleness threshold: no live engine to
        // honor a cancel request, so the bare status flip is correct here.
        await insertRunningRun(adapter, "stale-run", { heartbeatAtMs: Date.now() - 120_000 });

        const result = runSmithers(["cancel", "stale-run"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: CLI_COMMAND_TIMEOUT_MS,
        });

        expect(result.json).toMatchObject({ runId: "stale-run", status: "cancelled" });

        const after = await adapter.getRun("stale-run");
        expect(after?.status).toBe("cancelled");
        expect(after).toMatchObject({
          cancelRequestSource: "cli",
          cancelRequestDetail: "smithers cancel stale-run",
        });
        expect(Number.isSafeInteger(after?.cancelRequestClientPid)).toBe(true);
        expect(after?.cancelRequestClientPid ?? 0).toBeGreaterThan(0);
        const cancelledEvent = (await adapter.listEventHistory("stale-run", { afterSeq: -1, limit: 50 })).find(
          (event) => event.type === "RunCancelled",
        );
        expect(cancelledEvent).toBeTruthy();
        expect(JSON.parse(cancelledEvent.payloadJson).source).toEqual({
          kind: "cli",
          detail: "smithers cancel stale-run",
          clientPid: after?.cancelRequestClientPid,
        });
      } finally {
        sqlite.close();
      }
    },
    CLI_COMMAND_TIMEOUT_MS,
  );
});

describe("smithers logs --follow waiting-state CTA", () => {
  test(
    "default follow exits for a persisted running row whose heartbeat is already stale",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        const now = Date.now();
        await insertRunningRun(adapter, "stale-run", {
          startedAtMs: now - 120_000,
          heartbeatAtMs: now - 120_000,
          runtimeOwnerId: "dead-engine",
        });
        await adapter.insertEventWithNextSeq({
          runId: "stale-run",
          type: "STALE_LOG_MARKER",
          timestampMs: now - 1_000,
          payloadJson: JSON.stringify({ marker: "stale-log-marker" }),
        });

        const proc = Bun.spawn([process.execPath, "run", CLI_ENTRY, "logs", "stale-run"], {
          cwd: repo.dir,
          stdout: "pipe",
          stderr: "pipe",
          // logs now follows only on a TTY; force the follow default in this
          // non-TTY harness so the stale-during-follow branch under test is
          // actually exercised.
          env: logsChildEnv({ SMITHERS_LOGS_ASSUME_TTY: "1" }),
        });
        const stdoutPromise = new Response(proc.stdout).text();
        const stderrPromise = new Response(proc.stderr).text();
        const timeout = new Promise((resolve) => {
          setTimeout(() => resolve(null), STALE_LOG_EXIT_TIMEOUT_MS);
        });
        const exitCode = await Promise.race([proc.exited, timeout]);
        if (exitCode === null) {
          proc.kill("SIGTERM");
          await proc.exited.catch(() => undefined);
        }
        const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

        expect(exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
        expect(stdout.match(/STALE_LOG_MARKER/g) ?? []).toHaveLength(1);
        expect(stdout.match(/stale-log-marker/g) ?? []).toHaveLength(1);
        expect(stderr).toContain("Run stale-run is stale");
        expect(stderr).toContain("stopping log follow");
      } finally {
        sqlite.close();
      }
    },
    CLI_COMMAND_TIMEOUT_MS,
  );

  // Regression: the waiting-approval/event/timer CTA branches keyed off
  // `currentStatus`, but the follow loop only exits once the run is NOT in a
  // waiting state, so currentStatus could never be a waiting status inside the
  // exit block — the hints were dead code. The fix tracks the last waiting
  // status observed and bases the CTA hints on that.
  test(
    "a run ending in waiting-approval emits the approve CTA hint",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        const now = Date.now();
        await adapter.insertRun({
          runId: "wa-run",
          workflowName: "down-fixture",
          workflowPath: "workflow.tsx",
          status: "waiting-approval",
          createdAtMs: now - 10_000,
          startedAtMs: now - 9_000,
          finishedAtMs: null,
          heartbeatAtMs: now,
        });
        // Seed an event so the follow loop emits a recognizable line once it
        // has started — our deterministic signal that the loop is running.
        await adapter.insertEventWithNextSeq({
          runId: "wa-run",
          type: "STARTUP_MARKER",
          timestampMs: now,
          payloadJson: JSON.stringify({ marker: true }),
        });

        const proc = Bun.spawn([process.execPath, "run", CLI_ENTRY, "logs", "wa-run", "--follow"], {
          cwd: repo.dir,
          stdout: "pipe",
          stderr: "pipe",
          env: logsChildEnv(),
        });

        // Read stdout incrementally. Only once the marker line appears (the
        // loop is confirmed running while the run is waiting-approval) do we
        // transition the run to a terminal state, so the loop exits through
        // the waiting-state CTA branch deterministically.
        const decoder = new TextDecoder();
        let stdout = "";
        const reader = proc.stdout.getReader();
        const deadline = Date.now() + CLI_COMMAND_TIMEOUT_MS;
        let transitioned = false;
        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          stdout += decoder.decode(value, { stream: true });
          if (!transitioned && stdout.includes("STARTUP_MARKER")) {
            transitioned = true;
            await adapter.updateRun("wa-run", {
              status: "cancelled",
              finishedAtMs: Date.now(),
            });
          }
        }
        await proc.exited;

        expect(transitioned).toBe(true);
        expect(proc.exitCode).toBe(0);
        // The fixed CTA must surface the approve hint for the prior waiting state.
        expect(stdout).toContain("approve wa-run");
        expect(stdout).toContain("inspect wa-run");
      } finally {
        sqlite.close();
      }
    },
    CLI_COMMAND_TIMEOUT_MS,
  );
});
