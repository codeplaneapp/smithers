/**
 * Standard metric definitions for content-addressed artifact storage.
 *
 * This module only defines the metric handles, following the shape of Effect's
 * `ClusterMetrics`. The local `ArtifactStore` implementations update them per
 * successful operation, so a `CombinedArtifacts` stack counts once per tier it
 * actually touched. No exporter ships in this package; provide one — for
 * example `@smthrs/observability` — and these counters appear in it.
 *
 * @since 0.1.0
 */
import * as Metric from "effect/Metric"

/**
 * Counter over successful artifact puts. A put that deduplicated against an
 * existing verified blob still counts: the caller stored bytes and received
 * an address either way.
 *
 * @category metrics
 * @since 0.1.0
 * @slop
 */
export const puts = Metric.counter("flows_artifact_puts", {
  description: "Successful artifact puts, including deduplicated ones"
})

/**
 * Counter over successful artifact gets. Missing and corrupt reads fail with
 * their typed errors and are deliberately not counted here; they are error
 * evidence, not throughput.
 *
 * @category metrics
 * @since 0.1.0
 * @slop
 */
export const gets = Metric.counter("flows_artifact_gets", {
  description: "Successful artifact gets"
})
