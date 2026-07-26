import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
// Relative imports so the WORKTREE units under test are exercised (a package
// barrel would resolve to whatever install node_modules points at).
import { SmithersDb } from "../../../packages/db/src/adapter.js";
import { ensureSmithersTables } from "../../../packages/db/src/ensure.js";
import { smithersBranches } from "../../../packages/time-travel/src/schema.js";
import { cascadeCancelRun, isCancellableRunStatus, terminateRunOwner } from "../src/cancel-cascade.js";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const CLI_COMMAND_TIMEOUT_MS = 120_000;
const FRESH_HEARTBEAT_LEEWAY_MS = 120_000;
const STALE_HEARTBEAT_MS = 120_000;

/** Pids spawned by a test; reaped afterEach so a failure cannot leak them. */
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
  while (pidAlive(pid) && Date.now() < deadline) {
    await Bun.sleep(50);
  }
  return !pidAlive(pid);
}

/**
 * Spawn a real ORPHANED detached keep-alive process (its own process group
 * leader, reparented to init) — the same shape as a detached `smithers up -d`
 * owner whose launcher has long exited. The double-fork matters: a direct
 * child of this test would stay a zombie while the test blocks in spawnSync
 * on the CLI, so the CLI could never observe its death.
 *
 * @param {string} pidFile
 * @returns {Promise<number>}
 */
