import * as react from 'react';
import { ReactElement, ReactNode } from 'react';
import * as _smithers_orchestrator_gateway_client from '@smithers-orchestrator/gateway-client';
import { SmithersGatewayClientOptions, SmithersGatewayClient, GatewayRpcParams, GatewayRpcPayload, GatewayEventFrame, GatewayBackoffOptions, SyncTransport, SyncKey, GatewayRunSummaryRow, GatewayRunRow, GatewayWorkflowRow, GatewayApprovalRow, GatewayRunNode, GatewayRunEventRow, SyncStreamFrame } from '@smithers-orchestrator/gateway-client';
import * as _smithers_orchestrator_gateway_rpc from '@smithers-orchestrator/gateway/rpc';
import { ListApprovalsRequest, ListApprovalsResponse, GatewayRpcMethod, ListRunsRequest, ListWorkflowsRequest, ListWorkflowsResponse } from '@smithers-orchestrator/gateway/rpc';
import { Collection } from '@tanstack/react-db';

declare function createGatewayReactRoot(element: ReactElement, options?: SmithersGatewayClientOptions & {
    rootId?: string;
}): SmithersGatewayClient;

declare const SmithersGatewayContext: react.Context<SmithersGatewayClient | null>;

declare function SmithersGatewayProvider(props: {
    client?: SmithersGatewayClient;
    options?: SmithersGatewayClientOptions;
    children?: ReactNode;
}): react.FunctionComponentElement<react.ProviderProps<SmithersGatewayClient | null>>;

declare function useGatewayActions(): {
    launchRun: (params: _smithers_orchestrator_gateway_client.GatewayRpcParams<"launchRun">) => Promise<_smithers_orchestrator_gateway_rpc.LaunchRunResponse>;
    resumeRun: (params: _smithers_orchestrator_gateway_client.GatewayRpcParams<"resumeRun">) => Promise<_smithers_orchestrator_gateway_rpc.ResumeRunResponse>;
    cancelRun: (params: _smithers_orchestrator_gateway_client.GatewayRpcParams<"cancelRun">) => Promise<_smithers_orchestrator_gateway_rpc.CancelRunResponse>;
    hijackRun: (params: _smithers_orchestrator_gateway_client.GatewayRpcParams<"hijackRun">) => Promise<_smithers_orchestrator_gateway_rpc.HijackRunResponse>;
    rewindRun: (params: _smithers_orchestrator_gateway_client.GatewayRpcParams<"rewindRun">) => Promise<Record<string, unknown>>;
    submitApproval: (params: _smithers_orchestrator_gateway_client.GatewayRpcParams<"submitApproval">) => Promise<_smithers_orchestrator_gateway_rpc.SubmitApprovalResponse>;
    submitSignal: (params: _smithers_orchestrator_gateway_client.GatewayRpcParams<"submitSignal">) => Promise<Record<string, unknown>>;
    cronCreate: (params: _smithers_orchestrator_gateway_client.GatewayRpcParams<"cronCreate">) => Promise<Record<string, unknown>>;
    cronDelete: (params: _smithers_orchestrator_gateway_client.GatewayRpcParams<"cronDelete">) => Promise<Record<string, unknown>>;
    cronRun: (params: _smithers_orchestrator_gateway_client.GatewayRpcParams<"cronRun">) => Promise<_smithers_orchestrator_gateway_rpc.LaunchRunResponse>;
};

type GatewayAsyncState<T> = {
    data: T | undefined;
    error: Error | undefined;
    loading: boolean;
    refetch: () => Promise<void>;
};

/**
 * Live pending-approval list over the `approvals` collection (initial
 * `listApprovals`, re-pulled on `invalidate` — e.g. after a run reaches
 * waiting-approval or a `submitApproval` mutation). Same `GatewayAsyncState`
 * shape the RPC hook returned.
 */
declare function useGatewayApprovals(params?: ListApprovalsRequest): GatewayAsyncState<ListApprovalsResponse>;

declare function useGatewayNodeOutput(params: {
    runId: string | undefined;
    nodeId: string | undefined;
    iteration?: number;
}): GatewayAsyncState<Record<string, unknown>>;

declare function useGatewayRpc<Method extends GatewayRpcMethod>(method: Method, params: GatewayRpcParams<Method>, options?: {
    enabled?: boolean;
    deps?: readonly unknown[];
}): GatewayAsyncState<GatewayRpcPayload<Method>>;

