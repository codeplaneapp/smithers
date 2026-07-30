import { useCallback, useEffect, useRef, useState } from "react";
import { useSmithersCollections } from "./useSmithersCollections.ts";

const EVENT_PAGE_SIZE = 1000;
const NODE_OUTPUT_INVALIDATION_EVENTS = new Set([
  "NodeOutput",
  "node.output",
  "task.output",
  "NodeFinished",
  "node.finished",
  "NodeFailed",
  "node.failed",
  "NodeCancelled",
  "node.cancelled",
  "NodeSkipped",
  "node.skipped",
]);
const RUN_TERMINAL_EVENTS = new Set(["RunFinished", "RunFailed", "RunCancelled", "RunContinuedAsNew", "run.completed"]);
const TERMINAL_RUN_STATUSES = new Set(["finished", "failed", "cancelled", "continued"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidatesNodeOutput(
  event: { event: string; payload?: unknown },
  nodeId: string,
  iteration: number,
): boolean {
  const payload = isRecord(event.payload) ? event.payload : {};
  if (
    RUN_TERMINAL_EVENTS.has(event.event) ||
    (event.event === "RunStatusChanged" && TERMINAL_RUN_STATUSES.has(String(payload.status)))
  ) {
    return true;
  }
  return (
    NODE_OUTPUT_INVALIDATION_EVENTS.has(event.event) &&
    payload.nodeId === nodeId &&
    (typeof payload.iteration !== "number" || payload.iteration === iteration)
  );
}

export function useGatewayNodeOutput(params: {
  runId: string | undefined;
  nodeId: string | undefined;
  iteration?: number;
}) {
  const { client, collections } = useSmithersCollections();
  const iteration = params.iteration ?? 0;
  const key = JSON.stringify([params.runId, params.nodeId, iteration]);
  const [result, setResult] = useState<
    { key: string; data: Record<string, unknown> | undefined } | undefined
  >(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const enabled = Boolean(params.runId && params.nodeId);
  const [loading, setLoading] = useState(enabled);
  const generation = useRef(0);
  const data = result?.key === key ? result.data : undefined;

  const refetch = useCallback(async () => {
    const current = ++generation.current;
    if (!params.runId || !params.nodeId) {
      setResult(undefined);
      setError(undefined);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const request = {
        runId: params.runId,
        nodeId: params.nodeId,
        iteration,
      };
      const next = await client.api.getNodeOutput(request);
      if (generation.current === current) setResult({ key, data: next });
    } catch (cause) {
      if (generation.current === current) setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [client, params.runId, params.nodeId, iteration, key]);

  useEffect(() => {
    if (!enabled) {
      generation.current += 1;
      setResult(undefined);
      setError(undefined);
      setLoading(false);
      return;
    }
    setResult((current) => (current?.key === key ? current : undefined));
    void refetch();
  }, [enabled, key, refetch]);

  useEffect(() => {
    if (!params.runId || !params.nodeId) return;
    const runId = params.runId;
    const nodeId = params.nodeId;
    const eventCollection = collections.runEvents(runId);
    let active = true;
    let afterSeq: number | undefined;
    let seeded = false;
    let inFlight = false;
    let queued = false;

    const refreshFromEvents = async () => {
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      let shouldRefetch = false;
      try {
        if (!seeded) {
          await eventCollection.preload();
          if (!active) return;
          const latest = eventCollection.toArray.reduce((max, row) => Math.max(max, row.seq), -1);
          afterSeq = latest >= 0 ? latest : undefined;
          seeded = true;
          // A change that arrived while the shared tail was loading (queued)
          // may predate the seeded cursor, and the queued re-scan only pages
          // events AFTER it. Refetch once to cover the gap between the initial
          // getNodeOutput and the cursor.
          shouldRefetch = queued;
          return;
        }
        while (active) {
          const rows = await client.api.listRunEvents({ runId, afterSeq, limit: EVENT_PAGE_SIZE });
          if (!active || rows.length === 0) break;
          const nextAfterSeq = rows.reduce((latest, row) => Math.max(latest, row.seq), afterSeq ?? -1);
          if (afterSeq !== undefined && nextAfterSeq <= afterSeq) break;
          afterSeq = nextAfterSeq;
          shouldRefetch ||= rows.some((row) => invalidatesNodeOutput(row, nodeId, iteration));
          if (rows.length < EVENT_PAGE_SIZE) break;
        }
      } catch {
        // Output remains manually refetchable if the event cursor is
        // temporarily unavailable. The next stream invalidation retries it.
      } finally {
        if (active && shouldRefetch) void refetch();
        inFlight = false;
        if (active && queued) {
          queued = false;
          void refreshFromEvents();
        }
      }
    };

    const unsubscribe = client.stream.subscribe((event) => {
      if (
        event.type === "reset" ||
        (event.type === "change" && event.collections.some((name) => name === "run_events" || name === "events"))
      ) {
        void refreshFromEvents();
      }
    });
    void refreshFromEvents();

    return () => {
      active = false;
      unsubscribe();
    };
  }, [client, collections, params.runId, params.nodeId, iteration, refetch]);

  return { data, error, loading, refetch };
}
