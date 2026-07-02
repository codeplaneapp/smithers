import { normalizeApiRow } from "./normalizeApiRow.ts";

export function serializeRunRow<Row extends Record<string, unknown>>(row: Row): Row {
  const normalized = normalizeApiRow(row);
  if (normalized.workflowKey === undefined && typeof normalized.configJson === "string") {
    try {
      const config = JSON.parse(normalized.configJson) as { gatewayWorkflowKey?: unknown };
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
  return normalized as Row;
}
