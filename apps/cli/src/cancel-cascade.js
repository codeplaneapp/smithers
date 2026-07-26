import { spawnSync } from "node:child_process";
import { finalizeCancelledRun, isRunHeartbeatFresh } from "@smithers-orchestrator/engine";
import { isPidAlive, parseRuntimeOwnerPid } from "@smithers-orchestrator/engine/runtime-owner";
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/db/adapter").RunRow} RunRow */

/**
 * Statuses `smithers cancel` can act on. Everything else (finished, failed,
 * cancelled, continued) is terminal and skipped, which is what makes the
 * cascade idempotent: re-running it only touches survivors.
 */
const CANCELLABLE_RUN_STATUSES = new Set([
  "running",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "waiting-quota",
  "paused",
]);
/**
 * A run cancelled mid-cascade can keep LAUNCHING children until its engine
 * observes the durable cancel request, so one discovery pass can miss
 * late-spawned descendants. Re-discover until a pass finds nothing new,
 * bounded so a pathological spawner cannot wedge the CLI.
 */
const MAX_CASCADE_DISCOVERY_PASSES = 5;
const DEFAULT_OWNER_KILL_GRACE_MS = 2_000;
const OWNER_KILL_POLL_MS = 50;

/**
 * @param {string | null | undefined} status
 * @returns {boolean}
 */