async function spawnOrphanKeepAlive(pidFile) {
  const launcher = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
         const { writeFileSync } = require("node:fs");
         const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
         child.unref();
         writeFileSync(process.env.SMITHERS_TEST_PID_FILE, String(child.pid));
         process.exit(0);`,
    ],
    {
      stdio: "ignore",
      env: { ...process.env, SMITHERS_TEST_PID_FILE: pidFile },
    },
  );
  await new Promise((resolvePromise) => launcher.on("exit", resolvePromise));
  const deadline = Date.now() + 10_000;
  while (!existsSync(pidFile) && Date.now() < deadline) {
    await Bun.sleep(50);
  }
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  spawnedPids.push(pid);
  return pid;
}

function createMemoryDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
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

async function insertRun(adapter, runId, overrides = {}) {
  const now = Date.now();
  await adapter.insertRun({
    runId,
    workflowName: "cascade-fixture",
    workflowPath: "workflow.tsx",
    status: "running",
    createdAtMs: now - 10_000,
    startedAtMs: now - 9_000,
    finishedAtMs: null,
    heartbeatAtMs: now - STALE_HEARTBEAT_MS,
    ...overrides,
  });
}

const fresh = () => Date.now() + FRESH_HEARTBEAT_LEEWAY_MS;
const stale = () => Date.now() - STALE_HEARTBEAT_MS;

/**
 * Mirrors the branches DDL that ensureSmithersTables already runs
 * (packages/db/src/sql-message-storage.js CREATE_TABLE_STATEMENTS), so these
 * helpers are idempotent no-ops on a normal test DB. It is re-stated here only
 * so the "no _smithers_branches table" case can DROP the table and then restore
 * it, which is the one scenario ensureSmithersTables cannot produce.
 */
const CREATE_BRANCHES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS _smithers_branches (
    run_id TEXT PRIMARY KEY,
    parent_run_id TEXT NOT NULL,
    parent_frame_no INTEGER NOT NULL,
    branch_label TEXT,
    fork_description TEXT,
    created_at_ms INTEGER NOT NULL
  )`;

/**
 * Mark `runId` as a time-travel FORK of `parentRunId` — the same branch row
 * forkRunEffect writes (the fork's _smithers_runs row still carries
 * parentRunId, which is exactly the overload the cascade must see through).
 *
 * @param {Database} sqlite
 * @param {SmithersDb} adapter
 */
async function insertForkBranch(sqlite, adapter, runId, parentRunId) {
  sqlite.run(CREATE_BRANCHES_TABLE_SQL);
  await adapter.db.insert(smithersBranches).values({
    runId,
    parentRunId,
    parentFrameNo: 1,
    branchLabel: null,
    forkDescription: "test fork",
    createdAtMs: Date.now(),
  });
}

/**
 * Mark `runId` as a continue-as-new CONTINUATION of `parentRunId` — the branch
 * row the engine writes on handoff (packages/engine/src/engine.js, branchLabel
 * "continue-as-new"). It reuses the fork table, but a continuation is the SAME
 * logical run in a fresh segment, so the cascade must still cancel it.
 *
 * @param {Database} sqlite
 * @param {SmithersDb} adapter
 */
async function insertContinuationBranch(sqlite, adapter, runId, parentRunId) {
  sqlite.run(CREATE_BRANCHES_TABLE_SQL);
  await adapter.db.insert(smithersBranches).values({
    runId,
    parentRunId,
    parentFrameNo: 1,
    branchLabel: "continue-as-new",
    forkDescription: "continue-as-new:test",
    createdAtMs: Date.now(),
  });
}

describe("cascadeCancelRun (real sqlite store)", () => {
  test("treats waiting-quota as cancellable and closes its parked node and attempt", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      expect(isCancellableRunStatus("waiting-quota")).toBe(true);
      await insertRun(adapter, "quota-park", {
        status: "waiting-quota",
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        errorJson: JSON.stringify({ resetAtMs: Date.now() + 60_000 }),
      });
      await adapter.insertNode({
        runId: "quota-park",
        nodeId: "agent",
        iteration: 0,
        state: "waiting-quota",
        lastAttempt: 1,
        updatedAtMs: Date.now(),
        outputTable: "",
        label: "Agent",
      });
      await adapter.insertAttempt({
        runId: "quota-park",
        nodeId: "agent",
        iteration: 0,
        attempt: 1,
        state: "waiting-quota",
        startedAtMs: Date.now() - 5_000,
      });

      const summary = await cascadeCancelRun(adapter, "quota-park");

      expect(summary.root).toMatchObject({ runId: "quota-park", action: "cancelled" });
      expect(summary.cancelledAttempts).toBe(1);
      expect((await adapter.getRun("quota-park")).status).toBe("cancelled");
      expect((await adapter.getNode("quota-park", "agent", 0)).state).toBe("cancelled");
      expect((await adapter.getAttempt("quota-park", "agent", 0, 1)).state).toBe("cancelled");
    } finally {
      sqlite.close();
    }
  });

  test("cancels nested descendants: stale root, waiting child, stale grandchild with an in-flight attempt", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await insertRun(adapter, "root", { heartbeatAtMs: stale() });
      await insertRun(adapter, "child-wait", { parentRunId: "root", status: "waiting-approval", heartbeatAtMs: null });
      await insertRun(adapter, "child-paused", { parentRunId: "root", status: "paused", heartbeatAtMs: null });
      await insertRun(adapter, "grand", { parentRunId: "child-wait", heartbeatAtMs: stale() });
      await adapter.insertAttempt({
        runId: "grand",
        nodeId: "task-1",
        iteration: 0,
        attempt: 1,
        state: "in-progress",
        startedAtMs: Date.now() - 5_000,
      });
      // Unrelated tree stays untouched.
      await insertRun(adapter, "bystander", { heartbeatAtMs: fresh() });

      const summary = await cascadeCancelRun(adapter, "root");

      expect(summary.root).toMatchObject({ runId: "root", action: "cancelled" });
      const byId = Object.fromEntries(summary.descendants.map((d) => [d.runId, d.action]));
      expect(byId).toEqual({
        "child-wait": "cancelled",
        "child-paused": "cancelled",
        grand: "cancelled",
      });
      expect(summary.cancelledAttempts).toBe(1);
      for (const runId of ["root", "child-wait", "child-paused", "grand"]) {
        expect((await adapter.getRun(runId)).status).toBe("cancelled");
      }
      expect((await adapter.getAttempt("grand", "task-1", 0, 1)).state).toBe("cancelled");
      expect((await adapter.getRun("bystander")).status).toBe("running");
    } finally {
      sqlite.close();
    }
  });

  test("a LIVE descendant gets the durable cancel request, never a bare status flip", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await insertRun(adapter, "root", { heartbeatAtMs: stale() });
      await insertRun(adapter, "live-child", { parentRunId: "root", heartbeatAtMs: fresh() });

      const summary = await cascadeCancelRun(adapter, "root");

      expect(summary.descendants).toEqual([
        expect.objectContaining({ runId: "live-child", action: "cancel-requested" }),
      ]);
      const child = await adapter.getRun("live-child");
      expect(child.status).toBe("running");
      expect(child.cancelRequestedAtMs ?? 0).toBeGreaterThan(0);
    } finally {
      sqlite.close();
    }
  });

  test("is idempotent: a second cascade skips every already-terminal run and changes nothing", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await insertRun(adapter, "root", { heartbeatAtMs: stale() });
      await insertRun(adapter, "child", { parentRunId: "root", status: "waiting-event", heartbeatAtMs: null });

      await cascadeCancelRun(adapter, "root");
      const afterFirst = {
        root: await adapter.getRun("root"),
        child: await adapter.getRun("child"),
      };
      expect(afterFirst.root.status).toBe("cancelled");
      expect(afterFirst.child.status).toBe("cancelled");

      const second = await cascadeCancelRun(adapter, "root");
      expect(second.root).toMatchObject({ runId: "root", action: "already-terminal" });
      expect(second.descendants).toEqual([expect.objectContaining({ runId: "child", action: "already-terminal" })]);
      expect(second.cancelledAttempts).toBe(0);
      // Terminal rows are untouched — same finishedAtMs, no double flip.
      expect((await adapter.getRun("root")).finishedAtMs).toBe(afterFirst.root.finishedAtMs);
      expect((await adapter.getRun("child")).finishedAtMs).toBe(afterFirst.child.finishedAtMs);
    } finally {
      sqlite.close();
    }
  });

  test("the real stale-run cancellation entry point finalizes approval and human waits", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await insertRun(adapter, "stale-waits", { heartbeatAtMs: stale(), status: "waiting-approval" });
      await adapter.insertNode({
        runId: "stale-waits",
        nodeId: "gate",
        iteration: 0,
        state: "waiting-approval",
        lastAttempt: null,
        updatedAtMs: Date.now(),
        outputTable: "",
        label: "Gate",
      });
      await adapter.insertNode({
        runId: "stale-waits",
        nodeId: "orphan-gate",
        iteration: 0,
        state: "waiting-approval",
        lastAttempt: null,
        updatedAtMs: Date.now(),
        outputTable: "",
        label: "Orphan gate",
      });
      await adapter.insertOrUpdateApproval({
        runId: "stale-waits",
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
        runId: "stale-waits",
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
      await cascadeCancelRun(adapter, "stale-waits");
      expect((await adapter.getRun("stale-waits")).status).toBe("cancelled");
      expect(await adapter.listPendingApprovals("stale-waits")).toEqual([]);
      expect((await adapter.getApproval("stale-waits", "gate", 0)).status).toBe("denied");
      expect((await adapter.getNode("stale-waits", "gate", 0)).state).toBe("cancelled");
      expect((await adapter.getNode("stale-waits", "orphan-gate", 0)).state).toBe("cancelled");
      expect((await adapter.getHumanRequest("human:stale-waits:ask:0")).status).toBe("cancelled");
      expect(
        (await adapter.listEventHistory("stale-waits", { afterSeq: -1, limit: 50 })).map((row) => row.type),
      ).toContain("RunCancelled");
    } finally {
      sqlite.close();
    }
  });

  test("race: a descendant that finishes between discovery and action is skipped, not clobbered", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await insertRun(adapter, "root", { heartbeatAtMs: stale() });
      await insertRun(adapter, "race-child", { parentRunId: "root", status: "waiting-approval", heartbeatAtMs: null });

      // Failure injection on the REAL adapter: the first time the cascade
      // re-reads race-child, a "concurrent engine" finishes it first —
      // exactly the discovery→action window the re-read exists to close.
      let injected = false;
      const finishedAt = Date.now();
      const racy = new Proxy(adapter, {
        get(target, prop, receiver) {
          if (prop === "getRun") {
            return async (runId) => {
              if (runId === "race-child" && !injected) {
                injected = true;
                await target.updateRun("race-child", { status: "finished", finishedAtMs: finishedAt });
              }
              return target.getRun(runId);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const summary = await cascadeCancelRun(racy, "root");
      expect(summary.descendants).toEqual([
        expect.objectContaining({ runId: "race-child", action: "already-terminal" }),
      ]);
      const child = await adapter.getRun("race-child");
      expect(child.status).toBe("finished");
      expect(child.finishedAtMs).toBe(finishedAt);
    } finally {
      sqlite.close();
    }
  });

  test("race: a child spawned WHILE the cascade runs is discovered on the next pass and cancelled", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await insertRun(adapter, "root", { heartbeatAtMs: stale() });

      // While the root is being flipped, a launcher inserts a new child —
      // the re-discovery pass must catch it.
      let spawned = false;
      const racy = new Proxy(adapter, {
        get(target, prop, receiver) {
          if (prop === "listInProgressAttempts") {
            return async (runId) => {
              if (runId === "root" && !spawned) {
                spawned = true;
                await insertRun(target, "late-child", { parentRunId: "root", heartbeatAtMs: stale() });
              }
              return target.listInProgressAttempts(runId);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const summary = await cascadeCancelRun(racy, "root");
      expect(summary.descendants).toEqual([expect.objectContaining({ runId: "late-child", action: "cancelled" })]);
      expect((await adapter.getRun("late-child")).status).toBe("cancelled");
    } finally {
      sqlite.close();
    }
  });

  test("a continue-as-new CONTINUATION is still cancelled — it reuses the branches table but is the same logical run, not an independent branch", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await insertRun(adapter, "root", { heartbeatAtMs: stale() });
      // continue-as-new handoff: a branch row EXISTS (engine writes one),
      // but labelled "continue-as-new". Sparing it like a fork would leave
      // the live continuation running after `smithers cancel <root>` —
      // i.e. cancel would silently fail to stop the run.
      await insertRun(adapter, "cont", { parentRunId: "root", heartbeatAtMs: stale() });
      await insertContinuationBranch(sqlite, adapter, "cont", "root");
      // Work spawned by the continuation dies with it.
      await insertRun(adapter, "cont-child", { parentRunId: "cont", heartbeatAtMs: stale() });
      // A genuine fork of the SAME root still survives, proving the
      // discriminator is the branch LABEL, not merely the row's presence.
      await insertRun(adapter, "fork", { parentRunId: "root", heartbeatAtMs: stale() });
      await insertForkBranch(sqlite, adapter, "fork", "root");

      const summary = await cascadeCancelRun(adapter, "root");

      const byId = Object.fromEntries(summary.descendants.map((d) => [d.runId, d.action]));
      expect(byId).toEqual({ cont: "cancelled", "cont-child": "cancelled" });
      for (const runId of ["root", "cont", "cont-child"]) {
        expect((await adapter.getRun(runId)).status).toBe("cancelled");
      }
      const fork = await adapter.getRun("fork");
      expect(fork.status).toBe("running");
      expect(fork.cancelRequestedAtMs ?? null).toBeNull();
    } finally {
      sqlite.close();
    }
  });
  test("a time-travel FORK of the root survives the cascade — and so does everything beneath it — while child workflows still die", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await insertRun(adapter, "root", { heartbeatAtMs: stale() });
      // Lifecycle children: cancelled with the root, transitively.
      await insertRun(adapter, "child-wf", { parentRunId: "root", status: "waiting-approval", heartbeatAtMs: null });
      await insertRun(adapter, "grand-wf", { parentRunId: "child-wf", heartbeatAtMs: stale() });
      // A fork: parent_run_id also points at root, but a branch row marks
      // it an independent branch of history. Its own child has NO branch
      // row — the prune must cover the whole subtree, not just the fork.
      await insertRun(adapter, "fork", { parentRunId: "root", heartbeatAtMs: stale() });
      await insertForkBranch(sqlite, adapter, "fork", "root");
      await insertRun(adapter, "fork-child", { parentRunId: "fork", heartbeatAtMs: stale() });

      const summary = await cascadeCancelRun(adapter, "root");

      expect(summary.root).toMatchObject({ runId: "root", action: "cancelled" });
      const byId = Object.fromEntries(summary.descendants.map((d) => [d.runId, d.action]));
      expect(byId).toEqual({
        "child-wf": "cancelled",
        "grand-wf": "cancelled",
      });
      for (const runId of ["root", "child-wf", "grand-wf"]) {
        expect((await adapter.getRun(runId)).status).toBe("cancelled");
      }
      // The fork branch keeps running, untouched — no flip, no request.
      for (const runId of ["fork", "fork-child"]) {
        const run = await adapter.getRun(runId);
        expect(run.status).toBe("running");
        expect(run.cancelRequestedAtMs ?? null).toBeNull();
      }
    } finally {
      sqlite.close();
    }
  });

  test("explicitly cancelling a fork BY ID still cancels it and its lifecycle children — but not a nested fork of it", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await insertRun(adapter, "source", { heartbeatAtMs: stale() });
      await insertRun(adapter, "fork", { parentRunId: "source", heartbeatAtMs: stale() });
      await insertForkBranch(sqlite, adapter, "fork", "source");
      await insertRun(adapter, "fork-child", { parentRunId: "fork", status: "waiting-event", heartbeatAtMs: null });
      await insertRun(adapter, "fork-of-fork", { parentRunId: "fork", heartbeatAtMs: stale() });
      await insertForkBranch(sqlite, adapter, "fork-of-fork", "fork");

      const summary = await cascadeCancelRun(adapter, "fork");

      // Depth 0: the branch-row check never applies to the cascade root.
      expect(summary.root).toMatchObject({ runId: "fork", action: "cancelled" });
      expect(summary.descendants).toEqual([expect.objectContaining({ runId: "fork-child", action: "cancelled" })]);
      expect((await adapter.getRun("fork")).status).toBe("cancelled");
      expect((await adapter.getRun("fork-child")).status).toBe("cancelled");
      expect((await adapter.getRun("fork-of-fork")).status).toBe("running");
      // The fork's SOURCE is an ancestor, never a descendant.
      expect((await adapter.getRun("source")).status).toBe("running");
    } finally {
      sqlite.close();
    }
  });

  test("no _smithers_branches table (time travel never used): treated as no forks, cascade sweeps without throwing", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      // Simulate a pre-time-travel DB whose migrations never made the
      // branches table, and assert it is really gone.
      sqlite.run(`DROP TABLE IF EXISTS _smithers_branches`);
      const tables = sqlite
        .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_smithers_branches'`)
        .all();
      expect(tables).toEqual([]);
      await insertRun(adapter, "root", { heartbeatAtMs: stale() });
      await insertRun(adapter, "child", { parentRunId: "root", status: "waiting-approval", heartbeatAtMs: null });

      const summary = await cascadeCancelRun(adapter, "root");

      expect(summary.root).toMatchObject({ runId: "root", action: "cancelled" });
      expect(summary.descendants).toEqual([expect.objectContaining({ runId: "child", action: "cancelled" })]);
      expect((await adapter.getRun("root")).status).toBe("cancelled");
      expect((await adapter.getRun("child")).status).toBe("cancelled");
    } finally {
      sqlite.close();
    }
  });

  test("race: a fork created WHILE the cascade runs is spared by the re-discovery pass; a late lifecycle child is still swept", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await insertRun(adapter, "root", { heartbeatAtMs: stale() });

      // While the root is being flipped, someone forks it AND its engine
      // launches one last child — pass 2 must sweep the child but spare
      // the fork.
      let injected = false;
      const racy = new Proxy(adapter, {
        get(target, prop, receiver) {
          if (prop === "listInProgressAttempts") {
            return async (runId) => {
              if (runId === "root" && !injected) {
                injected = true;
                await insertRun(target, "late-child", { parentRunId: "root", heartbeatAtMs: stale() });
                await insertRun(target, "late-fork", { parentRunId: "root", heartbeatAtMs: stale() });
                await insertForkBranch(sqlite, target, "late-fork", "root");
              }
              return target.listInProgressAttempts(runId);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const summary = await cascadeCancelRun(racy, "root");
      expect(summary.descendants).toEqual([expect.objectContaining({ runId: "late-child", action: "cancelled" })]);
      expect((await adapter.getRun("late-child")).status).toBe("cancelled");
      expect((await adapter.getRun("late-fork")).status).toBe("running");
    } finally {
      sqlite.close();
    }
  });

  test("isCancellableRunStatus matches the cancel command's contract", () => {
    for (const status of ["running", "waiting-approval", "waiting-event", "waiting-timer", "paused"]) {
      expect(isCancellableRunStatus(status)).toBe(true);
    }
    for (const status of ["finished", "failed", "cancelled", "continued", null, undefined]) {
      expect(isCancellableRunStatus(status)).toBe(false);
    }
  });
});

describe("terminateRunOwner (real processes)", () => {
  test.skipIf(process.platform === "win32")(
    "SIGTERMs a detached owner's process group: the owner AND its same-group child die",
    async () => {
      const repo = createTempRepo();
      const pidFile = repo.path("agent.pid");
      // A real detached "owner" that spawns a same-group "agent" child and
      // parks — the shape of a detached `smithers up -d` engine.
      const owner = spawn(
        process.execPath,
        [
          "-e",
          `const { spawn } = require("node:child_process");
             const { writeFileSync } = require("node:fs");
             const agent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
             writeFileSync(process.env.SMITHERS_TEST_PID_FILE, String(agent.pid));
             setInterval(() => {}, 1000);`,
        ],
        {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, SMITHERS_TEST_PID_FILE: pidFile },
        },
      );
      owner.unref();
      spawnedPids.push(owner.pid);

      const deadline = Date.now() + 10_000;
      while (!existsSync(pidFile) && Date.now() < deadline) {
        await Bun.sleep(50);
      }
      const agentPid = Number(readFileSync(pidFile, "utf8").trim());
      spawnedPids.push(agentPid);
      expect(pidAlive(owner.pid)).toBe(true);
      expect(pidAlive(agentPid)).toBe(true);

      const result = await terminateRunOwner(owner.pid, { graceMs: 2_000 });

      expect(result.terminated).toBe(true);
      expect(await waitForPidExit(owner.pid)).toBe(true);
      expect(await waitForPidExit(agentPid)).toBe(true);
    },
    30_000,
  );

  test.skipIf(process.platform === "win32")(
    "escalates to SIGKILL when the owner ignores SIGTERM",
    async () => {
      const owner = spawn("bash", ["-c", "trap '' TERM; while :; do sleep 0.1; done"], {
        detached: true,
        stdio: "ignore",
      });
      owner.unref();
      spawnedPids.push(owner.pid);
      // Give bash a beat to install the trap.
      await Bun.sleep(300);

      const result = await terminateRunOwner(owner.pid, { graceMs: 400 });

      expect(result.terminated).toBe(true);
      expect(result.escalated).toBe(true);
      expect(await waitForPidExit(owner.pid)).toBe(true);
    },
    30_000,
  );

  test("never signals itself: own pid and invalid pids are skipped", async () => {
    expect(await terminateRunOwner(process.pid)).toEqual({ terminated: false, skipped: true, escalated: false });
    expect(await terminateRunOwner(null)).toEqual({ terminated: false, skipped: true, escalated: false });
    expect(await terminateRunOwner(0)).toEqual({ terminated: false, skipped: true, escalated: false });
  });
});

