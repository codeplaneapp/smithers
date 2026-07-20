/**
 * Deterministic, filesystem-safe run id for a benchmark instance. Stable across
 * replans so a resumed or re-planned pass reuses the same durable run rather
 * than starting a duplicate.
 */
export function benchmarkRunId(benchmark: string, instanceId: string): string {
  return `${benchmark}-${instanceId}`.replace(/[^a-zA-Z0-9._-]/g, "_");
}