/**
 * Live single-run record over the `run` collection (initial `getRun` +
 * `streamRunEvents`, so each lifecycle frame upserts the row without a
 * whole-tree refetch). Same `GatewayAsyncState` shape the RPC hook returned.
 */
declare function useGatewayRun(runId: string | undefined): GatewayAsyncState<GatewayRpcPayload<"getRun">>;

/**
 * Live run-event buffer over the bounded `runEvents` collection
 * (`streamRunEventsResilient` with afterSeq resume). Heartbeats are surfaced
 * separately via `lastHeartbeat` and never enter `events`; the events array is
 * capped to `maxEvents` (most-recent wins). Same return shape the streaming
 * hook had.
 */
declare function useGatewayRunEvents(runId: string | undefined, options?: {
    afterSeq?: number;
    maxEvents?: number;
}): {
    events: GatewayEventFrame[];
    lastHeartbeat: GatewayEventFrame | undefined;
    error: Error | undefined;
    streaming: boolean;
};

/**
 * Live run list over the `runs` collection (initial `listRuns`, re-pulled on
 * `invalidate`). Same `GatewayAsyncState` shape the RPC hook returned.
 */
declare function useGatewayRuns(params?: ListRunsRequest): GatewayAsyncState<GatewayRpcPayload<"listRuns">>;

/**
 * Live workflow list over the `workflows` collection (initial `listWorkflows`,
 * re-pulled on `invalidate`). Same `GatewayAsyncState` shape the RPC hook
 * returned.
 */
declare function useGatewayWorkflows(params?: ListWorkflowsRequest): GatewayAsyncState<ListWorkflowsResponse>;

declare function useSmithersGateway(): _smithers_orchestrator_gateway_client.SmithersGatewayClient;

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
declare function useGatewayExtensionResource<T = unknown>(namespace: string, key: string, params?: Record<string, unknown>, options?: {
    enabled?: boolean;
    deps?: readonly unknown[];
}): GatewayAsyncState<T>;

/**
 * Imperative caller for an extension action (write-side RPC). Mirrors the
 * `useGatewayActions` shape: returns a stable `.call(...)` plus loading/error
 * state. A new call cancels the previous (via generation counter) so a fast
 * double-click cannot resolve out of order and leave stale error/data on
 * screen.
 */
declare function useGatewayExtensionAction<TParams extends Record<string, unknown>, TPayload = unknown>(namespace: string, key: string): {
    call: (params: TParams) => Promise<TPayload>;
    pending: boolean;
    error: Error | undefined;
    data: TPayload | undefined;
};

type GatewayExtensionStreamState<T> = {
    frames: T[];
    latest: T | undefined;
    error: Error | undefined;
    streaming: boolean;
};
/**
 * Subscribe to an extension stream and reflect frames into React state. Bounded
 * by `maxFrames` (default 1000) so a chatty extension cannot OOM the UI; the
 * window slides forward, dropping the oldest frame.
 *
 * Reconnect/resume:
 * - A network drop (the underlying WS closing without the run ending) triggers
 *   exponential backoff with jitter, then resubscribes with the same params.
 * - The extension `subscribe()` handler is responsible for honoring a
 *   `params.afterSeq` (or extension-specific cursor) in its replay; the client
 *   has no way to replay frames the server hasn't kept.
 * - Stale frames are fenced: a re-render that changes `(namespace, key, params)`
 *   bumps a generation counter; frames from the prior subscription that arrive
 *   late are discarded.
 *
 * Slow-consumer backpressure: the server already enforces a per-connection
 * outbound queue; if the React app falls behind the gateway's bound, the gateway
 * closes the connection with `BackpressureDisconnect`. We surface that as an
 * error and the backoff loop will retry.
 */
declare function useGatewayExtensionStream<T = unknown>(namespace: string | undefined, key: string | undefined, params?: Record<string, unknown>, options?: {
    maxFrames?: number;
    enabled?: boolean;
    backoff?: GatewayBackoffOptions;
}): GatewayExtensionStreamState<T>;

/**
 * The connection lifecycle of the gateway link, derived from real transport
 * traffic (RPC resolves, stream frames, auth/transport errors). Mirrors the
 * union apps/smithers used to keep in its hand-rolled `GatewayStatus` store
 * field, now surfaced by `useGatewayConnectionStatus`.
 */
