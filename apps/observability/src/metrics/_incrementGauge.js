import { Effect, Metric } from "effect";

/**
 * Apply a delta to an Effect 4 gauge, whose native update operation is absolute.
 *
 * @param {Metric.Gauge<number>} metric
 * @param {number} delta
 */
export function incrementGauge(metric, delta) {
  return Metric.value(metric).pipe(
    Effect.flatMap((state) => Metric.update(metric, Number(state.value) + delta)),
  );
}
