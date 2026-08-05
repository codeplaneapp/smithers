import { describe, expect, test } from "bun:test";
import { reapOrphanedAgentProcesses } from "../src/reap-orphaned-agents.js";

// #1464 AWF-3 / #1332: an agent subprocess must never outlive its engine
// unsupervised. The engine registers every agent pid it spawns; the sweep
// group-kills any registered pid whose engine is verifiably gone and prunes
// rows for processes that already exited.

const NOW = Date.UTC(2026, 6, 12, 12, 0, 0);
const STALE = 30_000;

function makeHarness({ rows, runs = {}, alivePids = [] } = {}) {
  const alive = new Set(alivePids);
  const kills = [];
  const removed = [];
  const adapter = {
    listAgentProcesses: async () => rows,
    getRun: async (runId) => runs[runId] ?? null,
    unregisterAgentProcess: async (pid) => {
      removed.push(pid);
    },
  };
  const options = {
    nowMs: NOW,
    staleThresholdMs: STALE,
    graceMs: 0,
    alive: (pid) => alive.has(pid),
    kill: (pid, signal) => {
      kills.push([pid, signal]);
      // Group kills address -pid; the harness tracks the positive pid.
      const real = Math.abs(pid);
      // SIGTERM settles the process unless the harness keeps it alive.
      if (signal === "SIGTERM" && !alive.has(`${real}:stubborn`)) alive.delete(real);
      if (signal === "SIGKILL") alive.delete(real);
    },
  };
  return { adapter, options, kills, removed, alive };
}

function processRow(overrides = {}) {
  return {
    pid: 4242,
    runId: "run-1",
    nodeId: "implement",
    enginePid: 31337,
    startedAtMs: NOW - 60_000,
    ...overrides,
  };
}

describe("reapOrphanedAgentProcesses", () => {
  test("group-kills a live agent whose engine is dead and whose run is not heartbeating", async () => {
    const { adapter, options, kills, removed } = makeHarness({
      rows: [processRow()],
      runs: {
        "run-1": { runId: "run-1", status: "running", heartbeatAtMs: NOW - 10 * 60_000, finishedAtMs: null },
      },
      alivePids: [4242], // agent alive, engine (31337) dead
    });
    const result = await reapOrphanedAgentProcesses(adapter, options);
    expect(result.reaped).toEqual([{ pid: 4242, runId: "run-1" }]);
    // Group-targeted: the negative pid addresses the whole process group, so
    // subagents/MCP children die with the wrapper.
    expect(kills[0]).toEqual([-4242, "SIGTERM"]);
    expect(removed).toEqual([4242]);
  });

  test("escalates to SIGKILL when SIGTERM does not settle the group", async () => {
    const { adapter, options, kills, alive } = makeHarness({
      rows: [processRow()],
      runs: { "run-1": { runId: "run-1", status: "running", heartbeatAtMs: NOW - 10 * 60_000 } },
      alivePids: [4242, "4242:stubborn"],
    });
    const result = await reapOrphanedAgentProcesses(adapter, options);
    expect(kills.map(([pid, signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.reaped).toEqual([{ pid: 4242, runId: "run-1" }]);
    void alive;
  });

  test("leaves agents of a live engine strictly alone", async () => {
    const { adapter, options, kills, removed } = makeHarness({
      rows: [processRow()],
      runs: { "run-1": { runId: "run-1", status: "running", heartbeatAtMs: NOW - 1_000 } },
      alivePids: [31337, 4242], // engine alive
    });
    const result = await reapOrphanedAgentProcesses(adapter, options);
    expect(result.reaped).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(kills).toEqual([]);
    expect(removed).toEqual([]);
  });

  test("skips rows whose run has a fresh heartbeat even when the registered engine pid is gone", async () => {
    // Pid reuse / a resumed run under a new engine: the fresh heartbeat means a
    // live engine owns the work now, so the agent is not an orphan.
    const { adapter, options, kills } = makeHarness({
      rows: [processRow()],
      runs: { "run-1": { runId: "run-1", status: "running", heartbeatAtMs: NOW - 1_000 } },
      alivePids: [4242],
    });
    const result = await reapOrphanedAgentProcesses(adapter, options);
    expect(result.reaped).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(kills).toEqual([]);
  });

  test("prunes rows for processes that already exited on their own", async () => {
    const { adapter, options, kills, removed } = makeHarness({
      rows: [processRow()],
      runs: { "run-1": { runId: "run-1", status: "failed", heartbeatAtMs: null, finishedAtMs: NOW - 5_000 } },
      alivePids: [], // agent and engine both gone
    });
    const result = await reapOrphanedAgentProcesses(adapter, options);
    expect(result.pruned).toBe(1);
    expect(result.reaped).toEqual([]);
    expect(kills).toEqual([]);
    expect(removed).toEqual([4242]);
  });

  test("never signals our own pid", async () => {
    const { adapter, options, kills } = makeHarness({
      rows: [processRow({ pid: process.pid })],
      runs: { "run-1": { runId: "run-1", status: "failed", heartbeatAtMs: null } },
      alivePids: [process.pid],
    });
    const result = await reapOrphanedAgentProcesses(adapter, options);
    expect(result.reaped).toEqual([]);
    expect(kills).toEqual([]);
  });

  test("a missing registry (pre-0036 store) is a no-op, not an error", async () => {
    const adapter = {
      listAgentProcesses: async () => {
        throw new Error("no such table: _smithers_agent_processes");
      },
    };
    const result = await reapOrphanedAgentProcesses(adapter, { nowMs: NOW });
    expect(result).toMatchObject({ reaped: [], pruned: 0, skipped: 0 });
  });
});
