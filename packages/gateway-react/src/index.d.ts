import * as react from 'react';
import { ReactElement, ReactNode } from 'react';
import * as _smithers_orchestrator_gateway_client from '@smithers-orchestrator/gateway-client';
import { SmithersGatewayClientOptions, WorkspaceMode, SmithersGatewayClient, SmithersDataClient, SmithersCollections, GatewayCronRow, GatewayMemoryFactRow, GatewayPromptRow, GatewayScoreRow, GatewayTicketRow, GatewayRpcParams, GatewayRpcPayload, GatewayEventFrame, GatewayBackoffOptions, GatewayRunNode } from '@smithers-orchestrator/gateway-client';
import * as _tanstack_react_query from '@tanstack/react-query';
import { QueryClient } from '@tanstack/react-query';
import * as _smithers_orchestrator_gateway_rpc from '@smithers-orchestrator/gateway/rpc';
import { ListApprovalsRequest, ListApprovalsResponse, CronListRequest, ListTicketsRequest, GatewayRpcMethod, ListRunsRequest, ListWorkflowsRequest, ListWorkflowsResponse } from '@smithers-orchestrator/gateway/rpc';

declare function createGatewayReactRoot(element: ReactElement, options?: SmithersGatewayClientOptions & {
    rootId?: string;
    mode?: WorkspaceMode;
}): SmithersGatewayClient;

declare const SmithersGatewayContext: react.Context<SmithersGatewayClient | null>;

declare function SmithersGatewayProvider(props: {
    client?: SmithersGatewayClient;
    options?: SmithersGatewayClientOptions;
    mode?: WorkspaceMode;
    children?: ReactNode;
}): react.FunctionComponentElement<react.ProviderProps<SmithersGatewayClient | null>>;

type SmithersCollectionsContextValue = {
    client: SmithersDataClient;
    collections: SmithersCollections;
    queryClient: QueryClient;
};
declare const SmithersCollectionsContext: react.Context<SmithersCollectionsContextValue | null>;

declare function SmithersCollectionsProvider(props: {
    mode?: WorkspaceMode;
    client?: SmithersDataClient;
    queryClient?: QueryClient;
    children?: ReactNode;
}): react.FunctionComponentElement<_tanstack_react_query.QueryClientProviderProps> | null;

