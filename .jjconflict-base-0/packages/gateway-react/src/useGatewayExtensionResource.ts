import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSmithersGateway } from "./useSmithersGateway.ts";
import type { GatewayAsyncState } from "./GatewayAsyncState.ts";

/**
 * Declarative subscription to an extension resource/query. Same stale-response
 * fence as `useGatewayRpc` — a generation counter cancels late results so a
 * fast re-render with new params can't be stomped by a slow earlier reply.
 *
 * Why stale guards matter here: extension handlers are typically third-party
 * code with unbounded latency (an LLM call, a remote GitHub fetch). Without a
 * generation fence a slow first call would race ahead of a faster second call
 * and overwrite the fresh data on resolve.
 */
export function useGatewayExtensionResource<T = unknown>(
  namespace: string,
  key: string,
  params: Record<string, unknown> = {},
  options: { enabled?: boolean; deps?: readonly unknown[] } = {},
): GatewayAsyncState<T> {
  const client = useSmithersGateway();
  const enabled = options.enabled ?? true;
  const paramsKey = useMemo(() => JSON.stringify(params ?? {}), [params]);
  const deps = options.deps ?? [paramsKey];
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const generationRef = useRef(0);
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(enabled);

  const refetch = useCallback(async () => {
    if (!enabled) {
      return;
    }
    const generation = ++generationRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const payload = await client.extensionRpc<T>(namespace, key, paramsRef.current);
      if (generation === generationRef.current) {
        setData(payload);
      }
    } catch (cause) {
      if (generation === generationRef.current) {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    } finally {
      if (generation === generationRef.current) {
        setLoading(false);
      }
    }
  }, [client, enabled, namespace, key]);

  useEffect(() => {
    if (!enabled) {
      generationRef.current += 1;
      setData(undefined);
      setError(undefined);
      setLoading(false);
      return;
    }
    setData(undefined);
    setError(undefined);
    void refetch();
    return () => {
      generationRef.current += 1;
    };
    // deps spread keeps custom invalidation working (e.g. a runId in scope).
  }, [client, enabled, namespace, key, paramsKey, refetch, ...deps]);

  return { data, error, loading, refetch };
}
