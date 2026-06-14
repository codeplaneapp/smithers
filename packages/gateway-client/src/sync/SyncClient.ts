import { SyncCache, type SyncCacheEntry, type SyncCacheOptions } from "./SyncCache.ts";
import type { SyncKey } from "./SyncKey.ts";
import type { SyncStreamFrame, SyncTransport } from "./SyncTransport.ts";
import { SyncSubscriptionHub, type SyncSubscriptionOptions } from "./SyncSubscriptionHub.ts";

/**
 * TRANSITIONAL SHIM. The bespoke sync core (`SyncClient` / `SyncCache` /
 * `SyncSubscriptionHub`) is being replaced by TanStack DB collections built with
 * `createGatewayCollection`. It is kept exported so `@smithers-orchestrator/gateway-react`
 * and `apps/smithers` keep compiling while they migrate onto the new collection
 * hooks. Build new code on `createGatewayCollection` + `gatewayCollectionDefs`;
 * remove this once every consumer is off it.
 *
 * The top-level handle a consumer holds. `SyncClient` owns:
 *
 *  - one `SyncCache` (the source of truth)
 *  - one `SyncSubscriptionHub` (multiplexes streams)
 *  - the configured `SyncTransport` (gateway-client, custom UI postMessage,
 *    a fake in tests, …)
 *
 * It does NOT do anything React-specific — the React hooks (`useSyncQuery`,
 * `useSyncMutation`, `useSyncSubscription`) live on top via context.
 *
 * Stale-while-revalidate: `query()` returns cached data immediately when fresh
 * (within `staleTimeMs`) and triggers a background refetch when stale; the
 * cache's generation guard discards out-of-order responses so a slow refetch
 * cannot trample a newer one.
 */

export type SyncFetcher<T> = () => Promise<T>;

export type SyncQueryOptions = {
  /** Treat cached data as fresh for this long. Default 0 — always refetch. */
  staleTimeMs?: number;
};

export type SyncMutationOptions<TVars, TData, TContext = unknown> = {
  /**
   * Called before the mutation fires. Return a context (rollback snapshot)
   * the SDK will hand back to `onError` for symmetric undo of optimistic
   * cache writes.
   */
  onMutate?: (vars: TVars, client: SyncClient) => TContext | Promise<TContext>;
  onSuccess?: (data: TData, vars: TVars, context: TContext, client: SyncClient) => void | Promise<void>;
  onError?: (error: Error, vars: TVars, context: TContext | undefined, client: SyncClient) => void | Promise<void>;
  /** Keys (or key prefixes) to invalidate after a settled mutation. */
  invalidate?: ReadonlyArray<SyncKey>;
};

export type SyncClientOptions = {
  transport: SyncTransport;
  cache?: SyncCacheOptions;
  subscription?: SyncSubscriptionOptions;
  /**
   * Top-level auth bailout. Triggered on any RPC or stream returning an
   * UNAUTHORIZED-shaped error; apps/smithers wires this to `handleAuthRequired`.
   */
  onAuthError?: (error: Error) => void;
};

function isAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /^(UNAUTHORIZED|Unauthorized|FORBIDDEN|Forbidden)\b/.test(message);
}

export class SyncClient {
  readonly cache: SyncCache;
  readonly hub: SyncSubscriptionHub;
  readonly transport: SyncTransport;
  private readonly fetchers = new Map<string, SyncFetcher<unknown>>();
  private readonly onAuthError: ((error: Error) => void) | undefined;

  constructor(options: SyncClientOptions) {
    this.transport = options.transport;
    this.cache = new SyncCache(options.cache);
    this.onAuthError = options.onAuthError;
    this.hub = new SyncSubscriptionHub(this.cache, this.transport, {
      ...options.subscription,
      onAuthError: (error) => {
        options.subscription?.onAuthError?.(error);
        this.onAuthError?.(error);
      },
    });
  }

  /**
   * Run `fetcher` for `key`, deduping concurrent callers and respecting
   * `staleTimeMs`. The fetcher is also memoized per key so background
   * invalidation can refetch without callers needing to re-pass it.
   */
  query<T>(key: SyncKey, fetcher: SyncFetcher<T>, options: SyncQueryOptions = {}): Promise<T> {
    this.fetchers.set(this.cache.ensure(key).fingerprint, fetcher as SyncFetcher<unknown>);
    const staleTimeMs = options.staleTimeMs ?? 0;
    const entry = this.cache.peek<T>(key);
    if (entry && entry.status === "success" && entry.data !== undefined && !this.cache.isStale(key, staleTimeMs)) {
      return Promise.resolve(entry.data);
    }
    return this.cache.fetch(key, fetcher).catch((cause) => {
      if (cause instanceof Error && isAuthError(cause)) this.onAuthError?.(cause);
      throw cause;
    });
  }

  /** Latest cached entry for `key`, or undefined if never touched. */
  peek<T>(key: SyncKey): SyncCacheEntry<T> | undefined {
    return this.cache.peek<T>(key);
  }

  /**
   * Mark `prefix` stale and refetch every active observer's entry via its
   * stored fetcher. Mirrors react-query's `invalidateQueries`.
   */
  invalidate(prefix: SyncKey): Promise<void> {
    return this.cache.invalidate(prefix, async (entry) => {
      const fetcher = this.fetchers.get(entry.fingerprint);
      if (!fetcher) return;
      await this.cache.fetch(entry.key, fetcher).catch((cause) => {
        if (cause instanceof Error && isAuthError(cause)) this.onAuthError?.(cause);
      });
    });
  }

  /**
   * Run a mutation, optionally optimistically writing cache data, awaiting the
   * RPC, and rolling back on failure. Returns the RPC payload on success and
   * rethrows on failure so callers see the original error.
   */
  async mutate<TVars, TData, TContext = unknown>(
    runner: (vars: TVars) => Promise<TData>,
    vars: TVars,
    options: SyncMutationOptions<TVars, TData, TContext> = {},
  ): Promise<TData> {
    let context: TContext | undefined;
    if (options.onMutate) {
      context = await options.onMutate(vars, this);
    }
    try {
      const data = await runner(vars);
      if (options.onSuccess) {
        await options.onSuccess(data, vars, context as TContext, this);
      }
      if (options.invalidate) {
        for (const prefix of options.invalidate) {
          await this.invalidate(prefix);
        }
      }
      return data;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (options.onError) {
        await options.onError(error, vars, context, this);
      }
      if (isAuthError(error)) this.onAuthError?.(error);
      throw error;
    }
  }

  /**
   * Subscribe to a streaming source through the multiplexing hub. The first
   * subscriber opens the upstream; the last unsubscribe closes it. Each frame
   * is delivered synchronously; subscribers should buffer in their own state
   * to avoid blocking siblings.
   */
  subscribe(
    key: SyncKey,
    scope: string,
    params: unknown,
    listener: (frame: SyncStreamFrame) => void,
  ): () => void {
    return this.hub.subscribe(key, scope, params, listener);
  }

  /** Pass-through for direct RPC (mutation wiring, ad-hoc commands). */
  rpc<T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    return this.transport.rpc(method, params, { signal }).then(
      (value) => value as T,
      (cause) => {
        if (cause instanceof Error && isAuthError(cause)) this.onAuthError?.(cause);
        throw cause;
      },
    );
  }

  /** Wipe cache + close all streams. Used on hard logout. */
  reset(): void {
    this.hub.closeAll();
    this.cache.clear();
    this.fetchers.clear();
  }
}
