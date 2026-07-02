import { normalizeApiRow } from "./normalizeApiRow.ts";

function parseJson(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function serializeApprovalRow<Row extends Record<string, unknown>>(row: Row): Row {
  const normalized = normalizeApiRow(row);
  const request = parseJson(normalized.requestJson);
  return {
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
  } as unknown as Row;
}
