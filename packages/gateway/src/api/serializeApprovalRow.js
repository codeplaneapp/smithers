import { normalizeApiRow } from "./normalizeApiRow.js";

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function parseJson(value) {
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? /** @type {Record<string, unknown>} */ (parsed) : {};
  } catch {
    return {};
  }
}

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
export function serializeApprovalRow(row) {
  const normalized = normalizeApiRow(row);
  const request = parseJson(normalized.requestJson);
  return /** @type {Row} */ (/** @type {unknown} */ ({
    runId: normalized.runId,
    ...(normalized.workflowKey === undefined ? {} : { workflowKey: normalized.workflowKey }),
    nodeId: normalized.nodeId,
    iteration: normalized.iteration ?? 0,
    requestTitle: normalized.requestTitle ?? request.title,
    requestSummary: normalized.requestSummary ?? request.summary,
    requestedAtMs: normalized.requestedAtMs ?? null,
    approvalMode: normalized.approvalMode ?? request.mode,
    options: normalized.options ?? request.options,
    allowedScopes: normalized.allowedScopes ?? request.allowedScopes,
    allowedUsers: normalized.allowedUsers ?? request.allowedUsers,
    autoApprove: normalized.autoApprove ?? request.autoApprove,
  }));
}
