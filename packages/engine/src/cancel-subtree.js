// Transactional recursive subtree cancellation (#971, #972).
//
// One operation cancels a run and every transitive lifecycle descendant, then
// makes sure nothing from that subtree outlives it: detached owner processes
// and the agent process trees they spawned are terminated by pid through
// `@smthrs/driver`'s process-tree killer.
//
// It lives here — not in the CLI — because the gateway's public
// HTTP/RPC `cancelRun`, `smithers cancel`, and `smithers down` must all share
// exactly one claim/termination policy. Every step is idempotent: re-running
// the operation only touches survivors.

import { killProcessTree } from "@smthrs/driver/child-process";
import { isPidAlive, parseRuntimeOwnerPid } from "./runtime-owner.js";
import { finalizeCancelledRun, isRunHeartbeatFresh } from "./engine.js";

/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smthrs/db/adapter").RunRow} RunRow */
/** @typedef {import("@smthrs/observability").RunCancellationSource} RunCancellationSource */

/**
 * Statuses cancellation can act on. Everything else (finished, failed,
 * continued) is terminal and skipped, which is what makes the operation
 * idempotent.
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
 * bounded so a pathological spawner cannot wedge the caller.
 */
const MAX_CASCADE_DISCOVERY_PASSES = 5;
const DEFAULT_OWNER_KILL_GRACE_MS = 2_000;
/** Agents are leaves — they get a shorter window than a run owner. */
const DEFAULT_AGENT_KILL_GRACE_MS = 1_000;

/**
 * @param {string | null | undefined} status
 * @returns {boolean}
 */
export function isCancellableRunStatus(status) {
  return typeof status === "string" && CANCELLABLE_RUN_STATUSES.has(status);
}

/**
 * Terminate a detached run owner process and, where possible, its whole
 * process tree (agent CLIs spawned by the engine live under it).
 *
 * Delegates to `@smthrs/driver`'s `killProcessTree`, so owner termination,
 * agent termination, and in-process `killChildTree` all use one implementation
 * — including the win32 `taskkill /T /F` path, which is the only way to reach
 * grandchildren on a platform without process groups.
 *
 * @param {number | null} pid
 * @param {Parameters<typeof killProcessTree>[1]} [options]
 * @returns {Promise<{ terminated: boolean; skipped: boolean; escalated: boolean }>}
 */
export function terminateRunOwner(pid, options = {}) {
  return killProcessTree(pid, { graceMs: DEFAULT_OWNER_KILL_GRACE_MS, ...options });
}

/**
 * Kill every agent process registered for `runIds` and drop its registry row.
 *
 * The generic orphan sweep deliberately spares agents whose engine pid is
 * still alive. That is wrong for cancellation: a hung-but-alive engine owning
 * a run we just fenced cancelled must not keep its agents burning tokens. Here
 * the run rows are already terminal, so every registered agent for them is by
 * definition unsupervised and is killed by process tree, then verified gone.
 *
 * Scoped strictly to the cancelled subtree — unrelated runs' agents are never
 * touched.
 *
 * @param {SmithersDb} adapter
 * @param {Iterable<string>} runIds
 * @param {{ killTree?: typeof killProcessTree; agentKillGraceMs?: number; alive?: (pid: number) => boolean }} [options]
 * @returns {Promise<{ terminatedAgents: { runId: string | null; pid: number }[]; survivingAgents: number }>}
 */
