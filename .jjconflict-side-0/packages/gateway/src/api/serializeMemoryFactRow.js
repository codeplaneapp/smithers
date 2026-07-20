import { normalizeApiRow } from "./normalizeApiRow.js";

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
export function serializeMemoryFactRow(row) {
  const normalized = normalizeApiRow(row);
  return /** @type {Row} */ (/** @type {unknown} */ ({
    namespace: normalized.namespace,
    key: normalized.key,
    valueJson: normalized.valueJson,
    schemaSig: normalized.schemaSig ?? null,
    createdAtMs: normalized.createdAtMs,
    updatedAtMs: normalized.updatedAtMs,
    ttlMs: normalized.ttlMs ?? null,
  }));
}
