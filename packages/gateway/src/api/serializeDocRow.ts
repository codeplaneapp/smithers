import { normalizeApiRow } from "./normalizeApiRow.ts";

export function serializeDocRow<Row extends Record<string, unknown>>(row: Row): Row {
  const normalized = normalizeApiRow(row);
  return {
    path: normalized.path,
    kind: normalized.kind,
    content: normalized.content,
    contentHash: normalized.contentHash,
    updatedAtMs: normalized.updatedAtMs,
    deletedAtMs: normalized.deletedAtMs ?? null,
  } as unknown as Row;
}
