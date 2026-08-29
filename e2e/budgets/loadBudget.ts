/**
 * Reading the committed budgets.
 *
 * A budget is a number in a file under review, not a literal buried in an
 * assertion. Tests read it through here so widening one is a diff on
 * `budgets/*.json` rather than an edit inside a test nobody re-reads.
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
  readonly subscriberFanoutN5: { readonly rssGrowthBytesMax: number }
}

/**
 * The shape of `latency.json`.
 *
 * @since 1.0.0
 * @category models
 */
export interface LatencyBudget {
  readonly perPRSuiteWallTimeMaxMs: number
  readonly nightlySoakWallTimeMaxMs: number
  readonly reconnectCursorMaxMs: number
}
