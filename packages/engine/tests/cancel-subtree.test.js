import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { SmithersDb } from "@smthrs/db/adapter";
import { cancelRunSubtree, isCancellableRunStatus, terminateSubtreeAgentProcesses } from "../src/cancel-subtree.js";

/**
 * Transactional recursive subtree cancellation (#971) and its process-tree
 * guarantees (#972), against a REAL sqlite store and REAL detached processes.
 */

const STALE_HEARTBEAT_MS = 120_000;
const FRESH_HEARTBEAT_LEEWAY_MS = 120_000;

/** Pids spawned by a test; reaped afterEach so a failure cannot leak them. */
const spawnedPids = [];
const tempDirs = [];
afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
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

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(25);
  }
  return predicate();
}

function createStore() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

/**
 * Spawn a real ORPHANED detached keep-alive process — the shape of a detached
 * `smithers up -d` owner whose launcher already exited. The double fork keeps
 * it from lingering as a zombie child of this test process.
 *
 * @returns {Promise<number>}
 */
async function spawnDetachedOwner() {
  const dir = mkdtempSync(join(tmpdir(), "cancel-subtree-"));
  tempDirs.push(dir);
  const pidFile = join(dir, "owner.pid");
  const launcher = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
       const { writeFileSync } = require("node:fs");
       const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
       child.unref();
       writeFileSync(process.env.PID_FILE, String(child.pid));
       process.exit(0);`,
    ],
    { stdio: "ignore", env: { ...process.env, PID_FILE: pidFile } },
  );
  await new Promise((resolvePromise) => launcher.on("exit", resolvePromise));
  await waitFor(() => existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  spawnedPids.push(pid);
  return pid;
}

const stale = () => Date.now() - STALE_HEARTBEAT_MS;
const fresh = () => Date.now() + FRESH_HEARTBEAT_LEEWAY_MS;

async function insertRun(adapter, runId, overrides = {}) {
  const now = Date.now();
  await adapter.insertRun({
    runId,
    workflowName: "subtree-fixture",
    workflowPath: "workflow.tsx",
    status: "running",
    createdAtMs: now - 10_000,
    startedAtMs: now - 9_000,
    finishedAtMs: null,
    heartbeatAtMs: stale(),
    ...overrides,
  });
}

describe("cancelRunSubtree — recursive coverage (real sqlite)", () => {
  test("converges every parked descendant status and leaves terminal rows alone", async () => {
    const { adapter } = createStore();
    await insertRun(adapter, "root");
    const parked = ["waiting-approval", "waiting-event", "waiting-timer", "waiting-quota", "paused"];
    for (const [index, status] of parked.entries()) {
      await insertRun(adapter, `child-${status}`, { parentRunId: "root", status });
      // A grandchild under each child proves the walk is recursive, not one level.
      await insertRun(adapter, `grandchild-${index}`, { parentRunId: `child-${status}`, status: "running" });
    }
    // Terminal rows must not be regressed.
    await insertRun(adapter, "child-finished", {
      parentRunId: "root",
      status: "finished",
      finishedAtMs: Date.now() - 1_000,
      heartbeatAtMs: null,
    });
    // An unrelated tree must not be touched at all.
    await insertRun(adapter, "unrelated", { status: "running" });
    await insertRun(adapter, "unrelated-child", { parentRunId: "unrelated", status: "waiting-event" });

    const summary = await cancelRunSubtree(adapter, "root");

    expect(summary.root?.action).toBe("cancelled");
    expect(summary.descendants).toHaveLength(parked.length * 2 + 1);
    for (const status of parked) {
      expect((await adapter.getRun(`child-${status}`)).status).toBe("cancelled");
    }
    for (let index = 0; index < parked.length; index++) {
      expect((await adapter.getRun(`grandchild-${index}`)).status).toBe("cancelled");
    }
    const finished = await adapter.getRun("child-finished");
    expect(finished.status).toBe("finished");
    expect(summary.descendants.find((d) => d.runId === "child-finished")?.action).toBe("already-terminal");
    expect((await adapter.getRun("unrelated")).status).toBe("running");
    expect((await adapter.getRun("unrelated-child")).status).toBe("waiting-event");
  });

  test("is idempotent: a second pass reports already-terminal and changes nothing", async () => {
    const { adapter } = createStore();
    await insertRun(adapter, "root");
    await insertRun(adapter, "child", { parentRunId: "root", status: "waiting-event" });

    const first = await cancelRunSubtree(adapter, "root");
    const firstFinishedAtMs = (await adapter.getRun("child")).finishedAtMs;
    const second = await cancelRunSubtree(adapter, "root");

    expect(first.root?.action).toBe("cancelled");
    expect(second.root?.action).toBe("already-terminal");
    expect(second.descendants.every((d) => d.action === "already-terminal")).toBe(true);
    expect((await adapter.getRun("child")).finishedAtMs).toBe(firstFinishedAtMs);
  });

  test("safe under concurrent cancellers: exactly one claim wins per run", async () => {
    const { adapter } = createStore();
    await insertRun(adapter, "root");
    for (let index = 0; index < 6; index++) {
      await insertRun(adapter, `child-${index}`, { parentRunId: "root", status: "waiting-approval" });
    }

    const [a, b, c] = await Promise.all([
      cancelRunSubtree(adapter, "root"),
      cancelRunSubtree(adapter, "root"),
      cancelRunSubtree(adapter, "root"),
    ]);

    // Each run is claimed by exactly one canceller; the losers report
    // already-terminal instead of clobbering the winner's row.
    for (const runId of ["root", "child-0", "child-1", "child-2", "child-3", "child-4", "child-5"]) {
      const run = await adapter.getRun(runId);
      expect(run.status).toBe("cancelled");
      expect(run.runtimeOwnerId).toBeNull();
      expect(run.heartbeatAtMs).toBeNull();
      // A durable cancel signal survives on the terminal row so an owner in
      // another process still observes it.
      expect(run.cancelRequestedAtMs).toBeGreaterThan(0);
    }
    const winners = [a, b, c].flatMap((summary) =>
      [summary.root, ...summary.descendants].filter((outcome) => outcome?.action === "cancelled"),
    );
    expect(winners).toHaveLength(7);
  });

  test("a live run gets a durable cancel request instead of a status flip", async () => {
    const { adapter } = createStore();
    await insertRun(adapter, "root", { heartbeatAtMs: fresh(), runtimeOwnerId: `pid:${process.pid}:owner` });

    const summary = await cancelRunSubtree(adapter, "root");

    expect(summary.root?.action).toBe("cancel-requested");
    const run = await adapter.getRun("root");
    // Its own engine writes the terminal status once its cancel watcher fires.
    expect(run.status).toBe("running");
    expect(run.cancelRequestedAtMs).toBeGreaterThan(0);
  });

  test("attributes the cancellation across the whole subtree", async () => {
    const { adapter } = createStore();
    await insertRun(adapter, "root");
    await insertRun(adapter, "child", { parentRunId: "root", status: "paused" });

    await cancelRunSubtree(adapter, "root", {
      attribution: { kind: "rpc", detail: "websocket cancellation request", requestId: "cancelRun-1" },
    });

    for (const runId of ["root", "child"]) {
      const run = await adapter.getRun(runId);
      expect(run.cancelRequestSource).toBe("rpc");
      expect(run.cancelRequestId).toBe("cancelRun-1");
    }
  });

  test("isCancellableRunStatus covers every parked status and no terminal one", () => {
    for (const status of ["running", "waiting-approval", "waiting-event", "waiting-timer", "waiting-quota", "paused"]) {
      expect(isCancellableRunStatus(status)).toBe(true);
    }
    for (const status of ["finished", "failed", "cancelled", "canceled", "continued", null, undefined]) {
      expect(isCancellableRunStatus(status)).toBe(false);
    }
  });
});

describe.skipIf(process.platform === "win32")("cancelRunSubtree — real process trees", () => {
  test("terminates a surviving detached owner of a parked descendant", async () => {
    const { adapter } = createStore();
    const ownerPid = await spawnDetachedOwner();
    await insertRun(adapter, "root");
    await insertRun(adapter, "child", {
      parentRunId: "root",
      status: "paused",
      runtimeOwnerId: `pid:${ownerPid}:detached-owner`,
    });

    const summary = await cancelRunSubtree(adapter, "root", { ownerKillGraceMs: 3_000 });

    expect(summary.terminatedOwners).toContainEqual({ runId: "child", pid: ownerPid });
    expect(await waitFor(() => !pidAlive(ownerPid))).toBe(true);
    expect((await adapter.getRun("child")).status).toBe("cancelled");
  });

  test("kills registered agent processes for the subtree and spares unrelated runs'", async () => {
    const { adapter } = createStore();
    const subtreeAgentPid = await spawnDetachedOwner();
    const unrelatedAgentPid = await spawnDetachedOwner();
    await insertRun(adapter, "root");
    await insertRun(adapter, "child", { parentRunId: "root", status: "waiting-timer" });
    await insertRun(adapter, "unrelated", { status: "running", heartbeatAtMs: fresh() });
    // A HUNG-BUT-ALIVE engine: the generic orphan sweep spares its agents, but
    // once its run is fenced cancelled they must still be reaped (#972).
    await adapter.registerAgentProcess({
      pid: subtreeAgentPid,
      runId: "child",
      nodeId: "implement",
      enginePid: process.pid,
      startedAtMs: Date.now(),
    });
    await adapter.registerAgentProcess({
      pid: unrelatedAgentPid,
      runId: "unrelated",
      nodeId: "implement",
      enginePid: process.pid,
      startedAtMs: Date.now(),
    });

    const summary = await cancelRunSubtree(adapter, "root", { agentKillGraceMs: 3_000 });

    expect(summary.terminatedAgents).toContainEqual({ runId: "child", pid: subtreeAgentPid });
    expect(summary.survivingAgents).toBe(0);
    // Verified reaping: no agent process of the cancelled subtree survives.
    expect(await waitFor(() => !pidAlive(subtreeAgentPid))).toBe(true);
    const remaining = await adapter.listAgentProcesses();
    expect(remaining.map((row) => Number(row.pid))).toEqual([unrelatedAgentPid]);
    expect(pidAlive(unrelatedAgentPid)).toBe(true);
  });

  test("terminateSubtreeAgentProcesses prunes rows for agents that already exited", async () => {
    const { adapter } = createStore();
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const deadPid = child.pid;
    await new Promise((resolvePromise) => child.on("exit", resolvePromise));
    await waitFor(() => !pidAlive(deadPid));
    await insertRun(adapter, "root");
    await adapter.registerAgentProcess({
      pid: deadPid,
      runId: "root",
      nodeId: "implement",
      enginePid: process.pid,
      startedAtMs: Date.now(),
    });

    const result = await terminateSubtreeAgentProcesses(adapter, ["root"]);

    expect(result.terminatedAgents).toEqual([]);
    expect(result.survivingAgents).toBe(0);
    expect(await adapter.listAgentProcesses()).toEqual([]);
  });
});
