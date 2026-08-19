/**
 * The run-driver sweep that replaces the supervisor's claim-by-proxy process.
 *
 * Spec 1.4 of `.smithers/specs/flows-migration.md` retires
 * `apps/cli/src/supervisor.js`'s claim-by-proxy. flows' §8 explains why the
 * replacement is not another standalone claimer: resumption needs a live
 * process that holds the flow bodies, so a sweeper owning no registrations can
 * only move a row from one parked state to another. The sweep therefore does
 * one thing — notice a row that needs driving and start a process that can
 * drive it — and leaves ownership to the ordinary claim path inside that
 * process.
 *
 * What is gone versus the legacy poll:
 *
 * - No `supervisor:<id>#aN` claim owner is stamped on the row. The legacy path
 *   claimed a run on the resumed process's behalf, encoded the consecutive
 *   failed-resume count in the owner string, and had to release the claim by
 *   hand when the spawn failed. The resumed engine claims for itself.
 * - No pid probing. A lease outside the staleness window is stale; flows'
 *   analysis rejects the pid-verified owner check explicitly.
 * - No per-reason candidate processors. `waiting-timer`, `waiting-quota`, and
 *   the released rows are all the same taxonomy now, so one sweep covers them.
 *
 * What is NOT gone is the give-up guard the claim encoded. Dropping the claim
 * drops the place the attempt count was stored, not the reason it existed: a
 * resume that dies before claiming (workflow import error, claim race, a CLI
 * that takes ~35s to start against a 10s poll) leaves the row exactly as the
 * sweep found it, so the next tick sees the same candidate and spawns again.
 * The count moves into {@link createResumeAttemptLedger}, keyed by the row
 * state a successful resume would change, and the give-up decision stays the
 * legacy one: after `maxResumeAttempts` the run is marked failed with
 * `AUTO_RESUME_GAVE_UP` and reported in `gaveUpRunIds`.
 *
 * @typedef {import("./ResumeTarget.ts").ResumeTarget} ResumeTarget
 * @typedef {import("./SupervisorPollSummary.ts").SupervisorPollSummary} SupervisorPollSummary
 * @typedef {import("@smthrs/engine/sweep/createRunDriverSweep").SweepCandidate} SweepCandidate
 */
import { Effect } from "effect";
import { createRunDriverSweep } from "@smthrs/engine/sweep/createRunDriverSweep";
import { readWaitingAnnotation } from "@smthrs/engine/waiting/readWaitingAnnotation";
import { resumeRunDetached, resumeRunDetachedLogFile } from "./resume-detached.js";
import { resolveResumeTarget } from "./resume-target.js";

/** Consecutive spawns that die before the engine claims, before giving up. */
export const DEFAULT_SWEEP_MAX_RESUME_ATTEMPTS = 3;
/**
 * How long a spawned resume gets to change the row before the sweep counts it
 * as another attempt. A cold `smithers up --resume` can take tens of seconds
 * to reach its claim, and the poll interval is 10s, so without this the sweep
 * would spawn three processes for one still-starting resume and give up on a
 * run that was about to come back.
 */
export const DEFAULT_SWEEP_RESUME_GRACE_MS = 120_000;

/**
 * The row state a successful resume changes.
 *
 * A resume that reaches its claim moves the run to `running` under a new
 * owner and heartbeat; a due wake stops being due. So an unchanged signature
 * across ticks means the last spawn accomplished nothing, and that is exactly
 * what the attempt count counts. Anything else — a new heartbeat, a new
 * status, a re-parked run with a later deadline — is progress and resets it.
 * @param {SweepCandidate} candidate
 */
function candidateSignature(candidate) {
  return [
    candidate.kind,
    candidate.status ?? "",
    candidate.heartbeatAtMs ?? "",
    candidate.annotation?.wakeAt ?? "",
  ].join("|");
}

/**
 * The in-process replacement for the `supervisor:<id>#aN` owner suffix.
 *
 * In-process is the honest scope: it is what one supervisor knows about the
 * spawns it made. It does not need to survive a restart, because the give-up
 * it guards is durable — the run is marked failed — and a restarted supervisor
 * that has forgotten an in-flight attempt costs one extra spawn, not a loop.
 *
 * @param {{ maxAttempts?: number; graceMs?: number }} [options]
 */
