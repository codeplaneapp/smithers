import { normalizeApiRow } from "./normalizeApiRow.ts";

export function serializeScoreRow<Row extends Record<string, unknown>>(row: Row): Row {
  const normalized = normalizeApiRow(row);
  return {
    runId: normalized.runId,
    nodeId: normalized.nodeId,
    iteration: normalized.iteration ?? 0,
    attempt: normalized.attempt ?? 0,
    scorerId: normalized.scorerId,
    scorerName: normalized.scorerName,
    source: normalized.source,
    score: normalized.score,
    reason: normalized.reason ?? null,
    scoredAtMs: normalized.scoredAtMs,
    latencyMs: normalized.latencyMs ?? null,
    durationMs: normalized.durationMs ?? null,
  } as unknown as Row;
}
