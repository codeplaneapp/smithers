import { normalizeApiRow } from "./normalizeApiRow.ts";

export function serializeCronRow<Row extends Record<string, unknown>>(row: Row): Row {
  const normalized = normalizeApiRow(row);
  const workflowPath = typeof normalized.workflowPath === "string" ? normalized.workflowPath : "";
  const workflow = typeof normalized.workflow === "string"
    ? normalized.workflow
    : workflowPath.startsWith("gateway:")
      ? workflowPath.slice("gateway:".length)
      : workflowPath;
  return {
    cronId: normalized.cronId,
    pattern: normalized.pattern,
    workflowPath,
    workflow,
    enabled: normalized.enabled === true || normalized.enabled === 1,
    createdAtMs: normalized.createdAtMs,
    lastRunAtMs: normalized.lastRunAtMs ?? null,
    nextRunAtMs: normalized.nextRunAtMs ?? null,
    errorJson: normalized.errorJson ?? null,
  } as unknown as Row;
}
