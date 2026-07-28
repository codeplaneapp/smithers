import type { Run } from "./Run.ts";

/**
 * Pure remaining-time estimator for a live run. Ported verbatim from multi's
 * `src/runs/runEta.ts`. Two bases, tried in order:
 *
 * 1. "history"  — historical node durations (cross-run memory) are available:
 *    remaining = mean(nodeDurationsMs) * nodes left.
 * 2. "elapsed"  — no history, but progress exists: extrapolate from the run's
 *    own elapsed rate, remaining = (elapsed / completed) * nodes left.
 * 3. "none"     — neither is derivable. Degrade honestly: no fabricated ETA.
 *
 * Deterministic by construction: `nowMs` is a parameter — this module never
 * reads Date.now(). Negative estimates (clock skew, over-complete counts) are
 * clamped to 0, never surfaced as negative time.
 */

export type RunEtaBasis = "history" | "elapsed" | "none";

export type RunEtaInput = {
  run: Run;
  /** Caller-supplied clock; never read from Date.now() here. */
  nowMs: number;
  /** Progress counts (from runProgress); ratio is carried but not required. */
  progress: { completed: number; total: number; ratio: number | null };
  /** Historical per-node durations from cross-run memory, when available. */
  nodeDurationsMs?: number[];
};

export type RunEtaResult = {
  /** Estimated wall-clock remaining, ms; null when no honest estimate exists. */
  remainingMs: number | null;
  /** Absolute completion time (nowMs + remainingMs); null iff remainingMs is. */
  etaMs: number | null;
  basis: RunEtaBasis;
};

/** Estimate remaining wall-clock time for a run. Pure and deterministic. */
export function runEta(input: RunEtaInput): RunEtaResult {
  const { run, nowMs, progress, nodeDurationsMs } = input;
  const remainingNodes = Math.max(0, progress.total - progress.completed);

  if (nodeDurationsMs && nodeDurationsMs.length > 0) {
    const meanMs = nodeDurationsMs.reduce((sum, ms) => sum + ms, 0) / nodeDurationsMs.length;
    return withEta(Math.max(0, meanMs * remainingNodes), "history", nowMs);
  }

  if (progress.completed > 0 && progress.total > 0) {
    const elapsedMs = nowMs - run.startedAtMs;
    const remainingMs = (elapsedMs / progress.completed) * remainingNodes;
    return withEta(Math.max(0, remainingMs), "elapsed", nowMs);
  }

  return { remainingMs: null, etaMs: null, basis: "none" };
}

function withEta(remainingMs: number, basis: RunEtaBasis, nowMs: number): RunEtaResult {
  return { remainingMs, etaMs: nowMs + remainingMs, basis };
}
