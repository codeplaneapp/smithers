/**
 * Type-only declarations for the stable v1 Gateway wire contract.
 *
 * Runtime schemas, auth scopes, and catalog metadata stay in the gateway
 * package. These transport shapes live in protocol so clients and UI adapters
 * do not depend on the gateway implementation.
 */
type SmithersApiVersion$1 = "v1";
type GatewayRpcErrorCode$1 = "InvalidRequest" | "InvalidInput" | "Unauthorized" | "Forbidden" | "RunNotFound" | "ScoreNotFound" | "RUN_NOT_ACTIVE" | "CronNotFound" | "TicketNotFound" | "NodeNotFound" | "IterationNotFound" | "NodeHasNoOutput" | "FrameOutOfRange" | "SeqOutOfRange" | "Busy" | "AlreadyDecided" | "RateLimited" | "PayloadTooLarge" | "BackpressureDisconnect" | "UnsupportedSandbox" | "VcsError" | "RewindFailed" | "Internal";
type GatewayRpcMethod$1 = "launchRun" | "resumeRun" | "cancelRun" | "pauseRun" | "hijackRun" | "rewindRun" | "submitApproval" | "submitSignal" | "getRun" | "listRuns" | "getSchemaSignature" | "listWorkflows" | "listApprovals" | "listDocs" | "streamRunEvents" | "streamDevTools" | "getDevToolsSnapshot" | "getNodeOutput" | "getNodeDiff" | "getRunDiff" | "whatHappened" | "cronList" | "cronCreate" | "cronDelete" | "cronRun" | "listAccounts" | "listMemoryFacts" | "listPrompts" | "listScores" | "listScoresForRuns" | "getScoreDetail" | "listTickets" | "createTicket" | "updateTicket" | "deleteTicket";
type LaunchRunRequest$1 = {
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
};
type LaunchRunResponse$1 = {
    runId: string;
    workflow: string;
};
type ResumeRunRequest$1 = {
    runId: string;
    options?: {
        force?: boolean;
    };
};
type ResumeRunResponse$1 = {
    runId: string;
    status: "resume_requested" | "already_terminal";
};
type CancelRunRequest$1 = {
    runId: string;
};
type CancelRunResponse$1 = {
    runId: string;
    status: "cancelling";
};
type PauseRunRequest$1 = {
    runId: string;
};
type PauseRunResponse$1 = {
    runId: string;
    status: "pausing";
};
type HijackRunRequest$1 = {
    runId: string;
    options?: Record<string, unknown>;
};
type HijackRunResponse$1 = {
    runId: string;
    status: "hijack-ready";
    sessionId: string;
};
type RewindRunRequest$1 = {
    runId: string;
    frameNo: number;
    confirm: true;
};
type SubmitApprovalRequest$1 = {
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
};
type SubmitApprovalResponse$1 = {
    runId: string;
    nodeId: string;
    iteration: number;
    approved: boolean;
};
type SubmitSignalRequest$1 = {
    runId: string;
    correlationKey: string;
    payload?: unknown;
    signalName?: string;
};
type GetRunRequest$1 = {
    runId: string;
};
type GatewayDiffPatch$1 = {
    path: string;
    diff: string;
    additions?: number;
    deletions?: number;
    binary?: boolean;
};
type GatewayDiffBundle$1 = {
    seq: number;
    baseRef: string;
    patches: GatewayDiffPatch$1[];
};
type GetRunDiffRequest$1 = {
    runId: string;
};
type GetRunDiffOversizedResponse$1 = {
    status: "oversized";
    baseRef: string;
    terminalRef: string;
    sizeBytes: number;
    maxBytes: number;
};
type GetRunDiffResponse$1 = GatewayDiffBundle$1 | GetRunDiffOversizedResponse$1;
type ListRunsRequest$1 = {
    filter?: {
        status?: string;
        limit?: number;
        workflow?: string;
    };
};
type GetSchemaSignatureRequest$1 = Record<string, never>;
type GetSchemaSignatureResponse$1 = {
    schemaVersion: string;
    signature: string;
    components?: Record<string, string>;
};
type GatewayWorkflowSummary$1 = {
    key: string;
    readableName?: string;
    description?: string;
    hasUi: boolean;
    uiPath: string | null;
    /** True for internal plumbing workflows (e.g. init) hidden from default listings. */
    system?: boolean;
};
type ListWorkflowsRequest$1 = {
    filter?: {
        hasUi?: boolean;
        /** System workflows are excluded from results unless this is true. */
        includeSystem?: boolean;
    };
};
type ListWorkflowsResponse$1 = GatewayWorkflowSummary$1[];
type GatewayApprovalSummary$1 = {
    runId: string;
    workflowKey?: string;
    nodeId: string;
    iteration: number;
    requestTitle?: string;
    requestSummary?: string;
    requestedAtMs: number | null;
    approvalMode?: string;
    options?: unknown;
    allowedScopes?: readonly string[];
    allowedUsers?: readonly string[];
    autoApprove?: unknown;
};
type ListApprovalsRequest$1 = {
    filter?: {
        runId?: string;
        workflow?: string;
        limit?: number;
    };
};
type ListApprovalsResponse$1 = GatewayApprovalSummary$1[];
type GatewayDocRow$1 = {
    path: string;
    kind: "ticket" | "plan" | "spec" | "proposal" | "conflict" | (string & {});
    content: string;
    contentHash: string;
    updatedAtMs: number;
    deletedAtMs: number | null;
};
type ListDocsRequest$1 = {
    filter?: {
        kind?: string;
        includeDeleted?: boolean;
        updatedAfterMs?: number;
        limit?: number;
    };
};
type ListDocsResponse$1 = GatewayDocRow$1[];
type StreamRunEventsRequest$1 = {
    runId: string;
    afterSeq?: number;
};
type StreamRunEventsResponse$1 = {
    streamId: string;
    runId: string;
    afterSeq: number | null;
    currentSeq: number;
};
type StreamDevToolsRequest$1 = {
    runId: string;
    afterSeq?: number;
    fromSeq?: number;
};
type GetDevToolsSnapshotRequest$1 = {
    runId: string;
    frameNo?: number;
};
type GetDevToolsSnapshotResponse$1 = Record<string, unknown>;
type NodeRequest$1 = {
    runId: string;
    nodeId: string;
    iteration?: number;
};
/**
 * `whatHappened` summarizes a run (no `nodeId`) or one node of it. The summary
 * comes from a Gateway-configured narrator agent when one is available and
 * otherwise from a deterministic fact recap; `source` says which one answered
 * and `cached` whether the Gateway served it from its summary cache.
 */