describe("smithers cancel cascades (CLI integration)", () => {
  test(
    "cancels a quota-parked run through the public CLI",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        await insertRun(adapter, "quota-cli", {
          status: "waiting-quota",
          heartbeatAtMs: null,
          runtimeOwnerId: null,
          errorJson: JSON.stringify({ resetAtMs: Date.now() + 60_000 }),
        });

        const result = runSmithers(["cancel", "quota-cli"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: CLI_COMMAND_TIMEOUT_MS,
        });

        expect(result.exitCode).toBe(2);
        expect(result.json).toMatchObject({ runId: "quota-cli", status: "cancelled" });
        expect((await adapter.getRun("quota-cli")).status).toBe("cancelled");
      } finally {
        sqlite.close();
      }
    },
    CLI_COMMAND_TIMEOUT_MS,
  );

  test(
    "cancelling the root sweeps nested descendants: stale flipped, live durably requested, bystanders untouched",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        await insertRun(adapter, "root", { heartbeatAtMs: stale() });
        await insertRun(adapter, "live-child", { parentRunId: "root", heartbeatAtMs: fresh() });
        await insertRun(adapter, "grand-wait", {
          parentRunId: "live-child",
          status: "waiting-approval",
          heartbeatAtMs: null,
        });
        await insertRun(adapter, "bystander", { heartbeatAtMs: fresh() });

        const result = runSmithers(["cancel", "root"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: CLI_COMMAND_TIMEOUT_MS,
        });

        expect(result.exitCode).toBe(2);
        expect(result.json).toMatchObject({ runId: "root", status: "cancelled" });
        expect(result.json?.descendants).toMatchObject({
          discovered: 2,
          cancelRequested: ["live-child"],
          cancelled: ["grand-wait"],
        });

        expect((await adapter.getRun("root")).status).toBe("cancelled");
        const liveChild = await adapter.getRun("live-child");
        expect(liveChild.status).toBe("running");
        expect(liveChild.cancelRequestedAtMs ?? 0).toBeGreaterThan(0);
        expect((await adapter.getRun("grand-wait")).status).toBe("cancelled");
        const bystander = await adapter.getRun("bystander");
        expect(bystander.status).toBe("running");
        expect(bystander.cancelRequestedAtMs ?? null).toBeNull();
      } finally {
        sqlite.close();
      }
    },
    CLI_COMMAND_TIMEOUT_MS,
  );

  test.skipIf(process.platform === "win32")(
    "terminates a dead-heartbeat descendant's detached owner process",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        const ownerPid = await spawnOrphanKeepAlive(repo.path("owner.pid"));
        await insertRun(adapter, "root", { heartbeatAtMs: stale() });
        await insertRun(adapter, "orphan-child", {
          parentRunId: "root",
          heartbeatAtMs: stale(),
          runtimeOwnerId: `pid:${ownerPid}:cascade-test`,
        });
        expect(pidAlive(ownerPid)).toBe(true);

        const result = runSmithers(["cancel", "root"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: CLI_COMMAND_TIMEOUT_MS,
        });

        expect(result.exitCode).toBe(2);
        expect(result.json?.terminatedOwners).toEqual([{ runId: "orphan-child", pid: ownerPid }]);
        expect((await adapter.getRun("orphan-child")).status).toBe("cancelled");
        expect(await waitForPidExit(ownerPid)).toBe(true);
      } finally {
        sqlite.close();
      }
    },
    CLI_COMMAND_TIMEOUT_MS,
  );

  test(
    "idempotent completion: re-cancelling a terminal root sweeps a straggler child; a fully-terminal tree is RUN_NOT_ACTIVE",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        // An interrupted earlier cascade: root already cancelled, child left behind.
        await insertRun(adapter, "root", {
          status: "cancelled",
          heartbeatAtMs: null,
          finishedAtMs: Date.now() - 5_000,
        });
        await insertRun(adapter, "straggler", { parentRunId: "root", status: "waiting-event", heartbeatAtMs: null });

        const sweep = runSmithers(["cancel", "root"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: CLI_COMMAND_TIMEOUT_MS,
        });
        expect(sweep.exitCode).toBe(2);
        expect(sweep.json?.descendants).toMatchObject({ cancelled: ["straggler"] });
        expect((await adapter.getRun("straggler")).status).toBe("cancelled");

        // Everything terminal now: repeating is a safe no-op rejection.
        const repeat = runSmithers(["cancel", "root"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: CLI_COMMAND_TIMEOUT_MS,
        });
        expect(repeat.exitCode).toBe(4);
        expect(repeat.json?.code).toBe("RUN_NOT_ACTIVE");
        expect((await adapter.getRun("root")).status).toBe("cancelled");
        expect((await adapter.getRun("straggler")).status).toBe("cancelled");
      } finally {
        sqlite.close();
      }
    },
    CLI_COMMAND_TIMEOUT_MS,
  );

  test(
    "cancelling a superseded root spares the time-travel fork that replaced it",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        // The live-run shape that motivated the fix: a dead root, one
        // lifecycle child to sweep, and a healthy fork that superseded the
        // root. `smithers cancel root` must not take the fork down.
        await insertRun(adapter, "root", { heartbeatAtMs: stale() });
        await insertRun(adapter, "child-wf", { parentRunId: "root", status: "waiting-approval", heartbeatAtMs: null });
        await insertRun(adapter, "fork", { parentRunId: "root", heartbeatAtMs: stale() });
        await insertForkBranch(sqlite, adapter, "fork", "root");
        await insertRun(adapter, "fork-child", { parentRunId: "fork", status: "waiting-event", heartbeatAtMs: null });

        const result = runSmithers(["cancel", "root"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: CLI_COMMAND_TIMEOUT_MS,
        });

        expect(result.exitCode).toBe(2);
        expect(result.json).toMatchObject({ runId: "root", status: "cancelled" });
        expect(result.json?.descendants).toMatchObject({
          discovered: 1,
          cancelled: ["child-wf"],
        });
        expect((await adapter.getRun("root")).status).toBe("cancelled");
        expect((await adapter.getRun("child-wf")).status).toBe("cancelled");
        const fork = await adapter.getRun("fork");
        expect(fork.status).toBe("running");
        expect(fork.cancelRequestedAtMs ?? null).toBeNull();
        expect((await adapter.getRun("fork-child")).status).toBe("waiting-event");
      } finally {
        sqlite.close();
      }
    },
    CLI_COMMAND_TIMEOUT_MS,
  );
});
