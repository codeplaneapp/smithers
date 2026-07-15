import * as react from 'react';
import { ReactElement, ReactNode } from 'react';
import * as _smithers_orchestrator_gateway_client from '@smithers-orchestrator/gateway-client';
import { SmithersGatewayClientOptions, WorkspaceMode, SmithersGatewayClient, SmithersDataClient, SmithersCollections, GatewayCronRow, GatewayMemoryFactRow, GatewayPromptRow, GatewayScoreRow, GatewayTicketRow, GatewayRpcPayload as GatewayRpcPayload$1, GatewayEventFrame, GatewayBackoffOptions, GatewayRunNode } from '@smithers-orchestrator/gateway-client';
import * as _tanstack_react_query from '@tanstack/react-query';
import { QueryClient } from '@tanstack/react-query';
import { ListApprovalsRequest, ListApprovalsResponse, CronListRequest, ListTicketsRequest, GatewayRpcMethod, GatewayRpcParams, GatewayRpcPayload, ListRunsRequest, ListWorkflowsRequest, ListWorkflowsResponse } from '@smithers-orchestrator/gateway-client/rpc';

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
    launchRun: (params: {
        workflow: string;
        input?: Record<string, unknown>;
        options?: {
            runId?: string;
            idempotencyKey?: string;
            maxConcurrency?: number;
            allowNetwork?: boolean;
            maxOutputBytes?: number;
            toolTimeoutMs?: number;
        };
    }) => Promise<{
        runId: string;
        workflow: string;
    } & {
        seq?: number;
        txid?: string;
    }>;
    resumeRun: (params: {
        runId: string;
        options?: {
            force?: boolean;
        };
    }) => Promise<{
        runId: string;
        status: "resume_requested" | "already_terminal";
    } & {
        seq?: number;
        txid?: string;
    }>;
    cancelRun: (params: {
        runId: string;
    }) => Promise<{
        runId: string;
        status: "cancelling";
    } & {
        seq?: number;
        txid?: string;
    }>;
    hijackRun: (params: {
        runId: string;
        options?: Record<string, unknown>;
    }) => Promise<{
        runId: string;
        status: "hijack-ready";
        sessionId: string;
    } & {
        seq?: number;
        txid?: string;
    }>;
    rewindRun: (params: {
        runId: string;
        frameNo: number;
        confirm: true;
    }) => Promise<Record<string, unknown> & {
        seq?: number;
        txid?: string;
    }>;
    submitApproval: (params: {
        runId: string;
        nodeId: string;
        iteration?: number;
        approved?: boolean;
        decision: Record<string, unknown> & {
            approved?: boolean;
            value?: unknown;
            note?: string;
        };
        note?: string;
    } & {
        approvalId?: string;
    }) => Promise<{
        runId: string;
        nodeId: string;
        iteration: number;
        approved: boolean;
    } & {
        seq?: number;
        txid?: string;
    }>;
    submitSignal: (params: {
        runId: string;
        correlationKey: string;
        payload?: unknown;
        signalName?: string;
    }) => Promise<Record<string, unknown> & {
        seq?: number;
        txid?: string;
    }>;
    cronCreate: (params: {
        workflow: string;
        pattern: string;
        cronId?: string;
        enabled?: boolean;
    }) => Promise<_smithers_orchestrator_gateway_client.GatewayCronRow & {
        seq?: number;
        txid?: string;
    }>;
    cronDelete: (params: {
        cronId: string;
    }) => Promise<Record<string, unknown> & {
        seq?: number;
        txid?: string;
    }>;
    cronRun: (params: {
        cronId?: string;
        workflow?: string;
        input?: Record<string, unknown>;
    }) => Promise<{
        runId: string;
        workflow: string;
    } & {
        seq?: number;
        txid?: string;
    }>;
    createTicket: (params: {
        path: string;
        content: string;
        kind?: "ticket" | "plan" | "spec" | "proposal";
        status?: string;
    }) => Promise<_smithers_orchestrator_gateway_client.GatewayTicketRow & {
        seq?: number;
        txid?: string;
    }>;
    updateTicket: (params: {
        path: string;
        content?: string;
        status?: string;
    }) => Promise<_smithers_orchestrator_gateway_client.GatewayTicketRow & {
        seq?: number;
        txid?: string;
    }>;
    deleteTicket: (params: {
        path: string;
    }) => Promise<{
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
declare function useGatewayMutation<TVariables = Record<string, unknown>, TData = unknown>(method: string, options?: MutationOptions): MutationState<TVariables, TData>;

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
declare function useGatewayRun(runId: string | undefined): GatewayAsyncState<GatewayRpcPayload$1<"getRun">>;

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
    loading: boolean;
};

