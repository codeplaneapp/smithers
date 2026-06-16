import type { GatewayRunEventRow } from "./GatewayRunEventRow.ts";

/**
 * Largest serialized `payload` (characters) a run-event row may carry into
 * client persistence. Control-plane frames (run.started, node lifecycle,
 * heartbeats) are far smaller than this and rehydrate intact; `NodeOutput`,
 * agent session/transcript, and trace frames blow past it, so their payload is
 * dropped to a marker and the real bytes stay RPC-on-demand by id
 * (`getNodeOutput` / `getNodeDiff`). This keeps the design's "large blobs are
 * never persisted" invariant (§5.4) on the one persisted collection whose rows
 * can embed a blob.
 */
export const MAX_PERSISTED_EVENT_PAYLOAD_CHARS = 4_096;

export type TruncatedEventPayload = {
  $truncated: true;
  chars: number;
};

/**
 * Strip blob-bearing payloads from a run-event row before it is written to the
 * persistence adapter. The in-memory ring keeps the full frame for the live UI;
 * only the durable copy is shrunk, so a warm reload rehydrates the event
 * skeleton (seq + event kind) and the live stream resumes from the cached max
 * seq to refill anything still flowing.
 */
export function sanitizeRunEventRowForPersistence(row: GatewayRunEventRow): GatewayRunEventRow {
  const { payload } = row;
  if (payload === undefined || payload === null) return row;
  let chars: number;
  try {
    chars = JSON.stringify(payload)?.length ?? 0;
  } catch {
    // Unserializable payloads cannot be persisted at all; treat as oversized.
    chars = MAX_PERSISTED_EVENT_PAYLOAD_CHARS + 1;
  }
  if (chars <= MAX_PERSISTED_EVENT_PAYLOAD_CHARS) return row;
  return { ...row, payload: { $truncated: true, chars } satisfies TruncatedEventPayload };
}
