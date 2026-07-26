import { normalizeApiRow } from "./normalizeApiRow.js";

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
export function serializeRunEventRow(row) {
  const normalized = normalizeApiRow(row);
  const payloadJson = normalized.payloadJson;
  let payload = normalized.payload;
  if (payload === undefined && typeof payloadJson === "string") {
    try {
      payload = JSON.parse(payloadJson);
    } catch {
      payload = payloadJson;
    }
  }
  return /** @type {Row} */ (
    /** @type {unknown} */ ({
      runId: normalized.runId,
      seq: normalized.seq,
      event: normalized.event ?? normalized.type,
      payload,
      ...(normalized.timestampMs === undefined ? {} : { timestampMs: normalized.timestampMs }),
    })
  );
}
