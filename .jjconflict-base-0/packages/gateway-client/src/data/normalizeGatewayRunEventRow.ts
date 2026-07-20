import type { GatewayRunEventRow } from "../sync/GatewayRunEventRow.ts";

function parsePayload(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readString(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function readNumber(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

export function normalizeGatewayRunEventRow(value: unknown): GatewayRunEventRow | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const runId = readString(record, "runId", "run_id") ?? "";
  const seq = readNumber(record, "seq");
  if (seq === undefined) return undefined;
  const event = readString(record, "event", "type") ?? "event";
  const payload = record.payload !== undefined ? record.payload : parsePayload(record.payloadJson ?? record.payload_json);
  const timestampMs = readNumber(record, "timestampMs", "timestamp_ms");
  return {
    runId,
    seq,
    event,
    payload,
    ...(timestampMs === undefined ? {} : { timestampMs }),
  };
}
