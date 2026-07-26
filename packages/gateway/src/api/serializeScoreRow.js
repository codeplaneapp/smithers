import { normalizeApiRow } from "./normalizeApiRow.js";

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
export function serializeScoreRow(row) {
  const normalized = normalizeApiRow(row);
  return /** @type {Row} */ (
    /** @type {unknown} */ ({
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
    })
  );
}
