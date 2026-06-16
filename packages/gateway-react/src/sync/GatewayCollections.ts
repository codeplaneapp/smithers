import type { Collection } from "@tanstack/react-db";
import type {
  GatewayApprovalRow,
  GatewayRunEventRow,
  GatewayRunNode,
  GatewayRunRow,
  GatewayRunSummaryRow,
  GatewayWorkflowRow,
  GatewayConnectionState,
  SyncKey,
  SyncStreamFrame,
  SyncTransport,
} from "@smithers-orchestrator/gateway-client";
import type {
  ListApprovalsRequest,
  ListRunsRequest,
  ListWorkflowsRequest,
} from "@smithers-orchestrator/gateway/rpc";

/**
 * The cache entry the generic `useSyncQuery` path stores per `SyncKey`. Status,
 * data, and error all live IN the row so a single `useLiveQuery` subscription
 * carries every transition reactively. `revision` guarantees a re-fetch that
 * returns a structurally-identical value still registers as a change.
 */
export type GatewayQueryRow<T> = {
  key: string;
  status: "idle" | "loading" | "success" | "error";
  value: T | undefined;
  error: Error | undefined;
  revision: number;
};

export type GatewayCollectionStatusRow = {
  key: string;
  status: "idle" | "loading" | "success" | "error";
  error: Error | undefined;
  revision: number;
};

export type GatewayQueryHandle<T> = {
  collection: Collection<GatewayQueryRow<T>, string>;
  refetch: () => Promise<T | undefined>;
};

/** One row of a bounded streaming-subscription collection (`useSyncSubscription`). */
export type GatewayStreamRow = {
  id: number;
  frame: SyncStreamFrame;
};

export type GatewayStreamHandle = {
  collection: Collection<GatewayStreamRow, number>;
  /** Total frames ever observed; `dropped = totalSeen - rows.length` once the ring fills. */
  stats: { totalSeen: number };
};

export type GatewayOptimisticMutationRequest<TVars, TData> = {
  method: string;
  vars: TVars;
  commit: (vars: TVars) => Promise<TData>;
};

/**
 * The registry handed to `<SyncProvider>`. It owns one TanStack DB collection
 * per gateway resource (built with `createGatewayCollection` over the app's
 * instrumented transport) plus the generic query/stream collections the
 * declarative sync hooks resolve on demand. A single collection per `SyncKey`
 * id is what gives every `useLiveQuery` subscriber a shared upstream — the
 * multiplexing the old `SyncSubscriptionHub` provided falls out for free.
 *
 * apps/smithers builds this from `createGatewayCollections` over its wrapped
 * `getGatewayClient()` so auth, CSRF, same-origin proxying, and observability
 * stay in one place; embedded custom UIs get one for free via
 * `createGatewayReactRoot`.
 */
export type GatewayCollections = {
  /** The instrumented transport, for one-shot mutations / generic RPCs. */
  readonly client: SyncTransport;

  /** Fire a one-shot gateway RPC through the instrumented transport. */
  rpc<T = unknown>(method: string, params: unknown, options?: { signal?: AbortSignal }): Promise<T>;

  /** Re-pull every memoized collection/query whose key matches `prefix`. */
  invalidate(prefix: SyncKey): Promise<void>;
  /**
   * Apply a known gateway write through TanStack DB optimistic transactions.
   * Returns undefined for unknown writes so callers can fall back to plain RPC.
   */
  optimisticMutation<TVars, TData>(
    request: GatewayOptimisticMutationRequest<TVars, TData>,
  ): Promise<TData> | undefined;

  runs(params?: ListRunsRequest): Collection<GatewayRunSummaryRow, string>;
  run(runId: string): Collection<GatewayRunRow, string>;
  workflows(params?: ListWorkflowsRequest): Collection<GatewayWorkflowRow, string>;
  approvals(params?: ListApprovalsRequest): Collection<GatewayApprovalRow, string>;
  /** Flattened devtools run-node tree, reconciled per devtools frame. */
  nodes(runId: string): Collection<GatewayRunNode, string>;
  /** Bounded append-only run-event ring. */
  runEvents(runId: string): Collection<GatewayRunEventRow, number>;

  /** Resolve (or create) the generic single-value query collection for `key`. */
  query<T>(key: SyncKey, fetcher: () => Promise<T>): GatewayQueryHandle<T>;
  /** Resolve (or create) the bounded streaming collection for `key`. */
  stream(key: SyncKey, scope: string, params: unknown, maxFrames: number): GatewayStreamHandle;
  /** Shared sidecar row carrying collection load/error state. */
  collectionStatus(key: SyncKey): Collection<GatewayCollectionStatusRow, string>;

  /** Read the current value cached for a generic query `key` (optimistic helpers). */
  getQueryData<T>(key: SyncKey): T | undefined;
  /** Optimistically overwrite a generic query value; returns the prior value for rollback. */
  setQueryData<T>(key: SyncKey, value: T): { previous: T | undefined };

  connection(): GatewayConnectionState;
  subscribeConnection(listener: () => void): () => void;

  /**
   * Lazily (re)establish the link with a lightweight `listRuns` probe so the
   * connection observer flips to online/offline/unauthorized. Replaces the app's
   * `ensureConnected()`; mounting any live hook also connects on its own.
   */
  connect(): Promise<void>;
  /** Drop cached collections and reset the connection observer (sign-out / remote-mode swap). */
  reset(): void;
};
