/** Settle a stopped force simulation in yielding batches, without intermediate paints. */

/** The slice of `d3.Simulation` settling drives. */
type SettleTarget = {
  tick: (iterations?: number) => unknown;
  stop: () => unknown;
};

/** Wall-clock target for one batch of ticks: half a 16 ms frame. */
const SETTLE_BUDGET_MS = 8;

/** Deadline handed to `requestIdleCallback` so an idle-starved tab still settles. */
const SETTLE_IDLE_TIMEOUT_MS = 50;

type SettleSimulationOptions = {
  /** Total ticks to run before the layout counts as settled. */
  ticks: number;
  /** Per-batch wall-clock budget. Defaults to {@link SETTLE_BUDGET_MS}. */
  budgetMs?: number;
  /** Clock seam. Defaults to `performance.now` (`Date.now` without one). */
  now?: () => number;
  /**
   * Yield seam: run the callback in a later task and return its canceller.
   * Defaults to `requestIdleCallback`, falling back to `setTimeout`.
   */
  schedule?: (run: () => void) => () => void;
  /** Called once, after the last tick. Never called after cancel. */
  onSettled: () => void;
};

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function defaultSchedule(run: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(() => run(), { timeout: SETTLE_IDLE_TIMEOUT_MS });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(run, 0);
  return () => clearTimeout(handle);
}

/**
 * Ticks `sim` to settlement in budgeted batches, starting synchronously so a
 * small graph still settles before the first paint. Returns a canceller for
 * unmount or a graph change; cancelling suppresses `onSettled`.
 */
export function settleSimulation(sim: SettleTarget, options: SettleSimulationOptions): () => void {
  const { ticks, budgetMs = SETTLE_BUDGET_MS, now = defaultNow, schedule = defaultSchedule, onSettled } = options;
  // Manual tick() does not stop d3's automatic timer. Stop it before yielding
  // so only the budgeted batches advance the layout.
  sim.stop();
  let remaining = ticks;
  let cancelled = false;
  let cancelScheduled: (() => void) | null = null;

  const runBatch = () => {
    cancelScheduled = null;
    if (cancelled) return;
    const started = now();
    // At least one tick per batch: a single tick can outrun the budget on a
    // large vault, and a batch that ticks nothing would never settle.
    do {
      sim.tick(1);
      remaining -= 1;
    } while (remaining > 0 && now() - started < budgetMs);
    if (remaining > 0) {
      cancelScheduled = schedule(runBatch);
      return;
    }
    onSettled();
  };

  if (remaining > 0) runBatch();
  else {
    onSettled();
  }

  return () => {
    cancelled = true;
    cancelScheduled?.();
    cancelScheduled = null;
  };
}