/**
 * Live run list over the `runs` collection (initial `listRuns`, re-pulled on
 * `invalidate`). Same `GatewayAsyncState` shape the RPC hook returned.
 */
declare function useGatewayRuns(params?: ListRunsRequest): GatewayAsyncState<GatewayRpcPayload$1<"listRuns">>;

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

/**
 * UI-facing types for the delegation-chain folded state (the flux store the
 * `delegation-chain` workflow UIs render from). These mirror the frozen build
 * contract; the zod row schemas live in `packages/components` — this module is
 * plain TypeScript plus the narrow runtime guards `foldDelegation` uses to
 * tolerate malformed rows without throwing.
 */
type Tier = "fable" | "opus" | "sonnet" | "haiku";
declare const DELEGATION_TIERS: readonly Tier[];
/**
 * The five developer-preview flavors a `preview` gate / `dcDevPreview` row can
 * carry: `app` = the built thing itself (or a UI rendering it), `terminal` =
 * a rendered terminal + instructions for driving a CLI, `api` = an explorer
 * UI for a built API, `throwaway-ui` = a disposable UI over the work,
 * `slideshow` = an HTML slideshow of what was done (the no-runnable-code
 * fallback).
 */
type DevPreviewKind = "app" | "terminal" | "api" | "throwaway-ui" | "slideshow";
type Gate = {
    method: "review";
    tier: Tier;
    brief: string;
} | {
    method: "check";
    command: string;
} | {
    method: "approval";
    policyMatch: string;
}
/**
 * Developer preview: post-execution backpressure. A successful build
 * (`dcDevPreview.builtOk`) is REQUIRED for the node to pass; the rendered
 * artifact carries user invalidate / request-changes affordances in the UI
 * (which emit `dc-edit` rounds).
 */
 | {
    method: "preview";
    kind: DevPreviewKind;
    brief: string;
};
/** Predicted (or measured) resource envelope for a node/subtree. */
type Estimate = {
    tokens: number;
    costUsd: number;
    minutes: number;
};
type DcGoalRow = {
    logicalId: string;
    refinedPrompt: string;
    assumptions: string[];
    questionsAsked: number;
};
type DcQuestionRow = {
    logicalId: string;
    seq: number;
    question: string;
    header: string;
    kind: "select" | "confirm" | "text";
    options?: Array<{
        label: string;
        description: string;
    }>;
    recommended: string;
    reason: string;
    resolved: boolean;
};
type DcPlanChild = {
    logicalId: string;
    tier: Tier;
    kind: "chunk" | "leaf";
    title: string;
    brief: string;
    estimate: Estimate;
};
type DcPlanRisk = {
    id: string;
    description: string;
    /** `null` means "considered, judged routine" — that judgment is scored. */
    probe: "poc" | "research" | null;
    reason: string;
};
type DcPlanRow = {
    logicalId: string;
    tier: Tier;
    title: string;
    brief: string;
    children: DcPlanChild[];
    subtreeEstimate: Estimate;
    risks: DcPlanRisk[];
    orchestration?: "tasks" | "workflow";
};
type DcPreviewRow = {
    logicalId: string;
    /** Markdown/pseudocode — ALWAYS shown with a "never executed" warning. */
    expectedOutput: string;
};
type DcGatesRow = {
    logicalId: string;
    gates: Gate[];
    depsLogical: string[];
};
/**
 * Developer-preview build result (physical node phase `dev-preview`,
 * `dc:<logicalId>:dev-preview`). `builtOk: false` fails the gate like a
 * failed review — the node is redelegated with the failure folded in.
 */