declare function useGatewayActions(): {
    launchRun: (params: _smithers_orchestrator_gateway_rpc.LaunchRunRequest) => Promise<_smithers_orchestrator_gateway_rpc.LaunchRunResponse & {
        seq?: number;
        txid?: string;
    }>;
    resumeRun: (params: _smithers_orchestrator_gateway_rpc.ResumeRunRequest) => Promise<_smithers_orchestrator_gateway_rpc.ResumeRunResponse & {
        seq?: number;
        txid?: string;
    }>;
    cancelRun: (params: _smithers_orchestrator_gateway_rpc.CancelRunRequest) => Promise<_smithers_orchestrator_gateway_rpc.CancelRunResponse & {
        seq?: number;
        txid?: string;
    }>;
    hijackRun: (params: _smithers_orchestrator_gateway_rpc.HijackRunRequest) => Promise<_smithers_orchestrator_gateway_rpc.HijackRunResponse & {
        seq?: number;
        txid?: string;
    }>;
    rewindRun: (params: _smithers_orchestrator_gateway_rpc.RewindRunRequest) => Promise<Record<string, unknown> & {
        seq?: number;
        txid?: string;
    }>;
    submitApproval: (params: _smithers_orchestrator_gateway_rpc.SubmitApprovalRequest & {
        approvalId?: string;
    }) => Promise<_smithers_orchestrator_gateway_rpc.SubmitApprovalResponse & {
        seq?: number;
        txid?: string;
    }>;
    submitSignal: (params: _smithers_orchestrator_gateway_rpc.SubmitSignalRequest) => Promise<Record<string, unknown> & {
        seq?: number;
        txid?: string;
    }>;
    cronCreate: (params: _smithers_orchestrator_gateway_rpc.CronCreateRequest) => Promise<_smithers_orchestrator_gateway_client.GatewayCronRow & {
        seq?: number;
        txid?: string;
    }>;
    cronDelete: (params: _smithers_orchestrator_gateway_rpc.CronDeleteRequest) => Promise<Record<string, unknown> & {
        seq?: number;
        txid?: string;
    }>;
    cronRun: (params: _smithers_orchestrator_gateway_rpc.CronRunRequest) => Promise<_smithers_orchestrator_gateway_rpc.LaunchRunResponse & {
        seq?: number;
        txid?: string;
    }>;
    createTicket: (params: _smithers_orchestrator_gateway_rpc.CreateTicketRequest) => Promise<_smithers_orchestrator_gateway_client.GatewayTicketRow & {
        seq?: number;
        txid?: string;
    }>;
    updateTicket: (params: _smithers_orchestrator_gateway_rpc.UpdateTicketRequest) => Promise<_smithers_orchestrator_gateway_client.GatewayTicketRow & {
        seq?: number;
        txid?: string;
    }>;
    deleteTicket: (params: _smithers_orchestrator_gateway_rpc.DeleteTicketRequest) => Promise<{
        path: string;
        deleted: boolean;
    } & {
        seq?: number;
        txid?: string;
    }>;
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

/**
 * Live cron-schedule list over the `crons` collection (initial `cronList`,
 * re-pulled on `invalidate` — e.g. after a `cronCreate` / `cronDelete` / `cronRun`
 * mutation). `cronList` returns ALL crons (enabled + disabled), so disabled rows
 * surface too. Same `GatewayAsyncState` shape the other typed gateway hooks
 * return (mirrors `useGatewayApprovals`).
 */
declare function useGatewayCrons(params?: CronListRequest): GatewayAsyncState<GatewayCronRow[]>;

/**
 * Live cross-run memory facts over the `memoryFacts` collection (initial
 * `listMemoryFacts`, re-pulled on `invalidate`). Pass a `namespace` to scope the
 * list to one namespace; omit it to list every namespace's facts. The facts are
 * read-only on the wire (no write RPC), so this hook is query-only — the same
 * `GatewayAsyncState` shape the other typed gateway hooks return (mirrors
 * `useGatewayCrons`).
 */
declare function useGatewayMemoryFacts(namespace?: string): GatewayAsyncState<GatewayMemoryFactRow[]>;

type MutationState<TVariables, TData> = {
    mutate: (variables: TVariables) => Promise<TData>;
    mutateSafe: (variables: TVariables) => Promise<TData | undefined>;
    isLoading: boolean;
    error: Error | undefined;
};
type MutationOptions = {
    invalidate?: readonly unknown[];
};
declare function useGatewayMutation<TVariables = Record<string, unknown>, TData = unknown>(method: string, _options?: MutationOptions): MutationState<TVariables, TData>;

/**
 * Live registered-prompt list over the `prompts` collection (initial
 * `listPrompts`, re-pulled on `invalidate`). The gateway enumerates the
 * `.smithers/prompts/**.{md,mdx}` files on disk, so the rows are read-only on the
 * wire (no write RPC) and this hook is query-only — the same `GatewayAsyncState`
 * shape the other typed gateway hooks return (mirrors `useGatewayMemoryFacts`).
 */
declare function useGatewayPrompts(): GatewayAsyncState<GatewayPromptRow[]>;

/**
 * Live scorer/eval results for one run over the `scores` collection (initial
 * `listScores`, re-pulled on `invalidate`). Pass a `runId` to list every score
 * the run recorded; pass `nodeId` too to scope to one node. Scores are read-only
 * on the wire (no write RPC), so this hook is query-only — the same
 * `GatewayAsyncState` shape the other typed gateway hooks return (mirrors
 * `useGatewayMemoryFacts`).
 *
 * An empty `runId` resolves to a stable, empty collection (no run selected yet),
 * so consumers can call the hook unconditionally and render the empty state.
 */
declare function useGatewayScores(runId: string, nodeId?: string): GatewayAsyncState<GatewayScoreRow[]>;

/**
 * Live work docs (tickets/plans/specs/proposals) over the `tickets` collection
 * (initial `listTickets`, re-pulled on `invalidate` — e.g. after a
 * `createTicket` / `updateTicket` / `deleteTicket` mutation). `listTickets`
 * returns only LIVE docs (soft-deleted tombstones are filtered server-side), so
 * every row here is renderable. Pass a `kind` to scope to one doc kind; omit it
 * to list every kind. Same `GatewayAsyncState` shape the other typed gateway
 * hooks return (mirrors `useGatewayCrons` / `useGatewayMemoryFacts`).
 */
declare function useGatewayTickets(params?: ListTicketsRequest): GatewayAsyncState<GatewayTicketRow[]>;

declare function useGatewayNodeOutput(params: {
    runId: string | undefined;
    nodeId: string | undefined;
    iteration?: number;
}): {
    data: Record<string, unknown> | undefined;
    error: Error | undefined;
    loading: boolean;
    refetch: () => Promise<void>;
};

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
 * Live run-event buffer over the bounded `runEvents` collection. Local mode
 * refetches after SSE invalidation; multiplayer mode follows the Electric
 * events shape. Heartbeats remain normal collection rows and are filtered in
 * this hook: the latest heartbeat is returned as `lastHeartbeat`, while
 * `events` contains only non-heartbeat frames capped to `maxEvents` with the
 * most recent rows retained.
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
 *   aborts the prior subscription via its `AbortController`, so frames from it
 *   that arrive late are ignored.
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

/** The six tones the run UI knows; mirrors `snapshotToGatewayRunNode`'s output. */
type NodeStatus = "ok" | "running" | "queued" | "failed" | "waiting" | "cancelled";
type UseGatewayRunTreeResult = {
    /** The run tree with `children` rebuilt from the flat collection, or null when empty. */
    root: GatewayRunNode | null;
    /** Every flattened node row, keyed by `runNodeKey` (the row `key`, `id` fallback) in the collection. */
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

declare function useSmithersCollections(): SmithersCollectionsContextValue;

export { type GatewayAsyncState, type GatewayConnectionState, type GatewayConnectionStatus, type GatewayExtensionStreamState, type NodeStatus, SmithersCollectionsContext, type SmithersCollectionsContextValue, SmithersCollectionsProvider, SmithersGatewayContext, SmithersGatewayProvider, type UseGatewayConnectionStatusResult, type UseGatewayRunTreeResult, createGatewayReactRoot, useGatewayActions, useGatewayApprovals, useGatewayConnectionStatus, useGatewayCrons, useGatewayExtensionAction, useGatewayExtensionResource, useGatewayExtensionStream, useGatewayMemoryFacts, useGatewayMutation, useGatewayNodeOutput, useGatewayPrompts, useGatewayRpc, useGatewayRun, useGatewayRunEvents, useGatewayRunTree, useGatewayRuns, useGatewayScores, useGatewayTickets, useGatewayWorkflows, useSmithersCollections, useSmithersGateway };
