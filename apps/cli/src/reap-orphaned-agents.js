// Orphan agent reaper (#1464 AWF-3, #1332).
//
// Agent CLIs are spawned as their own process-group leaders (POSIX) so they
// survive nothing: the engine registers every agent pid in
// `_smithers_agent_processes` when it starts and deregisters on exit. An
// engine that dies without cleanup (SIGKILL, OOM) leaves rows behind; the
// next CLI invocation sweeps the registry and group-kills any pid whose
// engine is verifiably gone, so no unsupervised agent keeps burning
// subscription quota.

import { spawnSync } from "node:child_process";
import { isPidAlive } from "@smthrs/engine/runtime-owner";
import { RUN_STATE_HEARTBEAT_STALE_MS } from "@smthrs/db/runState";

/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */

const AGENT_KILL_GRACE_MS = 1_000;
const AGENT_KILL_POLL_MS = 50;
/** Hard ceiling for the boot sweep: reaping is opportunistic, never blocking. */
const BOOT_REAP_TIMEOUT_MS = 2_500;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * A run row still owned by a live engine: fresh heartbeat, or no heartbeat
 * column data at all (older stores) with a non-terminal status. Registry rows
 * for such a run belong to that engine, not to us.
 *
 * @param {any} run
 * @param {number} nowMs
 * @param {number} staleThresholdMs
 * @returns {boolean}
 */
function runLooksLive(run, nowMs, staleThresholdMs) {
  if (!run || typeof run !== "object") return false;
  const status = String(run.status ?? "");
  const active =
    status === "running" ||
    status === "waiting-approval" ||
    status === "waiting-event" ||
    status === "waiting-timer" ||
    status === "waiting-quota" ||
    (status === "continued" && run.finishedAtMs == null);
  if (!active) return false;
  const heartbeatAtMs = typeof run.heartbeatAtMs === "number" ? run.heartbeatAtMs : null;
  if (heartbeatAtMs == null) return false;
  return nowMs - heartbeatAtMs < staleThresholdMs;
}

/**
 * Kill one registered agent process by group (POSIX) or tree (win32).
 * Never signals our own pid or process group.
 *
 * @param {number} pid
 * @param {{ kill?: (pid: number, signal: string) => void; alive?: (pid: number) => boolean; graceMs?: number; platform?: NodeJS.Platform }} options
 * @returns {Promise<boolean>} whether the process is gone afterwards
 */
