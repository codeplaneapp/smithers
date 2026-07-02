import { normalizeApiRow } from "./normalizeApiRow.ts";

export function serializeMemoryFactRow<Row extends Record<string, unknown>>(row: Row): Row {
  const normalized = normalizeApiRow(row);
  return {
    namespace: normalized.namespace,
    key: normalized.key,
    valueJson: normalized.valueJson,
    schemaSig: normalized.schemaSig ?? null,
    createdAtMs: normalized.createdAtMs,
    updatedAtMs: normalized.updatedAtMs,
    ttlMs: normalized.ttlMs ?? null,
  } as unknown as Row;
}