type DcDevPreviewRow = {
    logicalId: string;
    kind: DevPreviewKind;
    title: string;
    builtOk: boolean;
    artifact: {
        type: "html" | "url" | "markdown";
        content?: string;
        url?: string;
    };
    instructions?: string;
    summary: string;
};
type DcProbeRow = {
    probeId: string;
    parentLogicalId: string;
    kind: "poc" | "research";
    question: string;
    answer: string;
    /** Well-sourced markdown; delivered to the NEAREST PARENT only. */
    report: string;
    planImpact: "changes" | "confirms" | "none";
    proposedChange?: string;
};
type DcReplanRow = {
    round: number;
    logicalId: string;
    decision: "invalidated" | "reaffirmed";
    reason: string;
    trigger: {
        type: "probe" | "user-edit" | "review-fail";
        ref: string;
    };
};
type DcExecRow = {
    logicalId: string;
    attempt: number;
    summary: string;
    artifacts: string[];
    /** Best-effort measured usage from engine data, where available. */
    actual?: Partial<Estimate>;
    /** The VCS commits this attempt produced; reviews use it to inspect the work. */
    commitRange?: {
        from: string;
        to: string;
        vcs: "jj" | "git";
    };
};
type DcReviewRow = {
    logicalId: string;
    attempt: number;
    verdict: "pass" | "fail";
    feedback: string;
};
/** Signal payload delivered on correlation key `dc-edit`. */
type DcEditRow = {
    editId: string;
    logicalId: string;
    editedOutput: unknown;
    note?: string;
};
/** Signal payload delivered on correlation key `dc-skip-preview`. */
type DcSkipRow = {
    skipped: true;
};
type DcPollAnswer = {
    question: string;
    rating: 1 | 2 | 3 | 4 | 5;
};
/** HumanTask json-form payload for the end-of-run poll. */
type DcPollRow = {
    answers: DcPollAnswer[];
    comment?: string;
};
/**
 * One durable row the reducer folds: `table` names the output table the row
 * was written to, `nodeId` is the PHYSICAL smithers node id
 * (`dc:<logicalId>:<phase>`), `iteration` is the loop/retry attempt of that
 * physical node, and `row` is the untrusted row payload (validated by the
 * guards below). `seq` is an optional global ordering hint (gateway event
 * seq); the fold stays deterministic without it.
 */
type DelegationOutputRecord = {
    table: string;
    nodeId: string;
    iteration: number;
    row: unknown;
    seq?: number;
};
/** Pending-human marker for a physical node (from the approvals surface). */
type DelegationApprovalRecord = {
    table: "_approval";
    nodeId: string;
    iteration?: number;
    pending: boolean;
    seq?: number;
};
type DelegationRecord = DelegationOutputRecord | DelegationApprovalRecord;
type DelegationNodeKind = "goal" | "chunk" | "leaf" | "poc" | "research" | "score";
type DelegationNodeStatus = "planned" | "previewing" | "derisking" | "ready" | "running" | "awaiting-human" | "invalidated" | "done" | "failed";
/**
 * One archived (or current) version of a node. Version bumps happen on
 * plan-level invalidations ONLY (`dcReplan` decision `"invalidated"`); review
 * failures retry as new attempts WITHIN a version. The current version is the
 * last entry (no `invalidatedBy`); every prior entry carries the `dcReplan`
 * row that killed it.
 */
