import { normalizeApiRow } from "./normalizeApiRow.ts";

export function serializeTicketRow<Row extends Record<string, unknown>>(row: Row): Row {
  const normalized = normalizeApiRow(row);
  return {
    path: normalized.path,
    kind: normalized.kind,
    content: normalized.content,
    contentHash: normalized.contentHash,
    status: normalized.status ?? null,
    updatedAtMs: normalized.updatedAtMs,
  } as unknown as Row;
}
