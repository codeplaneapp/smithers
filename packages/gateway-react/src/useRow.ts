import { useMemo } from "react";
import type { GatewayAsyncState } from "./GatewayAsyncState.ts";
import { normalizeRow } from "./rows.ts";
import { useGatewayNodeOutput } from "./useGatewayNodeOutput.ts";

/**
 * `useGatewayNodeOutput` with the row normalized: the `{ row }` / `{ data }`
 * envelope unwrapped, JSON-string values parsed, and snake_case keys aliased to
 * camelCase (see {@link normalizeRow}). Same `GatewayAsyncState` contract as
 * the other hooks; `data` is undefined until a row arrives.
 */
export function useRow<T = Record<string, unknown>>(args: {
  runId?: string;
  nodeId?: string;
  iteration?: number;
}): GatewayAsyncState<T | undefined> {
  const out = useGatewayNodeOutput({ runId: args.runId, nodeId: args.nodeId, iteration: args.iteration });
  const data = useMemo(
    () => (out.data === undefined || out.data === null ? undefined : (normalizeRow(out.data) as T)),
    [out.data],
  );
  return { data, error: out.error, loading: out.loading, refetch: out.refetch };
}