type GatewayConnectionStatus = "idle" | "connecting" | "online" | "offline" | "unauthorized";
type GatewayConnectionState = {
    status: GatewayConnectionStatus;
    /** Epoch ms of the first failure in the current offline streak; cleared on reconnect. */
    reconnectingSince?: number;
};

/**
 * The cache entry the generic `useSyncQuery` path stores per `SyncKey`. Status,
 * data, and error all live IN the row so a single `useLiveQuery` subscription
 * carries every transition reactively. `revision` guarantees a re-fetch that
 * returns a structurally-identical value still registers as a change.
 */
type GatewayQueryRow<T> = {
    key: string;
    status: "idle" | "loading" | "success" | "error";
    value: T | undefined;
    error: Error | undefined;
    revision: number;
};
type GatewayQueryHandle<T> = {
    collection: Collection<GatewayQueryRow<T>, string>;
    refetch: () => Promise<T | undefined>;
};
/** One row of a bounded streaming-subscription collection (`useSyncSubscription`). */
type GatewayStreamRow = {
    id: number;
    frame: SyncStreamFrame;
};
type GatewayStreamHandle = {
    collection: Collection<GatewayStreamRow, number>;
    /** Total frames ever observed; `dropped = totalSeen - rows.length` once the ring fills. */
    stats: {
        totalSeen: number;
    };
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
type GatewayCollections = {
    /** The instrumented transport, for one-shot mutations / generic RPCs. */
    readonly client: SyncTransport;
    /** Fire a one-shot gateway RPC through the instrumented transport. */
    rpc<T = unknown>(method: string, params: unknown, options?: {
        signal?: AbortSignal;
    }): Promise<T>;
    /** Re-pull every memoized collection/query whose key matches `prefix`. */
    invalidate(prefix: SyncKey): Promise<void>;
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
    /** Read the current value cached for a generic query `key` (optimistic helpers). */
    getQueryData<T>(key: SyncKey): T | undefined;
    /** Optimistically overwrite a generic query value; returns the prior value for rollback. */
    setQueryData<T>(key: SyncKey, value: T): {
        previous: T | undefined;
    };
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

/**
 * The React context that hands the `GatewayCollections` registry to every sync
 * hook. The default is `null` so consumers must wrap their tree in a
 * `SyncProvider` — surfacing the missing-provider error eagerly beats a silent
 * no-op.
 */
declare const SyncContext: react.Context<GatewayCollections | null>;

/**
 * Wraps a React subtree with a `GatewayCollections` registry so descendants can
 * call `useSyncQuery` / `useSyncMutation` / `useSyncSubscription` (and the typed
 * gateway hooks) against the same TanStack DB collections. apps/smithers mounts
 * a single provider at the root; embedded custom UIs can mount their own
 * per-workflow registry when they want isolation.
 *
 * The `client` prop name is preserved from the previous `SyncClient`-backed
 * provider; only its type changed to the collections registry.
 */
declare function SyncProvider(props: {
    client: GatewayCollections;
    children?: ReactNode;
}): ReactElement;

/**
 * The hook every other sync hook calls. Throws an explicit error when used
 * outside `<SyncProvider>` — a silent fallback would hide a wiring bug behind
 * confusing "data is undefined" symptoms.
 */
declare function useSyncClient(): GatewayCollections;

type CreateGatewayCollectionsOptions = {
    /**
     * The instrumented transport — apps/smithers passes one built over its
     * wrapped `getGatewayClient()` (so auth/CSRF/proxy/observability are
     * preserved); `createGatewayReactRoot` passes `createSmithersGatewayTransport`
     * over a fresh client.
     */
    client: SyncTransport;
    /** Top-level auth bailout (apps/smithers wires this to `handleAuthRequired`). */
    onAuthError?: (error: Error) => void;
    /** gcTime for the pollable list/query collections. Default 5 min. */
    listGcTime?: number;
};
declare function createGatewayCollections(options: CreateGatewayCollectionsOptions): GatewayCollections;

/**
 * Declarative data fetching for the sync registry. Backed by TanStack DB's
 * `useLiveQuery` over a single-value query collection: the collection's sync
 * runs the `fetcher`, and status / data / error ride in the stored row so a
 * single live subscription carries every transition.
 *
 * Behavior:
 *  - On mount `useLiveQuery` subscribes (starting the collection's sync) and the
 *    fetcher runs once.
 *  - Concurrent components with the same key share ONE collection (and one
 *    in-flight fetch) — multiplexing falls out of the per-key collection id.
 *  - `refetch()` forces a fresh fetch.
 *  - Unmount drops the subscription; the collection GCs after its `gcTime`.
 */
type UseSyncQueryResult<T> = {
    data: T | undefined;
    error: Error | undefined;
    status: "idle" | "loading" | "success" | "error";
    /** True when no data yet and a fetch is in flight. */
    isLoading: boolean;
    /** True when data exists and a refetch is in flight. */
    isRefreshing: boolean;
    refetch: () => Promise<T | undefined>;
};
type UseSyncQueryOptions = {
    /** Disable the query (skip subscribe + fetch). Used for conditional loads. */
    enabled?: boolean;
    /**
     * Treat cached data as fresh for this long. The registry memoizes a query
     * collection per key across mounts, so data within `gcTime` is reused without
     * a refetch; kept for API compatibility.
     */
    staleTimeMs?: number;
};
declare function useSyncQuery<T>(key: SyncKey, fetcher: () => Promise<T>, options?: UseSyncQueryOptions): UseSyncQueryResult<T>;

/**
 * A mutation hook with optimistic updates + invalidate-on-success over the
 * `GatewayCollections` registry. `runner` performs the write (typically
 * `registry.rpc(method, vars)`); `onMutate` may stage an optimistic value via
 * `registry.setQueryData` and return a rollback context for `onError`.
 *
 * Status is tracked in a tiny vanilla observer (not React state) so the hook
 * stays useEffect-free and re-renders are driven by `useSyncExternalStore`.
 */
type UseSyncMutationStatus = "idle" | "loading" | "success" | "error";
type SyncMutationOptions<TVars, TData, TContext = unknown> = {
    /**
     * Called before the mutation fires. Return a context (rollback snapshot) the
     * hook hands back to `onError` for symmetric undo of optimistic cache writes.
     */
    onMutate?: (vars: TVars, registry: GatewayCollections) => TContext | Promise<TContext>;
    onSuccess?: (data: TData, vars: TVars, context: TContext, registry: GatewayCollections) => void | Promise<void>;
    onError?: (error: Error, vars: TVars, context: TContext | undefined, registry: GatewayCollections) => void | Promise<void>;
    /** Keys (or key prefixes) to invalidate after a successful mutation. */
    invalidate?: ReadonlyArray<SyncKey>;
};
type UseSyncMutationResult<TVars, TData> = {
    mutate: (vars: TVars) => Promise<TData>;
    /** Like `mutate` but swallows errors and returns undefined on failure. */
    mutateSafe: (vars: TVars) => Promise<TData | undefined>;
    status: UseSyncMutationStatus;
    isLoading: boolean;
    data: TData | undefined;
    error: Error | undefined;
    reset: () => void;
};
declare function useSyncMutation<TVars, TData, TContext = unknown>(runner: (vars: TVars) => Promise<TData>, options?: SyncMutationOptions<TVars, TData, TContext>): UseSyncMutationResult<TVars, TData>;

/**
 * Subscribe to a streaming source (run events, devtools, …) through a bounded
 * stream collection in the registry. Returns the rolling buffer of frames +
 * stats. Heavy bursts are bounded by `maxFrames`; older frames drop off the
 * front so render time stays predictable on a hot run.
 *
 * N components subscribing to the same key share ONE collection (and one
 * upstream socket) — multiplexing falls out of the per-key collection id.
 * Disabling (`enabled: false`) drops the subscription; the collection's
 * `gcTime: 0` aborts the upstream when this was the last observer.
 */
type UseSyncSubscriptionOptions = {
    enabled?: boolean;
    /** Bounded buffer of recent frames the consumer can render. Default 200. */
    maxFrames?: number;
};
type UseSyncSubscriptionResult = {
    frames: ReadonlyArray<SyncStreamFrame>;
    last: SyncStreamFrame | undefined;
    /** Frames dropped off the front of the bounded buffer. */
    dropped: number;
};
declare function useSyncSubscription(key: SyncKey, scope: string, params: unknown, options?: UseSyncSubscriptionOptions): UseSyncSubscriptionResult;

/**
 * A typed convenience over `useSyncQuery` for ad-hoc gateway RPCs. Picks the
 * cache key from `gatewayKeys` (or any `SyncKey`), wires the fetcher to
 * `registry.rpc`, and gives consumers the same
 * `{data, error, status, refetch, isLoading}` shape they get from
 * `useGatewayRpc`.
 */
declare function useGatewayQuery<T = unknown>(key: SyncKey, method: string, params: Record<string, unknown>, options?: UseSyncQueryOptions): UseSyncQueryResult<T>;

/**
 * A typed mutation hook for known gateway RPCs. Caller passes the method name
 * (`launchRun`, `submitApproval`, …) and the hook wires the runner to
 * `registry.rpc`, including optional optimistic writes, rollback, and
 * invalidate-on-success via `SyncMutationOptions`.
 */
declare function useGatewayMutation<TVars extends Record<string, unknown>, TData = unknown>(method: string, options?: SyncMutationOptions<TVars, TData>): UseSyncMutationResult<TVars, TData>;

/**
 * Subscribe to a run's event stream. Delegates to the shared subscription hub
 * so N components watching the same run share one connection, and lastSeq is
 * persisted across reconnect via the cache. Pass `enabled=false` (or
 * `runId=undefined`) to skip the subscription entirely.
 */
declare function useGatewayRunStream(runId: string | undefined, options?: {
    maxFrames?: number;
}): UseSyncSubscriptionResult;

/** The five tones the run UI knows; mirrors `snapshotToGatewayRunNode`'s output. */
type NodeStatus = "ok" | "running" | "queued" | "failed" | "waiting";
type UseGatewayRunTreeResult = {
    /** The run tree with `children` rebuilt from the flat collection, or null when empty. */
    root: GatewayRunNode | null;
    /** Every flattened node row, keyed by id in the collection. */
    nodes: ReadonlyArray<GatewayRunNode>;
    /** The run-level status (the root node's status). */
    status: NodeStatus;
    isLoading: boolean;
    error: Error | undefined;
};
/**
 * Live query over the per-run `nodes` collection (initial `getDevToolsSnapshot`
 * + `streamDevTools`, reconciled into the collection). Consumers re-render only
 * for the nodes that actually changed instead of remounting the whole tree on
 * every devtools frame — the headline win over the old whole-tree refetch.
 */
declare function useGatewayRunTree(runId: string | undefined): UseGatewayRunTreeResult;

type UseGatewayConnectionStatusResult = {
    status: GatewayConnectionStatus;
    isOnline: boolean;
    /** Epoch ms of the first failure in the current offline streak, when offline. */
    reconnectingSince?: number;
};
/**
 * The gateway link's connection lifecycle, derived from real transport traffic
 * by the registry (RPC resolves / stream frames mark it online; transport
 * errors mark it offline; auth failures mark it unauthorized). Replaces the
 * hand-rolled `GatewayStatus` field apps/smithers kept in its zustand store.
 */
declare function useGatewayConnectionStatus(): UseGatewayConnectionStatusResult;

export { type CreateGatewayCollectionsOptions, type GatewayAsyncState, type GatewayCollections, type GatewayConnectionState, type GatewayConnectionStatus, type GatewayExtensionStreamState, type GatewayQueryHandle, type GatewayQueryRow, type GatewayStreamHandle, type GatewayStreamRow, type NodeStatus, SmithersGatewayContext, SmithersGatewayProvider, SyncContext, type SyncMutationOptions, SyncProvider, type UseGatewayConnectionStatusResult, type UseGatewayRunTreeResult, type UseSyncMutationResult, type UseSyncMutationStatus, type UseSyncQueryOptions, type UseSyncQueryResult, type UseSyncSubscriptionOptions, type UseSyncSubscriptionResult, createGatewayCollections, createGatewayReactRoot, useGatewayActions, useGatewayApprovals, useGatewayConnectionStatus, useGatewayExtensionAction, useGatewayExtensionResource, useGatewayExtensionStream, useGatewayMutation, useGatewayNodeOutput, useGatewayQuery, useGatewayRpc, useGatewayRun, useGatewayRunEvents, useGatewayRunStream, useGatewayRunTree, useGatewayRuns, useGatewayWorkflows, useSmithersGateway, useSyncClient, useSyncMutation, useSyncQuery, useSyncSubscription };
