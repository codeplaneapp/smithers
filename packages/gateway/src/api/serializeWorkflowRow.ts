import { normalizeApiRow } from "./normalizeApiRow.ts";

export function serializeWorkflowRow<Row extends Record<string, unknown>>(row: Row): Row {
  return normalizeApiRow(row) as Row;
}
