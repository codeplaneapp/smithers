import { useMemo, useSyncExternalStore } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { GatewayEventFrame, GatewayRunEventRow } from "@smthrs/gateway-client";
import { normalizeError } from "./GatewayAsyncState.ts";
import { useSmithersCollections } from "./useSmithersCollections.ts";

const DEFAULT_MAX_EVENTS = 1000;
/** Mirrors the `runEvents` collection's default `maxRows` ring size. */
const DEFAULT_COLLECTION_MAX_ROWS = 1024;
/**
 * Every heartbeat spelling the engine emits (run-level and per-task). All of
 * them are liveness proof, not log content — task heartbeats fire every few
 * seconds and would otherwise consume the `maxEvents` cap and age real events
 * out of the buffer.
 */
const HEARTBEAT_EVENTS = new Set(["run.heartbeat", "task.heartbeat", "TaskHeartbeat"]);

/**
 * Reconstruct a `GatewayEventFrame` from a stored row. The transport collapses
 * the resilient frame down to `{ event, payload, seq }`, so `stateVersion` is
 * not retained in the collection; surface 0 (consumers read event/payload/seq).
 * The persisted row's `timestampMs` rides along so log UIs can render when an
 * event happened without a second lookup.
 */
function toFrame(row: GatewayRunEventRow): GatewayEventFrame & { timestampMs?: number } {
  return {
    type: "event",
    event: row.event,
    payload: row.payload,
    seq: row.seq,
    stateVersion: 0,
    ...(row.timestampMs !== undefined ? { timestampMs: row.timestampMs } : {}),
  };
}

/**
 * Live run-event buffer over the bounded `runEvents` collection. Local mode
 * refetches after SSE invalidation; multiplayer mode follows the Electric
 * events shape. Heartbeats remain normal collection rows and are filtered in
 * this hook: the latest eligible heartbeat is returned as `lastHeartbeat`, while
 * `events` contains only non-heartbeat frames by default, capped to `maxEvents`
 * with the most recent rows retained. Set `includeHeartbeats` to include
 * heartbeat frames in that same newest-first cap; `afterSeq` applies before the
 * cap in either mode.
 */
export function useGatewayRunEvents(
  runId: string | undefined,
  options: { afterSeq?: number; maxEvents?: number; includeHeartbeats?: boolean } = {},
): {
  events: Array<GatewayEventFrame & { timestampMs?: number }>;
  lastHeartbeat: (GatewayEventFrame & { timestampMs?: number }) | undefined;
  error: Error | undefined;
  streaming: boolean;
  loading: boolean;
} {
  const { client, collections } = useSmithersCollections();
  const connection = useSyncExternalStore(client.stream.subscribeStatus, client.stream.status, client.stream.status);
  const afterSeq = options.afterSeq;
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const includeHeartbeats = options.includeHeartbeats ?? false;
  const collection = runId ? collections.runEvents(runId, DEFAULT_COLLECTION_MAX_ROWS) : undefined;
  const live = useLiveQuery((q) => (collection ? q.from({ row: collection }) : undefined), [collection]);

  const rows = useMemo(
    () => ((live.data ?? []) as GatewayRunEventRow[]).filter((row) => row.runId === runId),
    [live.data, runId],
  );
  const { events, lastHeartbeat } = useMemo(() => {
    const sorted = [...rows].sort((left, right) => left.seq - right.seq);
    const eligible = typeof afterSeq === "number" ? sorted.filter((row) => row.seq > afterSeq) : sorted;
    const heartbeats = eligible.filter((row) => HEARTBEAT_EVENTS.has(row.event));
    const nonHeartbeat = eligible.filter((row) => !HEARTBEAT_EVENTS.has(row.event));
    const source = includeHeartbeats ? eligible : nonHeartbeat;
    const capped = source.slice(Math.max(0, source.length - maxEvents));
    return {
      events: capped.map(toFrame),
      lastHeartbeat: heartbeats.length ? toFrame(heartbeats[heartbeats.length - 1]!) : undefined,
    };
  }, [rows, afterSeq, maxEvents, includeHeartbeats]);

  const streamFailed = Boolean(runId) && (connection.status === "offline" || connection.status === "unauthorized");
  const sourceError = normalizeError(collection?.utils?.lastError);

  return {
    events,
    lastHeartbeat,
    error: sourceError ?? (live.isError || streamFailed ? new Error("Run event stream failed.") : undefined),
    streaming: Boolean(runId) && !sourceError && !live.isError && !streamFailed,
    // True only during the collection's initial pull: consumers must render a
    // loading state, not an authoritative-looking "no events" empty state.
    loading: Boolean(runId) && !live.isReady && events.length === 0,
  };
}