async function terminateAgentProcess(pid, options) {
  const kill = options.kill ?? ((target, signal) => process.kill(target, signal));
  const alive = options.alive ?? isPidAlive;
  const graceMs = options.graceMs ?? AGENT_KILL_GRACE_MS;
  const platform = options.platform ?? process.platform;
  if (pid === process.pid) return false;
  if (platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return !alive(pid);
  }
  const ownGroup = typeof process.getpgrp === "function" ? process.getpgrp() : null;
  if (ownGroup !== null && ownGroup === pid) return false;
  /** @param {string} signal */
  const signalGroup = (signal) => {
    try {
      // Registered agents are group leaders (detached spawn), so the pgid is
      // the pid; a group kill takes subagents/MCP children down with it.
      kill(-pid, signal);
      return true;
    } catch {
      // Not a group leader, or the group is already gone.
    }
    try {
      kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  };
  if (!signalGroup("SIGTERM")) return !alive(pid);
  const deadline = Date.now() + Math.max(0, graceMs);
  while (alive(pid) && Date.now() < deadline) {
    await sleep(AGENT_KILL_POLL_MS);
  }
  if (!alive(pid)) return true;
  signalGroup("SIGKILL");
  const killDeadline = Date.now() + Math.max(graceMs, 500);
  while (alive(pid) && Date.now() < killDeadline) {
    await sleep(AGENT_KILL_POLL_MS);
  }
  return !alive(pid);
}

/**
 * Sweep the agent-process registry: group-kill every registered agent whose
 * engine is verifiably dead (engine pid gone AND run not actively
 * heartbeating), and prune rows for processes that already exited on their
 * own. Rows whose engine is alive are left strictly alone.
 *
 * @param {SmithersDb} adapter
 * @param {{ nowMs?: number; staleThresholdMs?: number; kill?: (pid: number, signal: string) => void; alive?: (pid: number) => boolean; graceMs?: number; platform?: NodeJS.Platform; deleteRows?: boolean }} [options]
 * @returns {Promise<{ reaped: Array<{ pid: number; runId: string | null }>; pruned: number; skipped: number; handledPids: number[] }>}
 */
export async function reapOrphanedAgentProcesses(adapter, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const staleThresholdMs = options.staleThresholdMs ?? RUN_STATE_HEARTBEAT_STALE_MS;
  const alive = options.alive ?? isPidAlive;
  const deleteRows = options.deleteRows !== false;
  const result = { reaped: [], pruned: 0, skipped: 0, handledPids: [] };
  if (typeof adapter.listAgentProcesses !== "function") return result;
  /** @type {Array<Record<string, unknown>>} */
  let rows;
  try {
    rows = await adapter.listAgentProcesses();
  } catch {
    // Registry missing (pre-0036 store) or unreadable: nothing to sweep.
    return result;
  }
  /** @param {number} pid */
  const removeRow = async (pid) => {
    result.handledPids.push(pid);
    if (!deleteRows) return;
    try {
      await adapter.unregisterAgentProcess(pid);
    } catch {
      /* best-effort */
    }
  };
  // Phase 1 — classify every row (cheap reads, run lookups in parallel).
  /** @type {Array<{ pid: number; runId: string | null }>} */
  const killCandidates = [];
  /** @type {number[]} */
  const prunePids = [];
  await Promise.all(
    (rows ?? []).map(async (row) => {
      const pid = Number(row?.pid);
      const runId = typeof row?.runId === "string" ? row.runId : null;
      if (!Number.isInteger(pid) || pid <= 0) {
        return;
      }
      if (pid === process.pid) {
        result.skipped += 1;
        return;
      }
      const enginePid = Number(row?.enginePid);
      if (Number.isInteger(enginePid) && enginePid > 0 && alive(enginePid)) {
        result.skipped += 1;
        return;
      }
      // The engine pid is gone. Pid reuse could resurrect it as an unrelated
      // process, so cross-check the run row: a run with a fresh heartbeat has a
      // live (possibly new) engine and its agents are not orphans.
      try {
        const run = runId ? await adapter.getRun(runId) : null;
        if (runLooksLive(run, nowMs, staleThresholdMs)) {
          result.skipped += 1;
          return;
        }
      } catch {
        // Run row unreadable: engine pid is dead either way — keep going.
      }
      if (!alive(pid)) {
        prunePids.push(pid);
        return;
      }
      killCandidates.push({ pid, runId });
    }),
  );
  // Phase 2 — kill candidates concurrently: a fleet of dead engines' orphans
  // (issue #1332 saw 56) reaps in one grace window, not one per window.
  await Promise.all(
    killCandidates.map(async ({ pid, runId }) => {
      const gone = await terminateAgentProcess(pid, options);
      if (gone) {
        result.reaped.push({ pid, runId });
      } else {
        result.skipped += 1;
      }
      await removeRow(pid);
    }),
  );
  result.pruned = prunePids.length;
  await Promise.all(prunePids.map((pid) => removeRow(pid)));
  return result;
}

/**
 * CLI-preamble entry point: open the nearest workspace store (read-only —
 * boot must never provision or migrate), sweep the registry, and print one
 * stderr line per reaped group. Only the store open is hard-bounded — that is
 * the step that can stall on a lock-contended database; the sweep itself is
 * internally bounded (one grace window, kills in parallel) and must run to
 * completion or the reap — and its notice — would be lost on process exit.
 * Never throws. Row cleanup is left to the engine's own deregistration and to
 * `cancel`/`down`, which hold write connections anyway — a boot sweep only
 * needs to make dead engines' agents STOP, not to tidy the table.
 *
 * @param {{ cwd?: string; stderr?: (line: string) => void; nowMs?: number; timeoutMs?: number }} [options]
 * @returns {Promise<{ reaped: number }>}
 */
export async function reapOrphanedAgentsOnBoot(options = {}) {
  const stderr = options.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const timeoutMs = options.timeoutMs ?? BOOT_REAP_TIMEOUT_MS;
  try {
    const { openSmithersStore } = await import("smthrs/openSmithersStore");
    const readStore = await Promise.race([
      openSmithersStore({ cwd: options.cwd, mode: "read" }),
      new Promise((resolvePromise) => setTimeout(() => resolvePromise(null), timeoutMs)),
    ]);
    if (!readStore) return { reaped: 0 };
    /** @type {{ reaped: Array<{ pid: number; runId: string | null }> }} */
    let sweep;
    try {
      sweep = await reapOrphanedAgentProcesses(readStore.adapter, {
        deleteRows: false,
        ...(options.nowMs != null ? { nowMs: options.nowMs } : {}),
      });
    } finally {
      // cleanup is sync-void on sqlite stores: normalize before .catch.
      await Promise.resolve(readStore.cleanup?.()).catch(() => {});
    }
    for (const entry of sweep.reaped) {
      stderr(
        `[smithers] Reaped orphaned agent process ${entry.pid}${entry.runId ? ` (run ${entry.runId})` : ""} — its engine is gone.`,
      );
    }
    return { reaped: sweep.reaped.length };
  } catch {
    return { reaped: 0 };
  }
}
