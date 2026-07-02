import { normalizeApiRow } from "./normalizeApiRow.ts";

export function serializeRunEventRow<Row extends Record<string, unknown>>(row: Row): Row {
  const normalized = normalizeApiRow(row);
  const payloadJson = normalized.payloadJson;
  let payload = normalized.payload;
  if (payload === undefined && typeof payloadJson === "string") {
    try {
      payload = JSON.parse(payloadJson);
    } catch {
      payload = payloadJson;
    }
  }
  return {
    runId: normalized.runId,
    seq: normalized.seq,
    event: normalized.event ?? normalized.type,
    payload,
    ...(normalized.timestampMs === undefined ? {} : { timestampMs: normalized.timestampMs }),
  } as unknown as Row;
}
