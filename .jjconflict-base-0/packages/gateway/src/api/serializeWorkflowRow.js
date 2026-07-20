import { normalizeApiRow } from "./normalizeApiRow.js";

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
export function serializeWorkflowRow(row) {
  return /** @type {Row} */ (normalizeApiRow(row));
}
