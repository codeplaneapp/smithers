import { useMemo, useSyncExternalStore } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { GatewayEventFrame, GatewayRunEventRow } from "@smithers-orchestrator/gateway-client";
import { useSyncClient } from "./sync/useSyncClient.ts";

const DEFAULT_MAX_EVENTS = 1000;
/** Mirrors the `runEvents` collection's default `maxRows` ring size (see gatewayCollectionDefs). */
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
 * Live run-event buffer over the bounded `runEvents` collection
 * (`streamRunEventsResilient` with afterSeq resume). Heartbeats are surfaced
 * separately via `lastHeartbeat` and never enter `events`; the events array is
 * capped to `maxEvents` (most-recent wins). Same return shape the streaming
 * hook had.
 */
export function useGatewayRunEvents(
  runId: string | undefined,
  options: { afterSeq?: number; maxEvents?: number } = {},
): {
  events: GatewayEventFrame[];
  lastHeartbeat: GatewayEventFrame | undefined;
  error: Error | undefined;
  streaming: boolean;
} {
  const registry = useSyncClient();
  const connection = useSyncExternalStore(
    registry.subscribeConnection,
    registry.connection,
    registry.connection,
  );
  const afterSeq = options.afterSeq;
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  // Size the underlying ring to hold at least the requested display window so a
  // large `maxEvents` (e.g. the TUI's 2000) actually retains that much history
  // instead of being silently clamped to the collection's default cap. Floor at
  // DEFAULT_COLLECTION_MAX_ROWS so the common (web) path is unchanged.
  const collection = runId
    ? registry.runEvents(runId, Math.max(maxEvents, DEFAULT_COLLECTION_MAX_ROWS))
    : undefined;
  const live = useLiveQuery(
    (q) => (collection ? q.from({ row: collection }) : undefined),
    [collection],
  );

  const rows = (live.data ?? []) as GatewayRunEventRow[];
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

  return {
    events,
    lastHeartbeat,
    error: live.isError || streamFailed ? new Error("Run event stream failed.") : undefined,
    streaming: Boolean(runId) && !live.isError && !streamFailed,
  };
}
