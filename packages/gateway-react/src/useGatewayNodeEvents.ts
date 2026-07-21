import { useEffect, useState } from "react";
import type { GatewayEventFrame } from "@smithers-orchestrator/gateway-client";
import { normalizeError } from "./GatewayAsyncState.ts";
import { useSmithersCollections } from "./useSmithersCollections.ts";

const DEFAULT_MAX_EVENTS = 1000;
const DEFAULT_LIMIT = 1000;
const DEFAULT_POLL_INTERVAL_MS = 1000;

type NodeEventsState = {
  events: GatewayEventFrame[];
  error: Error | undefined;
  loading: boolean;
};

/**
 * Durable, node-scoped event history followed by an incremental HTTP cursor.
 * Unlike useGatewayRunEvents, this never depends on the bounded run-wide
 * event collection, so an early node remains readable after a long run.
 */
export function useGatewayNodeEvents(
  runId: string | undefined,
  nodeId: string | undefined,
  options: { maxEvents?: number; limit?: number; pollIntervalMs?: number } = {},
): NodeEventsState & { streaming: boolean } {
  const { client } = useSmithersCollections();
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const [state, setState] = useState<NodeEventsState>({ events: [], error: undefined, loading: false });

  useEffect(() => {
    if (!runId || !nodeId) {
      setState({ events: [], error: undefined, loading: false });
      return;
    }

    let active = true;
    let cursor: number | undefined;
    let inFlight = false;
    setState({ events: [], error: undefined, loading: true });

    const poll = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      try {
        const rows = await client.api.listRunEvents({ runId, nodeId, afterSeq: cursor, limit });
        if (!active) return;
        const nextCursor = rows.reduce((latest, row) => Math.max(latest, row.seq), cursor ?? -1);
        if (rows.length > 0) cursor = nextCursor;
        setState((previous) => {
          const bySeq = new Map(previous.events.map((event) => [event.seq, event]));
          for (const row of rows) {
            bySeq.set(row.seq, {
              type: "event",
              event: row.event,
              payload: row.payload,
              seq: row.seq,
              stateVersion: 0,
            });
          }
          const events = [...bySeq.values()]
            .sort((left, right) => left.seq - right.seq)
            .slice(-Math.max(1, maxEvents));
          return { events, error: undefined, loading: false };
        });
      } catch (error) {
        if (active) setState((previous) => ({ ...previous, error: normalizeError(error), loading: false }));
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), pollIntervalMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, runId, nodeId, limit, maxEvents, pollIntervalMs]);

  return { ...state, streaming: Boolean(runId && nodeId) && state.error === undefined };
}
