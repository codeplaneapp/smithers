import { useMemo } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { GatewayEventFrame, GatewayRunEventRow } from "@smithers-orchestrator/gateway-client";
import { useSyncClient } from "./sync/useSyncClient.ts";

const DEFAULT_MAX_EVENTS = 1000;

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
  const afterSeq = options.afterSeq;
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const collection = runId ? registry.runEvents(runId) : undefined;
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

  return {
    events,
    lastHeartbeat,
    error: live.isError ? new Error("Run event stream failed.") : undefined,
    streaming: Boolean(runId) && !live.isError,
  };
}