export function isCancellableRunStatus(status) {
  return typeof status === "string" && CANCELLABLE_RUN_STATUSES.has(status);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * Terminate a detached run owner process and, where possible, its whole
 * process group (agent CLIs spawned by the engine live under it).
 *
 * Platform-appropriate fallbacks:
 * - win32: `taskkill /T /F` kills the full tree.
 * - POSIX: SIGTERM the process GROUP first (detached owners are group
 *   leaders and a live-but-stale engine aborts its agents on SIGTERM), fall
 *   back to the single pid when the owner is not a group leader, then
 *   escalate to SIGKILL (group, then pid) if it survives the grace window.
 *
 * Never signals our own pid or our own process group.
 *
 * @param {number | null} pid
 * @param {{ graceMs?: number; platform?: NodeJS.Platform; kill?: (pid: number, signal: string) => void; alive?: (pid: number) => boolean; runTaskkill?: (pid: number) => boolean }} [options]
 * @returns {Promise<{ terminated: boolean; skipped: boolean; escalated: boolean }>}
 */
export async function terminateRunOwner(pid, options = {}) {
  const graceMs = options.graceMs ?? DEFAULT_OWNER_KILL_GRACE_MS;
  const platform = options.platform ?? process.platform;
  const kill = options.kill ?? ((target, signal) => process.kill(target, signal));
  const alive = options.alive ?? isPidAlive;
  const runTaskkill =
    options.runTaskkill ??
    ((target) =>
      spawnSync("taskkill", ["/PID", String(target), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).status === 0);
  if (!Number.isInteger(pid) || pid === null || pid <= 0) {
    return { terminated: false, skipped: true, escalated: false };
  }
  if (pid === process.pid) {
    return { terminated: false, skipped: true, escalated: false };
  }
  if (platform === "win32") {
    return { terminated: runTaskkill(pid), skipped: false, escalated: false };
  }
  // Refuse to signal our own process group: a group kill would take the CLI
  // (and its caller) down with the target.
  const ownGroup = typeof process.getpgrp === "function" ? process.getpgrp() : null;
  if (ownGroup !== null && ownGroup === pid) {
    return { terminated: false, skipped: true, escalated: false };
  }
  /**
   * @param {string} signal
   * @returns {boolean} whether any signal was delivered
   */
  const signalGroupThenPid = (signal) => {
    try {
      kill(-pid, signal);
      return true;
    } catch {
      // Not a group leader (or the group is gone) — fall back to the pid.
    }
    try {
      kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  };
  if (!signalGroupThenPid("SIGTERM")) {
    // Nothing accepted the signal: the process is already gone.
    return { terminated: !alive(pid), skipped: false, escalated: false };
  }
  const deadline = Date.now() + Math.max(0, graceMs);
  while (alive(pid) && Date.now() < deadline) {
    await sleep(OWNER_KILL_POLL_MS);
  }
  if (!alive(pid)) {
    return { terminated: true, skipped: false, escalated: false };
  }
  signalGroupThenPid("SIGKILL");
  const killDeadline = Date.now() + Math.max(graceMs, 500);
  while (alive(pid) && Date.now() < killDeadline) {
    await sleep(OWNER_KILL_POLL_MS);
  }
  return { terminated: !alive(pid), skipped: false, escalated: true };
}

/**
 * Atomically fence an active run from further owner writes, complete all
 * cancellation cleanup, and then terminate any surviving owner process group.
 * Both `cancel` and `down` use this composition so owner liveness races have a
 * single claim/termination policy.
 *
 * @param {SmithersDb} adapter
 * @param {Pick<RunRow, "runId" | "runtimeOwnerId">} run
 * @param {{ now?: number; terminateOwner?: typeof terminateRunOwner; ownerKillGraceMs?: number }} [options]
 */
export async function finalizeCancelledOwnedRun(adapter, run, options = {}) {
  const cancellation = await finalizeCancelledRun(adapter, run.runId, { now: options.now });
  const ownerPid = parseRuntimeOwnerPid(run.runtimeOwnerId);
  let ownerTerminated = false;
  if (cancellation.won && ownerPid !== null && isPidAlive(ownerPid)) {
    const termination = await (options.terminateOwner ?? terminateRunOwner)(ownerPid, {
      graceMs: options.ownerKillGraceMs,
    });
    ownerTerminated = termination.terminated;
  }
  return { cancellation, ownerPid, ownerTerminated };
}

/**
 * Collapse an error (and its cause chain) into searchable text so
 * missing-table detection sees the driver's message wherever a wrapper
 * buried it.
 *
 * @param {unknown} error
 * @returns {string}
 */
function collectErrorText(error) {
  const parts = [];
  let current = error;
  for (let hops = 0; current != null && hops < 8; hops++) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = /** @type {{ cause?: unknown }} */ (current).cause;
  }
  return parts.join(" ");
}

/**
 * Branch label the engine stamps on a continue-as-new handoff
 * (packages/engine/src/engine.js). A continuation reuses the fork plumbing —
 * it writes a `_smithers_branches` row too — but it is NOT an independent
 * branch: it is the SAME logical run carrying on in a fresh segment, so cancel
 * MUST still reach it. Only genuine time-travel forks are spared.
 */
const CONTINUE_AS_NEW_LABEL = "continue-as-new";

/**
 * Which of `runIds` are time-travel FORKS — runs with a `_smithers_branches`
 * row keyed by their own run id, EXCLUDING continue-as-new continuations.
 * `parent_run_id` on `_smithers_runs` is overloaded: child workflows, forks,
 * and continuations all point at the run that spawned them. A fork is an
 * independent branch of history, not a lifecycle child, so the cascade must
 * never sweep it — but a continuation is the run itself, so the cascade must.
 *
 * A DB that never used time travel has no `_smithers_branches` table at all;
 * that is legitimately "no forks" (SQLite: "no such table", Postgres/PGlite:
 * `relation ... does not exist`), never a fault. Any other error stays fatal.
 *
 * @param {SmithersDb} adapter
 * @param {readonly string[]} runIds
 * @returns {Promise<Set<string>>}
 */
async function listForkRunIds(adapter, runIds) {
  if (runIds.length === 0) {
    return new Set();
  }
  const placeholders = runIds.map(() => "?").join(", ");
  try {
    const rows = /** @type {{ runId: string }[]} */ (
      await adapter.internalStorage.queryAll(
        `SELECT run_id FROM _smithers_branches WHERE run_id IN (${placeholders}) AND (branch_label IS NULL OR branch_label <> ?)`,
        [...runIds, CONTINUE_AS_NEW_LABEL],
      )
    );
    return new Set(rows.map((row) => row.runId));
  } catch (error) {
    if (/no such table|does not exist/i.test(collectErrorText(error))) {
      return new Set();
    }
    throw error;
  }
}

/**
 * The lineage a cancel of `rootRunId` will actually reach: its descendants with
 * every fork subtree pruned out. Callers that need to reason about what a
 * cascade WILL do (e.g. the CLI's terminal-root pre-check, which decides between
 * RUN_NOT_ACTIVE and finishing an interrupted cascade) must use this rather than
 * a raw listRunDescendants, or they will count a fork — which the cascade spares
 * — as work still to do, and report success while cancelling nothing.
 *
 * @param {SmithersDb} adapter
 * @param {string} rootRunId
 * @returns {Promise<{ runId: string; parentRunId: string | null; depth: number }[]>}
 */
export async function listCascadeLineage(adapter, rootRunId) {
  return pruneForkSubtrees(adapter, await adapter.listRunDescendants(rootRunId));
}

/**
 * Drop every fork subtree from a listRunDescendants result: a descendant that
 * is a fork is pruned together with everything beneath it. The root (depth 0)
 * is never checked — explicitly cancelling a fork BY ID must still cancel it.
 * Rows arrive depth-ascending, so a parent's verdict always precedes its
 * children's.
 *
 * @param {SmithersDb} adapter
 * @param {{ runId: string; parentRunId: string | null; depth: number }[]} rows
 * @returns {Promise<{ runId: string; parentRunId: string | null; depth: number }[]>}
 */
async function pruneForkSubtrees(adapter, rows) {
  const forkIds = await listForkRunIds(
    adapter,
    rows.filter((row) => row.depth > 0).map((row) => row.runId),
  );
  if (forkIds.size === 0) {
    return rows;
  }
  const prunedIds = new Set();
  return rows.filter((row) => {
    if (row.depth > 0 && (forkIds.has(row.runId) || (row.parentRunId !== null && prunedIds.has(row.parentRunId)))) {
      prunedIds.add(row.runId);
      return false;
    }
    return true;
  });
}

/**
 * @typedef {{
 *   runId: string;
 *   depth: number;
 *   action: "cancel-requested" | "cancelled" | "already-terminal" | "missing";
 *   ownerPid: number | null;
 *   ownerTerminated: boolean;
 * }} CascadeRunOutcome
 */
/**
 * @typedef {{
 *   root: CascadeRunOutcome | null;
 *   descendants: CascadeRunOutcome[];
 *   cancelledAttempts: number;
 *   terminatedOwners: { runId: string; pid: number }[];
 * }} CascadeCancelSummary
 */

/**
 * Cancel a run AND every transitive child-workflow descendant (runs whose
 * parent_run_id chain leads back to it), then clean up dead-engine owner
 * processes. Time-travel forks also carry parent_run_id, but a fork is an
 * independent branch of history, not a lifecycle child: fork subtrees are
 * pruned from every discovery pass and survive the cascade. A fork given
 * explicitly as the root is still cancelled.
 *
 * Per run:
 * - live running (fresh heartbeat) → durable cancel request; its engine aborts
 *   agents and writes the terminal status itself. The owner process is left
 *   alone so it can shut down gracefully.
 * - stale running / waiting-* / paused → direct flip to cancelled; if the
 *   recorded owner pid is still alive (hung engine, parked detached owner) its
 *   process group is terminated.
 * - already terminal → skipped (idempotent).
 *
 * Race hardening: descendants are re-discovered after each pass so children
 * spawned while the cascade ran are caught; runs are re-read right before
 * acting so one that finished (or was cancelled concurrently) in the window
 * since discovery is skipped instead of clobbered.
 *
 * @param {SmithersDb} adapter
 * @param {string} rootRunId
 * @param {{ now?: () => number; heartbeatFresh?: (run: RunRow) => boolean; terminateOwner?: typeof terminateRunOwner; ownerKillGraceMs?: number }} [options]
 * @returns {Promise<CascadeCancelSummary>}
 */
export async function cascadeCancelRun(adapter, rootRunId, options = {}) {
  const now = options.now ?? (() => Date.now());
  const heartbeatFresh = options.heartbeatFresh ?? ((run) => isRunHeartbeatFresh(run));
  const terminateOwner = options.terminateOwner ?? terminateRunOwner;
  /** @type {CascadeCancelSummary} */
  const summary = { root: null, descendants: [], cancelledAttempts: 0, terminatedOwners: [] };
  const processed = new Set();
  /**
   * @param {string} runId
   * @param {number} depth
   * @returns {Promise<void>}
   */
  const cancelOne = async (runId, depth) => {
    // Re-read at action time: the status recorded at discovery time may be
    // stale (the run can finish, or a concurrent cancel can win, in between).
    const run = await adapter.getRun(runId);
    /** @type {CascadeRunOutcome} */
    const outcome = { runId, depth, action: "missing", ownerPid: null, ownerTerminated: false };
    if (depth === 0) summary.root = outcome;
    else summary.descendants.push(outcome);
    if (!run) return;
    const repairableTerminal = run.status === "cancelled" || run.status === "canceled";
    if (!isCancellableRunStatus(run.status) && !repairableTerminal) {
      outcome.action = "already-terminal";
      return;
    }
    const wasFresh = run.status === "running" && heartbeatFresh(run);
    // Preserve the discovery probe used by launch-race tests and give a
    // live owner one last chance to publish an attempt before the durable
    // cancellation claim fences it out.
    await adapter.listInProgressAttempts(runId);
    const activeAttempts = await adapter.listAttemptsForRun(runId);
    const activeCount = activeAttempts.filter((attempt) =>
      ["in-progress", "waiting-approval", "waiting-event", "waiting-timer", "waiting-quota"].includes(attempt.state),
    ).length;
    if (wasFresh) {
      const requested = await adapter.requestRunCancel(runId, now());
      if (requested) {
        outcome.action = "cancel-requested";
        return;
      }
    }
    const ownedResult = await finalizeCancelledOwnedRun(adapter, run, {
      now: now(),
      terminateOwner,
      ownerKillGraceMs: options.ownerKillGraceMs,
    });
    const result = ownedResult.cancellation;
    if (result.won || result.repaired) summary.cancelledAttempts += activeCount;
    outcome.action = result.won || result.repaired ? "cancelled" : "already-terminal";
    // No live engine should own this run any more; an alive owner pid is a
    // hung engine or a parked detached owner — terminate its process group
    // so its agent processes stop burning tokens.
    if (ownedResult.ownerPid !== null) {
      outcome.ownerPid = ownedResult.ownerPid;
    }
    outcome.ownerTerminated = ownedResult.ownerTerminated;
    if (ownedResult.ownerTerminated && ownedResult.ownerPid !== null) {
      summary.terminatedOwners.push({ runId, pid: ownedResult.ownerPid });
    }
  };
  for (let pass = 0; pass < MAX_CASCADE_DISCOVERY_PASSES; pass++) {
    const rows = await adapter.listRunDescendants(rootRunId);
    // Re-pruned every pass so a fork created mid-cascade is spared too.
    const lineage = await pruneForkSubtrees(adapter, rows);
    const pending = lineage.filter((row) => !processed.has(row.runId));
    if (pass > 0 && pending.length === 0) break;
    for (const row of pending) {
      processed.add(row.runId);
      await cancelOne(row.runId, row.depth);
    }
    if (rows.length === 0) {
      // Root not persisted (deleted mid-flight): record the miss and stop.
      if (summary.root === null) {
        await cancelOne(rootRunId, 0);
      }
      break;
    }
  }
  return summary;
}