export function createResumeAttemptLedger(options = {}) {
  const maxAttempts = options.maxAttempts ?? DEFAULT_SWEEP_MAX_RESUME_ATTEMPTS;
  const graceMs = options.graceMs ?? DEFAULT_SWEEP_RESUME_GRACE_MS;
  /** @type {Map<string, { signature: string; attempts: number; lastSpawnAtMs: number; gaveUp: boolean }>} */
  const entries = new Map();

  return {
    maxAttempts,
    graceMs,
    /**
     * What this tick may do with a candidate.
     *
     * - `spawn` — new, or the last spawn's grace has elapsed with the row
     *   unchanged and attempts left.
     * - `cooldown` — a spawn from a recent tick may still be starting up.
     * - `give-up` — `maxAttempts` spawns changed nothing.
     *
     * @param {SweepCandidate} candidate
     * @param {number} nowMs
     * @returns {{ decision: "spawn" | "cooldown" | "give-up"; attempts: number }}
     */
    admit(candidate, nowMs) {
      const signature = candidateSignature(candidate);
      const entry = entries.get(candidate.runId);
      if (!entry || entry.signature !== signature) {
        entries.set(candidate.runId, { signature, attempts: 0, lastSpawnAtMs: 0, gaveUp: false });
        return { decision: "spawn", attempts: 0 };
      }
      if (entry.gaveUp) return { decision: "give-up", attempts: entry.attempts };
      if (entry.attempts >= maxAttempts) return { decision: "give-up", attempts: entry.attempts };
      if (nowMs - entry.lastSpawnAtMs < graceMs) return { decision: "cooldown", attempts: entry.attempts };
      return { decision: "spawn", attempts: entry.attempts };
    },
    /**
     * @param {SweepCandidate} candidate
     * @param {number} nowMs
     */
    recordSpawn(candidate, nowMs) {
      const signature = candidateSignature(candidate);
      const entry = entries.get(candidate.runId) ?? { signature, attempts: 0, lastSpawnAtMs: 0, gaveUp: false };
      entry.signature = signature;
      entry.attempts += 1;
      entry.lastSpawnAtMs = nowMs;
      entries.set(candidate.runId, entry);
    },
    /** @param {string} runId */
    recordGaveUp(runId) {
      const entry = entries.get(runId);
      if (entry) entry.gaveUp = true;
    },
    /** @param {string} runId */
    forget(runId) {
      entries.delete(runId);
    },
  };
}

/** @typedef {ReturnType<typeof createResumeAttemptLedger>} ResumeAttemptLedger */

/**
 * One ledger per supervisor identity, so consecutive `runDriverSweepPoll`
 * ticks from the same loop share an attempt count without the loop having to
 * thread one through.
 * @type {Map<string, ResumeAttemptLedger>}
 */
const ledgersBySupervisorId = new Map();

/**
 * @param {string} supervisorId
 * @param {{ maxAttempts?: number; graceMs?: number }} options
 * @returns {ResumeAttemptLedger}
 */
function ledgerFor(supervisorId, options) {
  let ledger = ledgersBySupervisorId.get(supervisorId);
  if (!ledger) {
    ledger = createResumeAttemptLedger(options);
    ledgersBySupervisorId.set(supervisorId, ledger);
  }
  return ledger;
}

/** Test seam: drop every process-wide ledger. */
export function resetResumeAttemptLedgers() {
  ledgersBySupervisorId.clear();
}

/**
 * Mark a run failed the way the legacy give-up did, so the row stops being a
 * sweep candidate and says why in a form an operator can act on.
 *
 * @param {import("@smthrs/db/adapter").SmithersDb} adapter
 * @param {SweepCandidate} candidate
 * @param {ResumeTarget | null} target
 * @param {number} attempts
 * @param {number} nowMs
 * @returns {Promise<boolean>}
 */
async function markGaveUp(adapter, candidate, target, attempts, nowMs) {
  const logFile = target ? resumeRunDetachedLogFile(target, candidate.runId) : null;
  const errorInfo = {
    name: "SmithersError",
    code: "AUTO_RESUME_GAVE_UP",
    message:
      `Auto-resume failed ${attempts} consecutive times: each detached resume died before the engine claimed the run. ` +
      (logFile ? `Check the resume log at ${logFile}, fix the startup failure, ` : "") +
      `then resume manually: smithers up --resume --run-id ${candidate.runId} --force`,
    details: {
      attempts,
      sweepKind: candidate.kind,
      parkedStatus: candidate.status,
      ...(candidate.annotation ? { waiting: candidate.annotation } : {}),
      ...(logFile ? { logFile } : {}),
    },
  };
  const errorJson = JSON.stringify(errorInfo);
  const failed = await Effect.runPromise(
    adapter.updateRunIfNotCancelled(candidate.runId, {
      status: "failed",
      finishedAtMs: nowMs,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      errorJson,
    }),
  ).catch(() => false);
  if (!failed) return false;
  await Effect.runPromise(
    adapter.insertEventWithNextSeqEffect({
      runId: candidate.runId,
      timestampMs: nowMs,
      type: "RunFailed",
      payloadJson: JSON.stringify({
        type: "RunFailed",
        runId: candidate.runId,
        error: errorInfo,
        timestampMs: nowMs,
      }),
    }),
  ).catch(() => {});
  return true;
}

