import { normalizeApiRow } from "./normalizeApiRow.js";

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
export function serializeTicketRow(row) {
  const normalized = normalizeApiRow(row);
  return /** @type {Row} */ (
    /** @type {unknown} */ ({
      path: normalized.path,
      kind: normalized.kind,
      content: normalized.content,
      contentHash: normalized.contentHash,
      status: normalized.status ?? null,
      updatedAtMs: normalized.updatedAtMs,
    })
  );
}
