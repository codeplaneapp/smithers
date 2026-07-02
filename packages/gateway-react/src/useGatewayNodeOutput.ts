import { useCallback, useEffect, useRef, useState } from "react";
import { useSmithersCollections } from "./useSmithersCollections.ts";

export function useGatewayNodeOutput(params: {
  runId: string | undefined;
  nodeId: string | undefined;
  iteration?: number;
}) {
  const { client } = useSmithersCollections();
  const [data, setData] = useState<Record<string, unknown> | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const enabled = Boolean(params.runId && params.nodeId);
  const [loading, setLoading] = useState(enabled);
  const generation = useRef(0);

  const refetch = useCallback(async () => {
    const current = ++generation.current;
    if (!params.runId || !params.nodeId) {
      setData(undefined);
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
        iteration: params.iteration ?? 0,
      };
      const next = await client.api.getNodeOutput(request);
      if (generation.current === current) setData(next);
    } catch (cause) {
      if (generation.current === current) setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [client, params.runId, params.nodeId, params.iteration]);

  useEffect(() => {
    if (!enabled) {
      generation.current += 1;
      setData(undefined);
      setError(undefined);
      setLoading(false);
      return;
    }
    void refetch();
  }, [enabled, refetch]);

  return { data, error, loading, refetch };
}