type WhatHappenedRequest$1 = {
    runId: string;
    nodeId?: string;
    iteration?: number;
};
type WhatHappenedResponse$1 = {
    runId: string;
    nodeId: string | null;
    iteration: number | null;
    scope: "run" | "node";
    summary: string;
    agentId: string | null;
    source: "agent" | "facts";
    cached: boolean;
    generatedAtMs: number;
};
type CronListRequest$1 = {
    filter?: {
        workflow?: string;
    };
};
type CronCreateRequest$1 = {
    workflow: string;
    pattern: string;
    cronId?: string;
    enabled?: boolean;
};
type CronDeleteRequest$1 = {
    cronId: string;
};
type CronRunRequest$1 = {
    cronId?: string;
    workflow?: string;
    input?: Record<string, unknown>;
};
/**
 * One registered Smithers agent account: a row in the user-level
 * `~/.smithers/accounts.json` registry surfaced read-only by `listAccounts`.
 * Secret API keys are never included in this wire shape.
 */
type GatewayAccount$1 = {
    /** Unique account label (the registry key, `--label`). */
    label: string;
    provider: "claude-code" | "antigravity" | "codex" | "gemini" | "kimi" | "anthropic-api" | "openai-api" | "gemini-api";
    /** Per-account CLI config dir for subscription providers (absent for api-key accounts). */
    configDir?: string | null;
    /** True when a subscription account has a non-empty config dir. */
    hasConfigDir: boolean;
    /** True when an api-key account carries a non-empty key (the key itself is never returned). */
    hasApiKey: boolean;
    /** Optional default model baked into the account. */
    model?: string | null;
    /** ISO timestamp of when the account was added, when known. */
    addedAt?: string | null;
};
type ListAccountsRequest$1 = Record<string, never>;
type ListAccountsResponse$1 = GatewayAccount$1[];
/** One cross-run memory fact row (the `_smithers_memory_facts` table, snake-to-camel cased). */
type GatewayMemoryFact$1 = {
    namespace: string;
    key: string;
    valueJson: string;
    schemaSig?: string | null;
    createdAtMs: number;
    updatedAtMs: number;
    ttlMs?: number | null;
};
type ListMemoryFactsRequest$1 = {
    namespace?: string;
};
type ListMemoryFactsResponse$1 = GatewayMemoryFact$1[];
/** One registered prompt row returned by `listPrompts`. */
type GatewayPrompt$1 = {
    id: string;
    entryFile: string;
    source: string;
    createdAtMs?: number;
    updatedAtMs?: number;
};
type ListPromptsRequest$1 = Record<string, never>;
type ListPromptsResponse$1 = GatewayPrompt$1[];
/** One scorer/eval result row returned by `listScores`. */
type GatewayScoreRow$1 = {
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    scorerId: string;
    scorerName: string;
    source: string;
    score: number;
    reason?: string | null;
    scoredAtMs: number;
    latencyMs?: number | null;
    durationMs?: number | null;
};
type ListScoresRequest$1 = {
    runId: string;
    nodeId?: string;
};
type ListScoresResponse$1 = GatewayScoreRow$1[];
/** One cross-run score row, including the exact persisted score identity. */
type GatewayComparisonScoreRow$1 = GatewayScoreRow$1 & {
    scoreId: string;
};
/** Batch score rows for explicit run ids. */
type ListScoresForRunsRequest$1 = {
    runIds: string[];
    nodeId?: string;
    scorerId?: string;
    scorerName?: string;
    source?: "live" | "batch";
    order?: "scoredAtAsc" | "scoredAtDesc";
    offset?: number;
    limit?: number;
};
type ListScoresForRunsResponse$1 = {
    rows: GatewayComparisonScoreRow$1[];
    total: number;
};
type GetScoreDetailRequest$1 = {
    runId: string;
    scoreId: string;
};
/** One exact persisted score with its JSON detail columns decoded. */
type GatewayScoreDetail$1 = GatewayComparisonScoreRow$1 & {
    meta: unknown;
    input: unknown;
    output: unknown;
    groundTruth: unknown;
    context: unknown;
};
type GetScoreDetailResponse$1 = GatewayScoreDetail$1;
/** A doc kind stored in `_smithers_docs`; the tickets surface uses `ticket`. */
type GatewayDocKind$1 = "ticket" | "plan" | "spec" | "proposal";
/** One live doc row returned by `listTickets`. */
type GatewayTicketRow$1 = {
    path: string;
    kind: GatewayDocKind$1;
    content: string;
    contentHash: string;
    status?: string | null;
    updatedAtMs: number;
};
type ListTicketsRequest$1 = {
    /** Optional doc-kind filter; omit to list every kind. Defaults to all. */
    kind?: GatewayDocKind$1;
};
type ListTicketsResponse$1 = GatewayTicketRow$1[];
type CreateTicketRequest$1 = {
    /** Doc identity (PK); e.g. a ticket id like `feat-issues-card`. */
    path: string;
    content: string;
    kind?: GatewayDocKind$1;
    status?: string;
};
type UpdateTicketRequest$1 = {
    path: string;
    content?: string;
    status?: string;
};
type DeleteTicketRequest$1 = {
    path: string;
};
type GatewayEventFrame$1<Payload = unknown> = {
    type: "event";
    event: string;
    payload?: Payload;
    seq: number;
    stateVersion: number;
    apiVersion?: SmithersApiVersion$1;
};
type GatewayResponseFrame$1<Payload = unknown> = {
    type: "res";
    id: string;
    ok: true;
    apiVersion?: SmithersApiVersion$1;
    payload: Payload;
} | {
    type: "res";
    id: string;
    ok: false;
    apiVersion?: SmithersApiVersion$1;
    error: {
        version?: SmithersApiVersion$1;
        code: string;
        message: string;
        requiredScope?: string;
        refresh?: string;
        details?: unknown;
    };
};

