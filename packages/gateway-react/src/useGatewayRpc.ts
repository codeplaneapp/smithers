import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GatewayRpcMethod } from "@smithers-orchestrator/gateway/rpc";
import type { GatewayRpcParams, GatewayRpcPayload } from "@smithers-orchestrator/gateway-client";
import { useSmithersGateway } from "./useSmithersGateway.ts";
import type { GatewayAsyncState } from "./GatewayAsyncState.ts";

export function useGatewayRpc<Method extends GatewayRpcMethod>(
  method: Method,
  params: GatewayRpcParams<Method>,
  options: { enabled?: boolean; deps?: readonly unknown[] } = {},
): GatewayAsyncState<GatewayRpcPayload<Method>> {
  const client = useSmithersGateway();
  const enabled = options.enabled ?? true;
  const paramsKey = useMemo(() => JSON.stringify(params ?? {}), [params]);
  const deps = options.deps ?? [paramsKey];
  const paramsRef = useRef(params);
  const previousEffectRef = useRef<{
    client: typeof client;
    enabled: boolean;
    method: Method;
    deps: readonly unknown[];
  } | undefined>(undefined);
  paramsRef.current = params;
  const generationRef = useRef(0);
  const [data, setData] = useState<GatewayRpcPayload<Method>>();
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
      const payload = await client.rpc(method, paramsRef.current);
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
  }, [client, enabled, method]);

  useEffect(() => {
    const previous = previousEffectRef.current;
    const changed = !previous ||
      previous.client !== client ||
      previous.enabled !== enabled ||
      previous.method !== method ||
      previous.deps.length !== deps.length ||
      deps.some((dep, index) => !Object.is(dep, previous.deps[index]));
    previousEffectRef.current = { client, enabled, method, deps: [...deps] };
    if (changed) {
      void refetch();
    }
  });

  useEffect(() => {
    return () => {
      generationRef.current += 1;
    };
  }, []);

  return { data, error, loading, refetch };
}
