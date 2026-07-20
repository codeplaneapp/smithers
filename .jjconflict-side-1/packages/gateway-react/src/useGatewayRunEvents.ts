import { useMemo, useSyncExternalStore } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { GatewayEventFrame, GatewayRunEventRow } from "@smithers-orchestrator/gateway-client";
import { normalizeError } from "./GatewayAsyncState.ts";
import { useSmithersCollections } from "./useSmithersCollections.ts";

const DEFAULT_MAX_EVENTS = 1000;
/** Mirrors the `runEvents` collection's default `maxRows` ring size. */
const DEFAULT_COLLECTION_MAX_ROWS = 1024;

/**
 * Reconstruct a `GatewayEventFrame` from a stored row. The transport collapses
 * the resilient frame down to `{ event, payload, seq }`, so `stateVersion` is
 * not retained in the collection; surface 0 (consumers read event/payload/seq).
 */
function toFrame(row: GatewayRunEventRow): GatewayEventFrame {
  return { type: "event", event: row.event, payload: row.payload, seq: row.seq, stateVersion: 0 };
}

/**
 * Live run-event buffer over the bounded `runEvents` collection. Local mode
 * refetches after SSE invalidation; multiplayer mode follows the Electric
 * events shape. Heartbeats remain normal collection rows and are filtered in
 * this hook: the latest heartbeat is returned as `lastHeartbeat`, while
 * `events` contains only non-heartbeat frames capped to `maxEvents` with the
 * most recent rows retained.
 */
export function useGatewayRunEvents(
  runId: string | undefined,
  options: { afterSeq?: number; maxEvents?: number } = {},
): {
  events: GatewayEventFrame[];
  lastHeartbeat: GatewayEventFrame | undefined;
  error: Error | undefined;
  streaming: boolean;
  loading: boolean;
} {
  const { client, collections } = useSmithersCollections();
  const connection = useSyncExternalStore(
    client.stream.subscribeStatus,
    client.stream.status,
    client.stream.status,
  );
  const afterSeq = options.afterSeq;
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const collection = runId
    ? collections.runEvents(runId, DEFAULT_COLLECTION_MAX_ROWS)
    : undefined;
  const live = useLiveQuery(
    (q) => (collection ? q.from({ row: collection }) : undefined),
    [collection],
  );

  const rows = useMemo(
    () => ((live.data ?? []) as GatewayRunEventRow[]).filter((row) => row.runId === runId),
    [live.data, runId],
  );
  const { events, lastHeartbeat } = useMemo(() => {
    const sorted = [...rows].sort((left, right) => left.seq - right.seq);
    const eligible = typeof afterSeq === "number" ? sorted.filter((row) => row.seq > afterSeq) : sorted;
    const heartbeats = eligible.filter((row) => row.event === "run.heartbeat");
    const nonHeartbeat = eligible.filter((row) => row.event !== "run.heartbeat");
    const capped = nonHeartbeat.slice(Math.max(0, nonHeartbeat.length - maxEvents));
    return {
      events: capped.map(toFrame),
      lastHeartbeat: heartbeats.length ? toFrame(heartbeats[heartbeats.length - 1]!) : undefined,
    };
  }, [rows, afterSeq, maxEvents]);

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
