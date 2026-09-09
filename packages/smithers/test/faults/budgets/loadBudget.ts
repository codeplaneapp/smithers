/**
 * Reading the committed budgets.
 *
 * A budget is a number in a file under review, not a literal buried in an
 * assertion. Tests read it through here so widening one is a diff on
 * `test/faults/budgets/*.json` rather than an edit inside a test nobody re-reads.
 *
 * @since 1.0.0
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * The budget files this module serves.
 *
 * @since 1.0.0
 * @category models
 */
export type BudgetName = "memory" | "latency"

/**
 * Reads one budget file.
 *
 * @since 1.0.0
 * @category getters
 */
export const loadBudget = <A>(name: BudgetName): A =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./${name}.json`, import.meta.url)), "utf8")) as A

/**
 * The shape of `memory.json`.
 *
 * @since 1.0.0
 * @category models
 */
export interface MemoryBudget {
  readonly subscriberFanoutN5: {
    /** The gateway process, sampled by pid: where a fan-out queue would grow. */
    readonly serverRssGrowthBytesMax: number
    /** The reading process, named so it cannot be mistaken for the server's. */
    readonly clientRssGrowthBytesMax: number
  }
}

/**
 * The shape of `latency.json`.
 *
 * The two suite-wide wall-time ceilings this file used to declare belonged to
 * `e2e/ci/runFaultSuite.ts`, which ran the whole matrix from one workspace
 * member. The matrix is a per-package `faults` target now, and a suite that
 * overruns is bounded by the CI job's own timeout, so what survives here is the
 * one budget a case actually reads.
 *
 * @since 1.0.0
 * @category models
 */
export interface LatencyBudget {
  readonly reconnectCursorMaxMs: number
}