type DelegationVersionSnapshot = {
    version: number;
    plan?: DcPlanRow;
    gates?: DcGatesRow;
    exec?: DcExecRow[];
    review?: DcReviewRow[];
    invalidatedBy?: DcReplanRow;
};
type DelegationNodeState = {
    logicalId: string;
    parentId: string | null;
    tier: Tier;
    kind: DelegationNodeKind;
    title: string;
    brief: string;
    status: DelegationNodeStatus;
    /** Current version number (1-based). */
    version: number;
    versions: DelegationVersionSnapshot[];
    deps: string[];
    gates: Gate[];
    preview?: string;
    /** Latest developer-preview build for the current version. */
    devPreview?: DcDevPreviewRow;
    output?: unknown;
    /** Latest prediction for this node/subtree — replans supersede. */
    estimate?: Estimate;
    /** Rolled-up actuals so far (self + descendants' `dcExec.actual`). */
    actual?: Partial<Estimate>;
    /** Pending-human rollup: `self` for this node, `descendants` counts strict descendants. */
    attention: {
        self: boolean;
        descendants: number;
    };
};
type DelegationEdge = {
    from: string;
    to: string;
    kind: "child" | "dep" | "gate" | "probe";
};
type DelegationPhase = "goal" | "planning" | "preview" | "gates" | "derisk" | "execution" | "scoring" | "done";
type DelegationGraph = {
    nodes: Record<string, DelegationNodeState>;
    rootId: string | null;
    edges: DelegationEdge[];
    phase: DelegationPhase;
    pendingQuestions: DcQuestionRow[];
    refinedPrompt?: string;
    /**
     * Run-level rollup: `predicted` uses the LATEST plan/replan estimates (a
     * child's own re-forecast supersedes its parent's stale estimate for it);
     * `actual` sums every reported `dcExec.actual`. Drives the
     * "$actual of $latestPredicted" progress bar.
     */
    budget: {
        predicted: Estimate | null;
        actual: Partial<Estimate>;
    };
    scores?: Record<string, unknown>;
};
declare function isTier(value: unknown): value is Tier;
declare function isEstimate(value: unknown): value is Estimate;
declare function isDevPreviewKind(value: unknown): value is DevPreviewKind;
declare function isGate(value: unknown): value is Gate;
declare function isDcGoalRow(value: unknown): value is DcGoalRow;
declare function isDcQuestionRow(value: unknown): value is DcQuestionRow;
declare function isDcPlanChild(value: unknown): value is DcPlanChild;
declare function isDcPlanRow(value: unknown): value is DcPlanRow;
declare function isDcPreviewRow(value: unknown): value is DcPreviewRow;
declare function isDcGatesRow(value: unknown): value is DcGatesRow;
declare function isDcDevPreviewRow(value: unknown): value is DcDevPreviewRow;
declare function isDcProbeRow(value: unknown): value is DcProbeRow;
declare function isDcReplanRow(value: unknown): value is DcReplanRow;
declare function isDcExecRow(value: unknown): value is DcExecRow;
declare function isDcReviewRow(value: unknown): value is DcReviewRow;
declare function isDcEditRow(value: unknown): value is DcEditRow;
declare function isDcSkipRow(value: unknown): value is DcSkipRow;
declare function isDcPollRow(value: unknown): value is DcPollRow;
declare function isDelegationApprovalRecord(record: DelegationRecord): record is DelegationApprovalRecord;

/** Why a record was excluded from the fold. */
type DelegationIgnoreReason = "unknown-table" | "malformed-row";

/**
 * Pure, non-React reducer that folds durable delegation rows into the
 * `DelegationGraph` flux state the UI renders. Deterministic and
 * order-insensitive: records are sorted internally by
 * (table-priority, iteration, intrinsic row seq, seq, row identity), and the
 * fold itself is structural (versions, cascades, and rollups are derived from
 * the full record set, not from arrival order), so shuffling the input yields
 * a deep-equal graph.
 *
 * Tolerance: unknown tables are ignored; malformed rows are reported through
 * `options.onIgnored` and skipped — the reducer never throws on bad data.
 *
 * Internals are an Effect-native state machine: each record is classified
 * into a `DelegationEvent` (`Data.TaggedEnum`, see `delegationEvents.ts`),
 * the bucket stage dispatches with `Match.tagsExhaustive` over event tags,
 * and the fold phases (bucket → version assembly → cascade closure →
 * attention rollup → budget rollup) are composable pure stages piped through
 * one `Effect` that `foldDelegation` runs synchronously at the boundary —
 * the public function stays a synchronous pure fold.
 */

type DelegationFoldIssue = {
    record: DelegationRecord;
    reason: DelegationIgnoreReason;
};
type FoldDelegationOptions = {
    /** Called for every ignored record (unknown table / malformed row). */
    onIgnored?: (issue: DelegationFoldIssue) => void;
};
/**
 * Parse a physical delegation node id (`dc:<logicalId>:<phase>`) into its
 * logical id and phase. Returns null for anything that is not a delegation
 * node id. Accepts every output-table phase plus the approval-only phases
 * (`approve`, `approval-<i>`); unknown phases stay excluded so arbitrary
 * `dc:*` ids from other workflows never leak into the fold.
 */
declare function parseDelegationNodeId(nodeId: string): {
    logicalId: string;
    phase: string;
} | null;
/**
 * The output table a physical delegation node writes to, derived from the
 * `dc:<logicalId>:<phase>` naming contract (plus the signal/poll listener
 * node ids `dc-edit` / `dc-skip-preview` / `dc-poll`). Null when the node is
 * not part of a delegation chain — and also for the approval-only phases
 * (`approve` / `approval-<i>`), which parse as delegation nodes but carry no
 * output row the fold consumes.
 */
