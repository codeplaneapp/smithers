import { normalizeApiRow } from "./normalizeApiRow.js";

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
export function serializeRunRow(row) {
  const normalized = normalizeApiRow(row);
  if (normalized.workflowKey === undefined && typeof normalized.configJson === "string") {
    try {
      const config = /** @type {{ gatewayWorkflowKey?: unknown }} */ (JSON.parse(normalized.configJson));
      if (typeof config.gatewayWorkflowKey === "string") {
        normalized.workflowKey = config.gatewayWorkflowKey;
      }
    } catch {
      // Malformed run config stays opaque on the wire.
    }
  }
  if (normalized.workflowKey === undefined && typeof normalized.workflowName === "string") {
    normalized.workflowKey = normalized.workflowName;
  }
  return /** @type {Row} */ (normalized);
}
