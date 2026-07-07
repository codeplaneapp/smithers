import { normalizeApiRow } from "./normalizeApiRow.js";

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
export function serializeCronRow(row) {
  const normalized = normalizeApiRow(row);
  const workflowPath = typeof normalized.workflowPath === "string" ? normalized.workflowPath : "";
  const workflow = typeof normalized.workflow === "string"
    ? normalized.workflow
    : workflowPath.startsWith("gateway:")
      ? workflowPath.slice("gateway:".length)
      : workflowPath;
  return /** @type {Row} */ (/** @type {unknown} */ ({
    cronId: normalized.cronId,
    pattern: normalized.pattern,
    workflowPath,
    workflow,
    enabled: normalized.enabled === true || normalized.enabled === 1,
    createdAtMs: normalized.createdAtMs,
    lastRunAtMs: normalized.lastRunAtMs ?? null,
    nextRunAtMs: normalized.nextRunAtMs ?? null,
    errorJson: normalized.errorJson ?? null,
  }));
}
