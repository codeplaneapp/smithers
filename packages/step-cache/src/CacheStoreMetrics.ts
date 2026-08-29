/**
 * Standard metric definitions for the content-addressed step result cache.
 *
 * This module only defines the metric handles, following the shape of Effect's
 * `ClusterMetrics`. `CacheStore` updates them as lookups and recordings
 * resolve. No exporter ships in this package; provide one — for example
 * `@smthrs/observability` — and these counters appear in it.
 *
 * @since 0.1.0
 */
import * as Metric from "effect/Metric"

/**
 * Counter over cache lookups, dimensioned by `outcome` (`hit` or `miss`).
 *
 * @category metrics
 * @since 0.1.0
 */
export const lookups = Metric.counter("flows_step_cache_lookups", {
  description: "Step cache lookups by outcome"
})

/**
 * `lookups` view counting hits: a row existed for the key digest.
 *
 * @category metrics
 * @since 0.1.0
 */
export const hit: Metric.Metric<number, Metric.CounterState<number>> = Metric.withAttributes(lookups, {
  outcome: "hit"
})

/**
 * `lookups` view counting misses: no row existed for the key digest.
 *
 * @category metrics
 * @since 0.1.0
 */
export const miss: Metric.Metric<number, Metric.CounterState<number>> = Metric.withAttributes(lookups, {
  outcome: "miss"
})

/**
 * Counter over cache recordings, dimensioned by `outcome` (`inserted`,
 * `existing_same`, or `conflict`). A `conflict` is the signal
 * `Inconsistency` receivers act on: the same key digest recorded a different
 * result.
 *
 * @category metrics
 * @since 0.1.0
 */
export const puts = Metric.counter("flows_step_cache_puts", {
  description: "Step cache recordings by outcome"
})

/**
 * `puts` views keyed by the `PutResult` tag `CacheStore.put` resolves to.
 *
 * @category metrics
 * @since 0.1.0
 */
export const put: {
  readonly [Tag in "Inserted" | "ExistingSame" | "Conflict"]: Metric.Metric<number, Metric.CounterState<number>>
} = {
  Inserted: Metric.withAttributes(puts, { outcome: "inserted" }),
  ExistingSame: Metric.withAttributes(puts, { outcome: "existing_same" }),
  Conflict: Metric.withAttributes(puts, { outcome: "conflict" })
}
