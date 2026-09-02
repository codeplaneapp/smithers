/**
 * Effect metric registry for flows runtime signals.
 *
 * @since 0.1.0
 */
import * as Metric from "effect/Metric"

const prefix = "flows/"

/**
 * Counts flow runs that reached a terminal state.
 *
 * @category metrics
 * @since 0.1.0
 * @slop
 */
export const runThroughput = Metric.counter(`${prefix}run/throughput`, {
  description: "Completed flow runs"
})

/**
 * The number of execution seats currently held.
 *
 * @category metrics
 * @since 0.1.0
 * @slop
 */
export const activeSeats = Metric.gauge(`${prefix}seat/active`, {
  description: "Currently active execution seats"
})

/**
 * Counts runs parked because a quota was exhausted.
 *
 * @category metrics
 * @since 0.1.0
 * @slop
 */
export const quotaParks = Metric.counter(`${prefix}quota/park`, {
  description: "Runs parked by quota enforcement"
})

/**
 * All metrics declared by this package.
 *
 * @category registry
 * @since 0.1.0
 * @slop
 */
export const registry = {
  runThroughput,
  activeSeats,
  quotaParks
} as const