type SmithersApiVersion = SmithersApiVersion$1;
type GatewayRpcErrorCode = GatewayRpcErrorCode$1;
type GatewayRpcMethod = GatewayRpcMethod$1;
type LaunchRunRequest = LaunchRunRequest$1;
type LaunchRunResponse = LaunchRunResponse$1;
type ResumeRunRequest = ResumeRunRequest$1;
type ResumeRunResponse = ResumeRunResponse$1;
type CancelRunRequest = CancelRunRequest$1;
type CancelRunResponse = CancelRunResponse$1;
type PauseRunRequest = PauseRunRequest$1;
type PauseRunResponse = PauseRunResponse$1;
type HijackRunRequest = HijackRunRequest$1;
type HijackRunResponse = HijackRunResponse$1;
type RewindRunRequest = RewindRunRequest$1;
type SubmitApprovalRequest = SubmitApprovalRequest$1;
type SubmitApprovalResponse = SubmitApprovalResponse$1;
type SubmitSignalRequest = SubmitSignalRequest$1;
type GetRunRequest = GetRunRequest$1;
type GetRunDiffRequest = GetRunDiffRequest$1;
type GetRunDiffResponse = GetRunDiffResponse$1;
type GetRunDiffOversizedResponse = GetRunDiffOversizedResponse$1;
type GatewayDiffBundle = GatewayDiffBundle$1;
type GatewayDiffPatch = GatewayDiffPatch$1;
type ListRunsRequest = ListRunsRequest$1;
type GetSchemaSignatureRequest = GetSchemaSignatureRequest$1;
type GetSchemaSignatureResponse = GetSchemaSignatureResponse$1;
type GatewayWorkflowSummary = GatewayWorkflowSummary$1;
type ListWorkflowsRequest = ListWorkflowsRequest$1;
type ListWorkflowsResponse = ListWorkflowsResponse$1;
type GatewayApprovalSummary = GatewayApprovalSummary$1;
type ListApprovalsRequest = ListApprovalsRequest$1;
type ListApprovalsResponse = ListApprovalsResponse$1;
type GatewayDocRow = GatewayDocRow$1;
type ListDocsRequest = ListDocsRequest$1;
type ListDocsResponse = ListDocsResponse$1;
type StreamRunEventsRequest = StreamRunEventsRequest$1;
type StreamRunEventsResponse = StreamRunEventsResponse$1;
type StreamDevToolsRequest = StreamDevToolsRequest$1;
type GetDevToolsSnapshotRequest = GetDevToolsSnapshotRequest$1;
type GetDevToolsSnapshotResponse = GetDevToolsSnapshotResponse$1;
type NodeRequest = NodeRequest$1;
type WhatHappenedRequest = WhatHappenedRequest$1;
type WhatHappenedResponse = WhatHappenedResponse$1;
type CronListRequest = CronListRequest$1;
type CronCreateRequest = CronCreateRequest$1;
type CronDeleteRequest = CronDeleteRequest$1;
type CronRunRequest = CronRunRequest$1;
type GatewayAccount = GatewayAccount$1;
type ListAccountsRequest = ListAccountsRequest$1;
type ListAccountsResponse = ListAccountsResponse$1;
type GatewayMemoryFact = GatewayMemoryFact$1;
type ListMemoryFactsRequest = ListMemoryFactsRequest$1;
type ListMemoryFactsResponse = ListMemoryFactsResponse$1;
type GatewayPrompt = GatewayPrompt$1;
type ListPromptsRequest = ListPromptsRequest$1;
type ListPromptsResponse = ListPromptsResponse$1;
type GatewayScoreRow = GatewayScoreRow$1;
type ListScoresRequest = ListScoresRequest$1;
type ListScoresResponse = ListScoresResponse$1;
type GatewayComparisonScoreRow = GatewayComparisonScoreRow$1;
type ListScoresForRunsRequest = ListScoresForRunsRequest$1;
type ListScoresForRunsResponse = ListScoresForRunsResponse$1;
type GetScoreDetailRequest = GetScoreDetailRequest$1;
type GatewayScoreDetail = GatewayScoreDetail$1;
type GetScoreDetailResponse = GetScoreDetailResponse$1;
type GatewayDocKind = GatewayDocKind$1;
type GatewayTicketRow = GatewayTicketRow$1;
type ListTicketsRequest = ListTicketsRequest$1;
type ListTicketsResponse = ListTicketsResponse$1;
type CreateTicketRequest = CreateTicketRequest$1;
type UpdateTicketRequest = UpdateTicketRequest$1;
type DeleteTicketRequest = DeleteTicketRequest$1;
type GatewayEventFrame<Payload = unknown> = GatewayEventFrame$1<Payload>;
type GatewayResponseFrame<Payload = unknown> = GatewayResponseFrame$1<Payload>;