export async function terminateSubtreeAgentProcesses(adapter, runIds, options = {}) {
  const targets = new Set(runIds);
  /** @type {{ terminatedAgents: { runId: string | null; pid: number }[]; survivingAgents: number }} */
  const result = { terminatedAgents: [], survivingAgents: 0 };
  if (targets.size === 0 || typeof adapter.listAgentProcesses !== "function") return result;
  const killTree = options.killTree ?? killProcessTree;
  const alive = options.alive ?? isPidAlive;
  /** @type {Array<Record<string, unknown>>} */
  let rows;
  try {
    rows = await adapter.listAgentProcesses();
  } catch {
    // Registry missing (pre-0036 store) or unreadable: nothing to reap.
    return result;
  }
  const candidates = (rows ?? []).flatMap((row) => {
    const pid = Number(row?.pid);
    const runId = typeof row?.runId === "string" ? row.runId : null;
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return [];
    if (runId === null || !targets.has(runId)) return [];
    return [{ pid, runId }];
  });
  await Promise.all(
    candidates.map(async ({ pid, runId }) => {
      const wasAlive = alive(pid);
      if (wasAlive) {
        const outcome = await killTree(pid, { graceMs: options.agentKillGraceMs ?? DEFAULT_AGENT_KILL_GRACE_MS });
        // Verified reaping: only a pid that is actually gone counts.
        if (outcome.terminated || !alive(pid)) {
          result.terminatedAgents.push({ pid, runId });
        } else {
          result.survivingAgents += 1;
          return;
        }
      }
      try {
        await adapter.unregisterAgentProcess(pid);
      } catch {
        /* best effort: the row is reclaimed by the next sweep */
      }
    }),
  );
  return result;
}

/**
 * Atomically fence an active run from further owner writes, complete all
 * cancellation cleanup, and then terminate any surviving owner process tree
 * plus the run's registered agent processes.
 *
 * @param {SmithersDb} adapter
 * @param {Pick<RunRow, "runId" | "runtimeOwnerId">} run
 * @param {{
 *   now?: number;
 *   terminateOwner?: typeof terminateRunOwner;
 *   ownerKillGraceMs?: number;
 *   agentKillGraceMs?: number;
 *   attribution?: RunCancellationSource;
 *   reapAgents?: boolean;
 * }} [options]
 */
export async function finalizeCancelledOwnedRun(adapter, run, options = {}) {
  const cancellation = await finalizeCancelledRun(adapter, run.runId, {
    now: options.now,
    attribution: options.attribution,
  });
  const ownerPid = parseRuntimeOwnerPid(run.runtimeOwnerId);
  let ownerTerminated = false;
  if (cancellation.won && ownerPid !== null && isPidAlive(ownerPid)) {
    const termination = await (options.terminateOwner ?? terminateRunOwner)(ownerPid, {
      graceMs: options.ownerKillGraceMs,
    });
    ownerTerminated = termination.terminated;
  }
  // Agent CLIs are spawned as their own process-group leaders, so the owner
  // tree kill above no longer reaches them on POSIX. The run row is fenced
  // terminal at this point, so every agent still registered against it is
  // unsupervised: kill it by process tree and verify it is gone.
  let agents = { terminatedAgents: /** @type {{ runId: string | null; pid: number }[]} */ ([]), survivingAgents: 0 };
  if ((cancellation.won || cancellation.repaired) && options.reapAgents !== false) {
    agents = await terminateSubtreeAgentProcesses(adapter, [run.runId], {
      agentKillGraceMs: options.agentKillGraceMs,
    }).catch(() => agents);
  }
  return { cancellation, ownerPid, ownerTerminated, agents };
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
 *   terminatedAgents: { runId: string | null; pid: number }[];
 *   survivingAgents: number;
 * }} CascadeCancelSummary
 */

