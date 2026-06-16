import { useMemo } from "react";
import { useSyncClient } from "./useSyncClient.ts";
import {
  useSyncMutation,
  type SyncMutationOptions,
  type UseSyncMutationResult,
} from "./useSyncMutation.ts";

/**
 * A typed mutation hook for known gateway RPCs. Caller passes the method name
 * (`launchRun`, `submitApproval`, …) and the hook wires the runner to
 * `registry.rpc`, including optional optimistic writes, rollback, and
 * invalidate-on-success via `SyncMutationOptions`.
 */
export function useGatewayMutation<TVars extends Record<string, unknown>, TData = unknown>(
  method: string,
  options: SyncMutationOptions<TVars, TData> = {},
): UseSyncMutationResult<TVars, TData> {
  const registry = useSyncClient();
  const runner = useMemo(
    () => (vars: TVars) => registry.rpc<TData>(method, vars),
    [registry, method],
  );
  return useSyncMutation<TVars, TData>(runner, options);
}
