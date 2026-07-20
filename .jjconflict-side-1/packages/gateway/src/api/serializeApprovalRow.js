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
 * @param {Record<string, unknown>} row
 * @returns {{
 *   runId: unknown,
 *   workflowKey?: unknown,
 *   nodeId: unknown,
 *   iteration: unknown,
 *   requestTitle: unknown,
 *   requestSummary: unknown,
 *   requestedAtMs: unknown,
 *   approvalMode: unknown,
 *   options: unknown,
 *   allowedScopes: unknown,
 *   allowedUsers: unknown,
 *   autoApprove: unknown,
 * }}
 */
export function serializeApprovalRow(row) {
  const normalized = normalizeApiRow(row);
  const request = parseJson(normalized.requestJson);
  return ({
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
  });
}
