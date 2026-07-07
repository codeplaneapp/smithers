import { normalizeApiRow } from "./normalizeApiRow.js";

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
export function serializeDocRow(row) {
  const normalized = normalizeApiRow(row);
  return /** @type {Row} */ (/** @type {unknown} */ ({
    path: normalized.path,
    kind: normalized.kind,
    content: normalized.content,
    contentHash: normalized.contentHash,
    updatedAtMs: normalized.updatedAtMs,
    deletedAtMs: normalized.deletedAtMs ?? null,
  }));
}