export type { CancelRunRequest, CancelRunResponse, CreateTicketRequest, CronCreateRequest, CronDeleteRequest, CronListRequest, CronRunRequest, DeleteTicketRequest, GatewayAccount, GatewayApprovalSummary, GatewayComparisonScoreRow, GatewayDiffBundle, GatewayDiffPatch, GatewayDocKind, GatewayDocRow, GatewayEventFrame, GatewayMemoryFact, GatewayPrompt, GatewayResponseFrame, GatewayRpcErrorCode, GatewayRpcMethod, GatewayScoreDetail, GatewayScoreRow, GatewayTicketRow, GatewayWorkflowSummary, GetDevToolsSnapshotRequest, GetDevToolsSnapshotResponse, GetRunDiffOversizedResponse, GetRunDiffRequest, GetRunDiffResponse, GetRunRequest, GetSchemaSignatureRequest, GetSchemaSignatureResponse, GetScoreDetailRequest, GetScoreDetailResponse, HijackRunRequest, HijackRunResponse, LaunchRunRequest, LaunchRunResponse, ListAccountsRequest, ListAccountsResponse, ListApprovalsRequest, ListApprovalsResponse, ListDocsRequest, ListDocsResponse, ListMemoryFactsRequest, ListMemoryFactsResponse, ListPromptsRequest, ListPromptsResponse, ListRunsRequest, ListScoresForRunsRequest, ListScoresForRunsResponse, ListScoresRequest, ListScoresResponse, ListTicketsRequest, ListTicketsResponse, ListWorkflowsRequest, ListWorkflowsResponse, NodeRequest, PauseRunRequest, PauseRunResponse, ResumeRunRequest, ResumeRunResponse, RewindRunRequest, SmithersApiVersion, StreamDevToolsRequest, StreamRunEventsRequest, StreamRunEventsResponse, SubmitApprovalRequest, SubmitApprovalResponse, SubmitSignalRequest, UpdateTicketRequest, WhatHappenedRequest, WhatHappenedResponse };
