/**
 * The run driver's own heartbeat sweep.
 *
 * Spec 1.4 retires `apps/cli/src/supervisor.js`'s claim-by-proxy process. Its
 * replacement is not another standalone app — flows' §8 makes the point that a
 * sweeper owning no flow registrations can only move a row from one parked
 * state to another, so "the process that can make progress is the one that
 * sweeps". This module is that sweep, expressed against Smithers storage and
 * driven by whichever process is already driving runs.
 *
 * Four row classes: the three flows' run driver handles, plus the decided
 * gate the legacy poll scanned for separately.
 *
 * - **stale running**: an owner died without settling the run (SIGKILL, OOM).
 *   Its heartbeat fell outside the staleness window; re-drive it through the
 *   ordinary claim path. Batch capped per tick, oldest heartbeat first, so one
 *   sweep cannot stampede a cold store.
 * - **released**: a run whose owner let it go without settling it (host
 *   shutdown, heartbeat self-interrupt). It holds no lease and carries no
 *   `wakeAt`, so scanning leases and due wakes alone would strand it; the park
 *   site marks it `released` in the journal and the sweep scans for that.
 * - **due wakes**: a park whose `wakeAt` has passed — a timer that fired, a
 *   quota park whose provider reset elapsed.
 * - **decided gates**: an approval or event gate that was decided while the run
 *   was detached. It has no deadline and no release marker, so the two classes
 *   above cannot see it; the legacy poll had a dedicated scan for it and the
 *   sweep keeps that predicate.
 *
 * @typedef {import("../waiting/WaitingAnnotation.ts").WaitingAnnotation} WaitingAnnotation
 * @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb
 */
import { Effect } from "effect";
import { readLatestRunStatusChange, waitingAnnotationForRun } from "../waiting/readWaitingAnnotation.js";

/** Matches the engine's own heartbeat staleness window. */
export const DEFAULT_SWEEP_STALE_AFTER_MS = 30_000;
/** Per-tick cap; the rest wait for the next heartbeat. */
export const DEFAULT_SWEEP_BATCH = 10;
/** Upper bound on rows read per status per tick. */
const SCAN_LIMIT = 500;

/** Statuses a park can be sitting in. */
const WAITING_STATUSES = ["waiting-timer", "waiting-quota", "waiting-event", "waiting-approval"];

/**
 * @typedef {object} SweepCandidate
 * @property {string} runId
 * @property {"stale-running" | "released" | "due-wake" | "decided-gate"} kind
 * @property {string | null} status
 * @property {WaitingAnnotation | null} annotation
 * @property {number | null} heartbeatAtMs
 */

/**
 * @param {{
 *   adapter: SmithersDb;
 *   drive: (candidate: SweepCandidate) => Promise<unknown>;
 *   nowMs?: () => number;
 *   staleAfterMs?: number;
 *   batch?: number;
 *   isOwnerAlive?: (run: Record<string, any>) => boolean;
 * }} options
 */
