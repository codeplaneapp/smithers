/**
 * Demand-driven governor for run-level task concurrency.
 *
 * The engine caps concurrent task execution at `maxConcurrency` (CLI:
 * `--max-concurrency`, default 4). Workflows that fan out wider than the cap
 * silently queue — a 12-ticket kanban run with 3 reviewers per ticket wants
 * ~16 slots and crawls at 4 with no visible signal. This governor watches
 * slot acquisition and, when the run did NOT explicitly pin the cap, tells
 * the engine to raise it to match observed demand, clamped to a ceiling
 * (env `SMITHERS_AUTO_MAX_CONCURRENCY_CEILING`, default 16). Raises repeat as
 * demand grows but never exceed the ceiling. When the cap is pinned (or the
 * ceiling is exhausted), it instead produces a single human-readable warning
 * per run the first time queued demand reaches the cap itself (i.e. total
 * demand is at least twice the cap), so transient one-off waits stay quiet.
 *
 * Beyond demand, workflows also DECLARE width statically: the engine feeds
 * each extracted graph's widest `<Parallel maxConcurrency>` /
 * `<Parallel subtreeConcurrency>` to `onDeclaredWidth`. A declared width is
 * author intent — unlike demand-driven raises it is NOT clamped to the
 * auto-raise ceiling (a workflow declaring `maxConcurrency={64}` or
 * `subtreeConcurrency={64}` runs 64 wide by default), while demand-driven
 * raises past the declared width stay clamped to the ceiling. Explicit
 * `--max-concurrency` pins beat both.
 *
 * @param {number} maxConcurrency
 * @param {{ explicit?: boolean, ceiling?: number }} [options] `explicit` marks
 *   a user-pinned cap (never auto-raised); `ceiling` overrides the auto-raise
 *   ceiling (defaults to the env var above, else 16).
 * @returns {{ onSlotWait: (activeTaskCount: number, waitingCount: number) => { warn: string | null, raiseTo: number | null }, onDeclaredWidth: (declaredWidth: number | undefined) => { raiseTo: number | null } }}
 */
export function createSlotGovernor(maxConcurrency, options = {}) {
  const explicit = Boolean(options.explicit);
  const ceiling = resolveCeiling(options.ceiling);
  let cap = maxConcurrency;
  let warned = false;
  return {
    /**
     * Call with the widest DECLARED `<Parallel>` width (`maxConcurrency` or
     * `subtreeConcurrency`) in a freshly extracted graph (undefined when no
     * parallel declares one).
     * Declared widths bypass the auto-raise ceiling — the author asked for
     * that width — so this raises the cap to the declared width whenever
     * the run is not explicitly pinned and the width exceeds the current
     * cap. The ceiling keeps governing demand-driven raises in
     * `onSlotWait`, including raises past a smaller declared width.
     *
     * @param {number | undefined} declaredWidth
     * @returns {{ raiseTo: number | null }} `raiseTo` is the new cap the
     *   engine should adopt (always above the current one), else null
     */
    onDeclaredWidth(declaredWidth) {
      if (explicit || cap <= 0) {
        return { raiseTo: null };
      }
      if (typeof declaredWidth !== "number" || !Number.isInteger(declaredWidth) || declaredWidth <= cap) {
        return { raiseTo: null };
      }
      cap = declaredWidth;
      return { raiseTo: declaredWidth };
    },
    /**
     * Call when a task is about to queue for a slot. `waitingCount` counts
     * the queue INCLUDING the task about to wait.
     *
     * @param {number} activeTaskCount
     * @param {number} waitingCount
     * @returns {{ warn: string | null, raiseTo: number | null }} `raiseTo`
     *   is the new cap the engine should adopt (always above the current
     *   one), `warn` the starvation warning to log once, else nulls
     */
    onSlotWait(activeTaskCount, waitingCount) {
      if (cap <= 0) {
        return { warn: null, raiseTo: null };
      }
      const demand = activeTaskCount + waitingCount;
      if (!explicit) {
        const target = Math.min(demand, ceiling);
        if (target > cap) {
          cap = target;
          return { warn: null, raiseTo: target };
        }
      }
      if (warned || waitingCount < cap) {
        return { warn: null, raiseTo: null };
      }
      warned = true;
      const warn =
        `${demand} tasks want to run concurrently but maxConcurrency is ${cap}; ` +
        `${waitingCount} are queued waiting for a free slot. ` +
        `If the host and providers can take it, raise the cap (CLI: smithers up --max-concurrency ${demand}) ` +
        `to run this workflow at full width.`;
      return { warn, raiseTo: null };
    },
  };
}
/**
 * @param {number | undefined} ceiling
 * @returns {number}
 */
function resolveCeiling(ceiling) {
  const raw = ceiling ?? Number(process.env.SMITHERS_AUTO_MAX_CONCURRENCY_CEILING ?? NaN);
  return Number.isInteger(raw) && raw > 0 ? raw : 16;
}