/**
 * A sweep tick, expressed against the same options shape the legacy poll takes
 * so `smithers supervise` can route to either.
 *
 * @param {{
 *   adapter: import("@smthrs/db/adapter").SmithersDb;
 *   runIds?: ReadonlySet<string> | null;
 *   staleThresholdMs?: number;
 *   maxConcurrent?: number;
 *   maxResumeAttempts?: number;
 *   resumeGraceMs?: number;
 *   supervisorId?: string;
 *   ledger?: ResumeAttemptLedger;
 *   dryRun?: boolean;
 *   deps?: {
 *     now?: () => number;
 *     workflowExists?: (path: string) => boolean;
 *     spawnResumeDetached?: (target: ResumeTarget, runId: string) => unknown;
 *   };
 * }} options
 * @returns {Promise<SupervisorPollSummary>}
 */
export async function runDriverSweepPoll(options) {
  const now = options.deps?.now ?? (() => Date.now());
  const workflowExists = options.deps?.workflowExists ?? ((path) => path.length > 0);
  const spawnResumeDetached =
    options.deps?.spawnResumeDetached ?? ((target, runId) => resumeRunDetached(target, runId));
  const inScope = (runId) => options.runIds == null || options.runIds.has(runId);
  const ledger =
    options.ledger ??
    ledgerFor(options.supervisorId ?? "default", {
      maxAttempts: options.maxResumeAttempts,
      graceMs: options.resumeGraceMs,
    });

  const startedAtMs = now();
  /** @type {string[]} */
  const wouldResumeRunIds = [];
  /** @type {string[]} */
  const skippedRunIds = [];
  /** @type {string[]} */
  const gaveUpRunIds = [];

  const sweep = createRunDriverSweep({
    adapter: options.adapter,
    nowMs: now,
    staleAfterMs: options.staleThresholdMs,
    batch: options.maxConcurrent,
    async drive(candidate) {
      if (!inScope(candidate.runId)) {
        skippedRunIds.push(candidate.runId);
        return;
      }
      const run = await Effect.runPromise(options.adapter.getRun(candidate.runId));
      const target = run ? resolveResumeTarget(run, { workflowExists }) : null;
      if (!target) {
        // Nothing in this process can drive the row. Leave it parked for a
        // worker that can, rather than churning it — flows' unregistered-flow
        // warning, expressed against Smithers' workflow files.
        skippedRunIds.push(candidate.runId);
        return;
      }
      const tickMs = now();
      const admission = ledger.admit(candidate, tickMs);
      if (admission.decision === "give-up") {
        skippedRunIds.push(candidate.runId);
        if (options.dryRun) return;
        // Only the first tick that reaches the cap does the durable write; the
        // ledger remembers so a store that refused the update is not rewritten
        // on every tick after.
        if (!gaveUpRunIds.includes(candidate.runId)) {
          const marked = await markGaveUp(options.adapter, candidate, target, admission.attempts, tickMs);
          ledger.recordGaveUp(candidate.runId);
          if (marked) gaveUpRunIds.push(candidate.runId);
        }
        return;
      }
      if (admission.decision === "cooldown") {
        // A spawn from a recent tick may still be starting up. Respawning here
        // is the churn loop the claim used to prevent.
        skippedRunIds.push(candidate.runId);
        return;
      }
      if (options.dryRun) {
        wouldResumeRunIds.push(candidate.runId);
        return;
      }
      spawnResumeDetached(target, candidate.runId);
      ledger.recordSpawn(candidate, tickMs);
    },
  });

  const result = await sweep.sweep();
  const resumedCount = result.driven.filter(
    (candidate) =>
      !skippedRunIds.includes(candidate.runId) &&
      !wouldResumeRunIds.includes(candidate.runId) &&
      !gaveUpRunIds.includes(candidate.runId),
  ).length;
  return {
    staleCount: result.scanned,
    resumedCount,
    skippedCount: skippedRunIds.length + result.deferred + result.failures.length,
    durationMs: Math.max(0, now() - startedAtMs),
    wouldResumeRunIds,
    gaveUpRunIds,
  };
}

/**
 * Read back why a run is parked, in taxonomy terms. The sweep decides due-ness
 * from the same annotation, so this is the operator-facing view of the input
 * the sweep acts on.
 * @param {import("@smthrs/db/adapter").SmithersDb} adapter
 * @param {string} runId
 */
export function describeWaiting(adapter, runId) {
  return readWaitingAnnotation(adapter, runId);
}