export function createRunDriverSweep(options) {
  const { adapter, drive } = options;
  const nowMs = options.nowMs ?? (() => Date.now());
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_SWEEP_STALE_AFTER_MS;
  const batch = options.batch ?? DEFAULT_SWEEP_BATCH;
  // No pid probing. A lease that has not been renewed inside the staleness
  // window is stale, full stop; flows' analysis rejects Smithers' pid-verified
  // owner check explicitly, and a caller that still wants one injects it.
  const isOwnerAlive = options.isOwnerAlive ?? (() => false);

  /** @param {string} status */
  const list = (status) =>
    Effect.runPromise(adapter.listRuns(SCAN_LIMIT, status)).catch(() => /** @type {any[]} */ ([]));

  /** @returns {Promise<SweepCandidate[]>} */
  const staleRunning = async () => {
    const cutoff = nowMs() - staleAfterMs;
    const rows = await list("running");
    return rows
      .filter((run) => {
        const heartbeat = Number(run.heartbeatAtMs ?? 0);
        if (Number.isFinite(heartbeat) && heartbeat > cutoff) return false;
        return !isOwnerAlive(run);
      })
      .sort((a, b) => Number(a.heartbeatAtMs ?? 0) - Number(b.heartbeatAtMs ?? 0))
      .map((run) => ({
        runId: String(run.runId),
        kind: /** @type {const} */ ("stale-running"),
        status: run.status ?? null,
        annotation: null,
        heartbeatAtMs: run.heartbeatAtMs ?? null,
      }));
  };

  /**
   * A released row is a `paused` run whose owner let it go without settling
   * it. The run row cannot tell that apart from a human's `smithers pause`:
   * both land on `paused` with `runtimeOwnerId`, `heartbeatAtMs`, and
   * `pauseRequestedAtMs` all cleared. The difference is durable only in the
   * journal, where `finalizeCurrentRunPark` stamps `{ reason: "released" }`
   * on the `RunStatusChanged` entry it emits and the graceful-pause path
   * deliberately does not. A run a human paused therefore stays parked until a
   * human resumes it.
   * @returns {Promise<SweepCandidate[]>}
   */
  const released = async () => {
    const rows = await list("paused");
    /** @type {SweepCandidate[]} */
    const out = [];
    for (const run of rows) {
      if (run.runtimeOwnerId != null) continue;
      if (run.cancelRequestedAtMs != null || run.pauseRequestedAtMs != null) continue;
      const latest = await readLatestRunStatusChange(adapter, String(run.runId));
      // The marker has to be on the entry that produced the current status: an
      // older release the run has since resumed past says nothing about now.
      if (latest?.status !== "paused" || latest.annotation?.reason !== "released") continue;
      out.push({
        runId: String(run.runId),
        kind: /** @type {const} */ ("released"),
        status: run.status ?? null,
        annotation: latest.annotation,
        heartbeatAtMs: run.heartbeatAtMs ?? null,
      });
    }
    return out;
  };

  /**
   * A park whose `wakeAt` has passed. The deadline is read through
   * {@link waitingAnnotationForRun}, which falls back from the run row to the
   * park's journal entry — only quota parks write anything onto the row, so a
   * timer park's deadline lives in the journal and nowhere else. That fallback
   * costs one indexed journal read per parked row, bounded by `SCAN_LIMIT` per
   * status per tick.
   * @returns {Promise<SweepCandidate[]>}
   */
  const dueWakes = async () => {
    const now = nowMs();
    /** @type {SweepCandidate[]} */
    const due = [];
    for (const status of WAITING_STATUSES) {
      for (const run of await list(status)) {
        if (run.cancelRequestedAtMs != null) continue;
        const annotation = await waitingAnnotationForRun(adapter, run);
        if (!annotation?.wakeAt) continue;
        if (annotation.wakeAt > now) continue;
        due.push({
          runId: String(run.runId),
          kind: "due-wake",
          status: run.status ?? null,
          annotation,
          heartbeatAtMs: run.heartbeatAtMs ?? null,
        });
      }
    }
    return due.sort((a, b) => (a.annotation?.wakeAt ?? 0) - (b.annotation?.wakeAt ?? 0));
  };

  /**
   * A gate that was decided while no engine owned the run.
   *
   * An approval decided (or a signal delivered) against a detached run leaves
   * the row parked with no deadline to come due and no release marker: nothing
   * about it is time-based, so neither of the classes above can see it. The
   * predicate is the shipping `listResumableApprovalRunsEffect` — the same one
   * the legacy poll used — so "decided and actionable" keeps one definition.
   * @returns {Promise<SweepCandidate[]>}
   */
  const decidedGates = async () => {
    if (typeof adapter.listResumableApprovalRunsEffect !== "function") return [];
    const staleBeforeMs = nowMs() - staleAfterMs;
    /** @type {SweepCandidate[]} */
    const out = [];
    for (const status of ["waiting-event", "waiting-approval"]) {
      const rows = await Effect.runPromise(
        adapter.listResumableApprovalRunsEffect(/** @type {any} */ (status), staleBeforeMs, SCAN_LIMIT),
      ).catch(() => /** @type {any[]} */ ([]));
      for (const run of rows) {
        if (run.cancelRequestedAtMs != null) continue;
        if (isOwnerAlive(run)) continue;
        out.push({
          runId: String(run.runId),
          kind: /** @type {const} */ ("decided-gate"),
          status: run.status ?? null,
          annotation: await waitingAnnotationForRun(adapter, run),
          heartbeatAtMs: run.heartbeatAtMs ?? null,
        });
      }
    }
    return out;
  };

  return {
    staleRunning,
    released,
    dueWakes,
    decidedGates,
    /**
     * One tick. Returns what it found and what it drove, so a caller can log
     * or assert on it rather than inferring from side effects.
     * @returns {Promise<{ scanned: number; driven: SweepCandidate[]; deferred: number; failures: Array<{ runId: string; error: string }> }>}
     */
    async sweep() {
      const candidates = [
        ...(await staleRunning()),
        ...(await released()),
        ...(await dueWakes()),
        ...(await decidedGates()),
      ];
      // One row can appear in two classes (a released row whose timer is also
      // due); drive it once.
      /** @type {Map<string, SweepCandidate>} */
      const unique = new Map();
      for (const candidate of candidates) {
        if (!unique.has(candidate.runId)) unique.set(candidate.runId, candidate);
      }
      const ordered = [...unique.values()];
      const selected = ordered.slice(0, batch);
      /** @type {SweepCandidate[]} */
      const driven = [];
      /** @type {Array<{ runId: string; error: string }>} */
      const failures = [];
      for (const candidate of selected) {
        try {
          await drive(candidate);
          driven.push(candidate);
        } catch (error) {
          failures.push({
            runId: candidate.runId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return {
        scanned: ordered.length,
        driven,
        deferred: ordered.length - selected.length,
        failures,
      };
    },
  };
}

/** @typedef {ReturnType<typeof createRunDriverSweep>} RunDriverSweep */