/**
 * Cancel a run AND every transitive child-workflow descendant (runs whose
 * parent_run_id chain leads back to it), then clean up owner and agent
 * processes. Time-travel forks also carry parent_run_id, but a fork is an
 * independent branch of history, not a lifecycle child: fork subtrees are
 * pruned from every discovery pass and survive the cascade. A fork given
 * explicitly as the root is still cancelled.
 *
 * Per run:
 * - live running (fresh heartbeat) → durable cancel request; its engine's
 *   cancel watcher observes it — in THIS process or any detached one — and
 *   aborts the run and its in-flight agents itself. The owner process is left
 *   alone so it can shut down gracefully.
 * - stale running / waiting-* / paused / ownerless → direct flip to cancelled;
 *   if the recorded owner pid is still alive (hung engine, parked detached
 *   owner) its process tree is terminated.
 * - already terminal → skipped (idempotent).
 *
 * Race hardening: descendants are re-discovered after each pass so children
 * spawned while the cascade ran are caught; runs are re-read right before
 * acting so one that finished (or was cancelled concurrently) in the window
 * since discovery is skipped instead of clobbered. Concurrent cancellers are
 * safe because every terminal transition goes through the single-winner
 * `claimRunCancellation` compare-and-set.
 *
 * A final reaping pass covers the whole subtree once the last row is fenced,
 * so an agent registered by a run in the window between its own cancellation
 * and the end of the cascade does not survive.
 *
 * @param {SmithersDb} adapter
 * @param {string} rootRunId
 * @param {{
 *   now?: () => number;
 *   heartbeatFresh?: (run: RunRow) => boolean;
 *   terminateOwner?: typeof terminateRunOwner;
 *   ownerKillGraceMs?: number;
 *   agentKillGraceMs?: number;
 *   attribution?: RunCancellationSource;
 *   reapAgents?: boolean;
 * }} [options]
 * @returns {Promise<CascadeCancelSummary>}
 */
export async function cancelRunSubtree(adapter, rootRunId, options = {}) {
  const now = options.now ?? (() => Date.now());
  const heartbeatFresh = options.heartbeatFresh ?? ((run) => isRunHeartbeatFresh(run));
  const terminateOwner = options.terminateOwner ?? terminateRunOwner;
  /** @type {CascadeCancelSummary} */
  const summary = {
    root: null,
    descendants: [],
    cancelledAttempts: 0,
    terminatedOwners: [],
    terminatedAgents: [],
    survivingAgents: 0,
  };
  const processed = new Set();
  /** Runs this cascade drove to a terminal cancelled state (agent reap scope). */
  const fenced = new Set();
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
    const ownerPid = parseRuntimeOwnerPid(run.runtimeOwnerId);
    const ownerIsKnownDead = ownerPid !== null && !isPidAlive(ownerPid);
    // Preserve the discovery probe used by launch-race tests and give a
    // live owner one last chance to publish an attempt before the durable
    // cancellation claim fences it out.
    await adapter.listInProgressAttempts(runId);
    const activeAttempts = await adapter.listAttemptsForRun(runId);
    const activeCount = activeAttempts.filter((attempt) =>
      ["in-progress", "waiting-approval", "waiting-event", "waiting-timer", "waiting-quota"].includes(attempt.state),
    ).length;
    if (wasFresh && !ownerIsKnownDead) {
      const requested = await adapter.requestRunCancel(runId, now(), options.attribution);
      if (requested) {
        outcome.action = "cancel-requested";
        return;
      }
    }
    const ownedResult = await finalizeCancelledOwnedRun(adapter, run, {
      now: now(),
      terminateOwner,
      ownerKillGraceMs: options.ownerKillGraceMs,
      agentKillGraceMs: options.agentKillGraceMs,
      attribution: run.cancelRequestedAtMs == null ? options.attribution : undefined,
      // The whole subtree is reaped once at the end; skip the per-run sweep
      // so a wide fan-out does not pay a grace window per row.
      reapAgents: false,
    });
    const result = ownedResult.cancellation;
    if (result.won || result.repaired) {
      summary.cancelledAttempts += activeCount;
      fenced.add(runId);
    }
    outcome.action = result.won || result.repaired ? "cancelled" : "already-terminal";
    // No live engine should own this run any more; an alive owner pid is a
    // hung engine or a parked detached owner — terminate its process tree
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
  if (options.reapAgents !== false && fenced.size > 0) {
    const agents = await terminateSubtreeAgentProcesses(adapter, fenced, {
      agentKillGraceMs: options.agentKillGraceMs,
    }).catch(() => null);
    if (agents) {
      summary.terminatedAgents = agents.terminatedAgents;
      summary.survivingAgents = agents.survivingAgents;
    }
  }
  return summary;
}
