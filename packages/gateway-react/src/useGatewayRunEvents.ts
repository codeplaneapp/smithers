import { useEffect, useState } from "react";
import type { GatewayEventFrame } from "@smithers-orchestrator/gateway-client";
import { useSmithersGateway } from "./useSmithersGateway.ts";

export function useGatewayRunEvents(runId: string | undefined, options: { afterSeq?: number } = {}) {
  const client = useSmithersGateway();
  const [events, setEvents] = useState<GatewayEventFrame[]>([]);
  const [error, setError] = useState<Error>();
  const [streaming, setStreaming] = useState(Boolean(runId));

  useEffect(() => {
    if (!runId) {
      setStreaming(false);
      return;
    }
    const abort = new AbortController();
    setEvents([]);
    setStreaming(true);
    setError(undefined);
    void (async () => {
      try {
        for await (const frame of client.streamRunEvents(
          { runId, ...(typeof options.afterSeq === "number" ? { afterSeq: options.afterSeq } : {}) },
          { signal: abort.signal },
        )) {
          setEvents((current) => [...current, frame]);
        }
      } catch (cause) {
        if (!abort.signal.aborted) {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
        }
      } finally {
        if (!abort.signal.aborted) {
          setStreaming(false);
        }
      }
    })();
    return () => abort.abort();
  }, [client, runId, options.afterSeq]);

  return { events, error, streaming };
}