declare function delegationTableForNodeId(nodeId: string): string | null;
declare function foldDelegation(records: DelegationRecord[], options?: FoldDelegationOptions): DelegationGraph;

type UseDelegationChainResult = {
    graph: DelegationGraph;
    loading: boolean;
    errors: unknown[];
    actions: {
        /** Deliver a live user edit of a node's output (Signal `dc-edit`). */
        submitEdit(logicalId: string, editedOutput: unknown, note?: string): Promise<void>;
        /** Skip the zero-backpressure preview phase (Signal `dc-skip-preview`). */
        skipPreviews(): Promise<void>;
        /** Answer a durable human request; `value` rides as JSON in `decision.note`. */
        answerHuman(nodeId: string, iteration: number, value: unknown): Promise<void>;
        /** Answer the end-of-run poll (the pending poll HumanTask). */
        submitPoll(answers: DcPollAnswer[], comment?: string): Promise<void>;
    };
};
/**
 * Folded delegation-chain state for one run, per the frozen contract.
 *
 * Record assembly lives in the Effect pipeline behind
 * `createDelegationChainStore` (see `delegationChainStore.ts`): the run tree,
 * live event frames, and approvals are pushed into a Queue-fed Stream whose
 * consumer reconciles Effect-managed state (durable event-derived targets,
 * the exactly-once `getNodeOutput` cache with finish-event invalidation, the
 * paged `listRunEvents` history backfill) into a
 * `SubscriptionRef<DelegationChainSnapshot>`; this hook subscribes via
 * `useSyncExternalStore`. The pure `foldDelegation` reducer turns the
 * assembled records into the graph; malformed/unknown rows surface in
 * `errors` instead of throwing.
 */
declare function useDelegationChain(params: {
    runId: string | undefined;
}): UseDelegationChainResult;

export { DELEGATION_TIERS, type DcDevPreviewRow, type DcEditRow, type DcExecRow, type DcGatesRow, type DcGoalRow, type DcPlanChild, type DcPlanRisk, type DcPlanRow, type DcPollAnswer, type DcPollRow, type DcPreviewRow, type DcProbeRow, type DcQuestionRow, type DcReplanRow, type DcReviewRow, type DcSkipRow, type DelegationApprovalRecord, type DelegationEdge, type DelegationFoldIssue, type DelegationGraph, type DelegationNodeKind, type DelegationNodeState, type DelegationNodeStatus, type DelegationOutputRecord, type DelegationPhase, type DelegationRecord, type DelegationVersionSnapshot, type DevPreviewKind, type Estimate, type FoldDelegationOptions, type Gate, type GatewayAsyncState, type GatewayConnectionState, type GatewayConnectionStatus, type GatewayExtensionStreamState, type NodeStatus, SmithersCollectionsContext, type SmithersCollectionsContextValue, SmithersCollectionsProvider, SmithersGatewayContext, SmithersGatewayProvider, type Tier, type UseDelegationChainResult, type UseGatewayConnectionStatusResult, type UseGatewayRunTreeResult, createGatewayReactRoot, delegationTableForNodeId, foldDelegation, isDcDevPreviewRow, isDcEditRow, isDcExecRow, isDcGatesRow, isDcGoalRow, isDcPlanChild, isDcPlanRow, isDcPollRow, isDcPreviewRow, isDcProbeRow, isDcQuestionRow, isDcReplanRow, isDcReviewRow, isDcSkipRow, isDelegationApprovalRecord, isDevPreviewKind, isEstimate, isGate, isTier, parseDelegationNodeId, useDelegationChain, useGatewayActions, useGatewayApprovals, useGatewayConnectionStatus, useGatewayCrons, useGatewayExtensionAction, useGatewayExtensionResource, useGatewayExtensionStream, useGatewayMemoryFacts, useGatewayMutation, useGatewayNodeOutput, useGatewayPrompts, useGatewayRpc, useGatewayRun, useGatewayRunEvents, useGatewayRunTree, useGatewayRuns, useGatewayScores, useGatewayTickets, useGatewayWorkflows, useSmithersCollections, useSmithersGateway };
