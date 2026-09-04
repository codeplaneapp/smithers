/**
 * Standard metric definitions for content-addressed artifact storage.
 *
 * This module only defines the metric handles, following the shape of Effect's
 * `ClusterMetrics`. No exporter ships in this package; provide one — for
 * example `@smthrs/observability` — and these counters appear in it.
 *
 * Only the local `ArtifactStore` implementations, filesystem and memory, update
 * them. `RemoteArtifacts` is deliberately uninstrumented, and the counters carry
 * no tier attribute, so read them as *local artifact store traffic* rather than
 * as artifact operations:
 *
 * - a `CombinedArtifacts` read the local tier serves counts one get;
 * - a read the shared tier serves counts NO get, because no local store
 *   answered it;
 * - the write-back that materializes such a read counts a put, indistinguishable
 *   from a producer publishing new bytes.
 *
 * Attributing operations per tier needs the tier in the metric, which would
 * change the published counter shape; until then this is what the numbers mean.
 *
 * @since 1.0.0-rc.0
 */
import * as Metric from "effect/Metric"

/**
 * Counter over successful artifact puts. A put that deduplicated against an
 * existing verified blob still counts: the caller stored bytes and received
 * an address either way.
 *
 * @category metrics
 * @since 1.0.0-rc.0
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
 * @since 1.0.0-rc.0
 * @slop
 */
export const gets = Metric.counter("flows_artifact_gets", {
  description: "Successful artifact gets"
})
