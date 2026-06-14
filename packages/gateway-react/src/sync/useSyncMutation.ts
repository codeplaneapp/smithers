import { useCallback, useRef, useSyncExternalStore } from "react";
import type { SyncKey } from "@smithers-orchestrator/gateway-client";
import { useSyncClient } from "./useSyncClient.ts";
import type { GatewayCollections } from "./GatewayCollections.ts";

/**
 * A mutation hook with optimistic updates + invalidate-on-success over the
 * `GatewayCollections` registry. `runner` performs the write (typically
 * `registry.rpc(method, vars)`); `onMutate` may stage an optimistic value via
 * `registry.setQueryData` and return a rollback context for `onError`.
 *
 * Status is tracked in a tiny vanilla observer (not React state) so the hook
 * stays useEffect-free and re-renders are driven by `useSyncExternalStore`.
 */

export type UseSyncMutationStatus = "idle" | "loading" | "success" | "error";

export type SyncMutationOptions<TVars, TData, TContext = unknown> = {
  /**
   * Called before the mutation fires. Return a context (rollback snapshot) the
   * hook hands back to `onError` for symmetric undo of optimistic cache writes.
   */
  onMutate?: (vars: TVars, registry: GatewayCollections) => TContext | Promise<TContext>;
  onSuccess?: (data: TData, vars: TVars, context: TContext, registry: GatewayCollections) => void | Promise<void>;
  onError?: (
    error: Error,
    vars: TVars,
    context: TContext | undefined,
    registry: GatewayCollections,
  ) => void | Promise<void>;
  /** Keys (or key prefixes) to invalidate after a successful mutation. */
  invalidate?: ReadonlyArray<SyncKey>;
};

export type UseSyncMutationResult<TVars, TData> = {
  mutate: (vars: TVars) => Promise<TData>;
  /** Like `mutate` but swallows errors and returns undefined on failure. */
  mutateSafe: (vars: TVars) => Promise<TData | undefined>;
  status: UseSyncMutationStatus;
  isLoading: boolean;
  data: TData | undefined;
  error: Error | undefined;
  reset: () => void;
};

type State<TData> = {
  status: UseSyncMutationStatus;
  data: TData | undefined;
  error: Error | undefined;
};

function createMutationStore<TData>() {
  let state: State<TData> = { status: "idle", data: undefined, error: undefined };
  const listeners = new Set<() => void>();
  return {
    get(): State<TData> {
      return state;
    },
    set(next: State<TData>): void {
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useSyncMutation<TVars, TData, TContext = unknown>(
  runner: (vars: TVars) => Promise<TData>,
  options: SyncMutationOptions<TVars, TData, TContext> = {},
): UseSyncMutationResult<TVars, TData> {
  const registry = useSyncClient();
  const runnerRef = useRef(runner);
  runnerRef.current = runner;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const storeRef = useRef<ReturnType<typeof createMutationStore<TData>> | null>(null);
  if (!storeRef.current) storeRef.current = createMutationStore<TData>();
  const store = storeRef.current;

  const state = useSyncExternalStore(store.subscribe, store.get, store.get);

  const mutate = useCallback(
    async (vars: TVars) => {
      const opts = optionsRef.current;
      store.set({ status: "loading", data: undefined, error: undefined });
      let context: TContext | undefined;
      try {
        context = await opts.onMutate?.(vars, registry);
        const data = await runnerRef.current(vars);
        await opts.onSuccess?.(data, vars, context as TContext, registry);
        for (const key of opts.invalidate ?? []) {
          await registry.invalidate(key);
        }
        store.set({ status: "success", data, error: undefined });
        return data;
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        await opts.onError?.(error, vars, context, registry);
        store.set({ status: "error", data: undefined, error });
        throw error;
      }
    },
    [registry, store],
  );

  const mutateSafe = useCallback(
    async (vars: TVars) => {
      try {
        return await mutate(vars);
      } catch {
        return undefined;
      }
    },
    [mutate],
  );

  const reset = useCallback(() => {
    store.set({ status: "idle", data: undefined, error: undefined });
  }, [store]);

  return {
    mutate,
    mutateSafe,
    status: state.status,
    isLoading: state.status === "loading",
    data: state.data,
    error: state.error,
    reset,
  };
}
