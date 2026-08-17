/**
 * Type-only declarations for the stable v1 Gateway wire contract.
 *
 * Runtime schemas, auth scopes, and catalog metadata stay in the gateway
 * package. These transport shapes live in protocol so clients and UI adapters
 * do not depend on the gateway implementation.
 */
type SmithersApiVersion$1 = "v1";
type GatewayRpcErrorCode$1 = "InvalidRequest" | "InvalidInput" | "Unauthorized" | "Forbidden" | "RunNotFound" | "ScoreNotFound" | "RUN_NOT_ACTIVE" | "CronNotFound" | "TicketNotFound" | "NodeNotFound" | "IterationNotFound" | "NodeHasNoOutput" | "FrameOutOfRange" | "SeqOutOfRange" | "Busy" | "AlreadyDecided" | "RateLimited" | "PayloadTooLarge" | "BackpressureDisconnect" | "UnsupportedSandbox" | "VcsError" | "RewindFailed" | "TIME_TRAVEL_SIDE_EFFECT_BLOCKED" | "Internal" | "REVISION_CONFLICT" | "SSRF_BLOCKED" | "QUOTA_EXCEEDED";
type GatewayRpcMethod$1 = "launchRun" | "resumeRun" | "cancelRun" | "pauseRun" | "hijackRun" | "rewindRun" | "submitApproval" | "submitSignal" | "getRun" | "listRunTokenUsage" | "listRuns" | "listRunDescendants" | "getSchemaSignature" | "listWorkflows" | "listApprovals" | "listDocs" | "streamRunEvents" | "streamDevTools" | "getDevToolsSnapshot" | "getNodeOutput" | "getNodeDiff" | "getRunDiff" | "whatHappened" | "cronList" | "cronCreate" | "cronDelete" | "cronRun" | "listAccounts" | "listUsageReports" | "listMemoryFacts" | "listPrompts" | "listScores" | "listScoresForRuns" | "getScoreDetail" | "listTickets" | "createTicket" | "updateTicket" | "deleteTicket" | "createBrowserSession" | "browserAct" | "browserContext" | "browserPick" | "closeBrowserSession" | "listBrowserSessions";
type BrowserActor$1 = "user" | "agent" | "page";
type BrowserViewport$1 = {
    width: number;
    height: number;
};
type BrowserPoint$1 = {
    x: number;
    y: number;
};
type BrowserRectangle$1 = BrowserPoint$1 & {
    width: number;
    height: number;
};
type BrowserModifier$1 = "Alt" | "Control" | "Meta" | "Shift" | (string & {});
type BrowserRedaction$1 = {
    redacted: true;
    length: number;
};
type BrowserOutcome$1 = {
    ok: true;
    redirectedTo?: string;
    redacted?: boolean;
    length?: number;
} | {
    ok: false;
    code: string;
    message: string;
};
type BrowserJournalEntry$1 = {
    actionId: string;
    actor: Exclude<BrowserActor$1, "page">;
    revision: number;
    action: BrowserAction$1;
    result: BrowserOutcome$1;
};
type BrowserContextSlice$1 = "visible-text" | "accessibility" | "interactive-elements" | "screenshot" | "selections" | "recent-actions" | "console-summary" | "network-summary";
type BrowserSummary$1 = {
    message?: string;
    count?: number;
    truncated?: boolean;
} & Record<string, unknown>;
type BrowserSource$1 = {
    kind: "url";
    url: string;
} | {
    kind: "dev-server";
    port: number;
    path?: string;
};
type BrowserSnapshot$1 = {
    sessionId: string;
    source: BrowserSource$1;
    status: "starting" | "ready" | "loading" | "suspended" | "closed" | "failed";
    revision: number;
    page: {
        url: string;
        title: string;
        canGoBack: boolean;
        canGoForward: boolean;
    } | null;
    viewport: BrowserViewport$1;
    control: {
        owner: "user" | "agent" | null;
    };
};
type BrowserLocator$1 = {
    testId: string;
} | {
    role: string;
    name?: string;
} | {
    css: string;
};
type BrowserClickAction$1 = {
    kind: "click";
    locator: BrowserLocator$1;
    point?: never;
    button?: "left" | "right" | "middle";
    modifiers?: BrowserModifier$1[];
} | {
    kind: "click";
    point: BrowserPoint$1;
    locator?: never;
    button?: "left" | "right" | "middle";
    modifiers?: BrowserModifier$1[];
};
type BrowserAction$1 = {
    kind: "navigate";
    url: string;
} | {
    kind: "back" | "forward" | "reload" | "stop";
} | BrowserClickAction$1 | {
    kind: "type";
    locator: BrowserLocator$1;
    text: string;
    replace?: boolean;
} | {
    kind: "press";
    key: string;
    modifiers?: BrowserModifier$1[];
} | {
    kind: "scroll";
    deltaX: number;
    deltaY: number;
} | {
    kind: "dialog";
    decision: "accept" | "dismiss";
    promptText?: string;
};
type CreateBrowserSessionRequest$1 = {
    source: BrowserSource$1;
    viewport?: {
        width: number;
        height: number;
    };
};
type BrowserActRequest$1 = {
    sessionId: string;
    actionId: string;
    expectedRevision?: number;
    action: BrowserAction$1;
};
type BrowserContextRequest$1 = {
    sessionId: string;
    sinceRevision?: number;
    include?: string[];
};
type BrowserPickRequest$1 = {
    sessionId: string;
    point: {
        x: number;
        y: number;
    };
};
type CloseBrowserSessionRequest$1 = {
    sessionId: string;
};
type CreateBrowserSessionResponse$1 = BrowserSnapshot$1;
type BrowserActResponse$1 = {
    revision: number;
    page: BrowserSnapshot$1["page"];
    outcome: BrowserOutcome$1;
};
type BrowserScreenshot$1 = {
    data: string;
    mediaType: "image/jpeg";
};
type BrowserSelection$1 = {
    locator: BrowserLocator$1;
    role: string;
    name: string;
    text: string;
    fingerprint: string;
    rect: BrowserRectangle$1;
    viewport: BrowserViewport$1;
};
type BrowserContextResponse$1 = {
    fresh: boolean;
    reason?: string;
    snapshot: BrowserSnapshot$1;
    revision: number;
    include: string[];
    visibleText?: string;
    visibleTextTruncated?: boolean;
    interactiveElements?: unknown[];
    interactiveElementsTruncated?: boolean;
    accessibility?: string | null;
    recentActions?: unknown[];
    selections?: BrowserSelection$1[];
    consoleSummary?: unknown[];
    networkSummary?: unknown[];
    screenshot?: BrowserScreenshot$1 | null;
};
type BrowserPickResponse$1 = BrowserSelection$1 & {
    screenshot: BrowserScreenshot$1 | null;
};
type CloseBrowserSessionResponse$1 = {
    closed: boolean;
    sessionId?: string;
};
type ListBrowserSessionsResponse$1 = BrowserSnapshot$1[];
/**
 * Self-reported launch provenance, distinct from authenticated identity.
 * `harness` and `sessionId` are trimmed and limited to 64 and 256 Unicode
 * code points. `prompt` is explicit-only and is visibly clipped at 8,192 code
 * points. `detected` may only be literal `true` when identity was inferred.
 */
type RunStartedBy$1 = {
    harness?: string;
    sessionId?: string;
    prompt?: string;
    detected?: true;
};
/** Exact persisted tenant key. Both fields are always present together. */
type RunOwnership$1 = {
    owner: string;
    app: string;
};
/** Durable attribution for the first caller that cancelled a run. */
type RunCancellationSource$1 = {
    kind: "signal" | "rpc" | "cli" | "engine";
    detail?: string;
    signal?: string;
    clientPid?: number;
    requestId?: string;
    clientIdentity?: string;
};
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
        startedBy?: RunStartedBy$1;
    };
};
type LaunchRunResponse$1 = {
    runId: string;
    workflow: string;
    /** Immutable visibility copied from the registered workflow when the run was created. */
    system: boolean;
    ownership?: RunOwnership$1;
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
/** What subtree cancellation did to one run in the cancelled lineage. */
type CancelledRunOutcome$1 = {
    runId: string;
    /** Zero for the requested run, one for direct children, and so on. */
    depth: number;
    action: "cancel-requested" | "cancelled" | "already-terminal" | "missing";
};
/** A process tree cancellation terminated to stop work outliving its run. */
type CancelledProcess$1 = {
    runId: string | null;
    pid: number;
};
type CancelRunResponse$1 = {
    runId: string;
    won: boolean;
    status: "cancelled" | "already-terminal" | "not-found";
    terminalStatus?: string;
    repaired: boolean;
    /** Missing only for historical or unattributed cancellations. */
    cancellationSource?: RunCancellationSource$1;
    /**
     * Attempts closed across the whole cancelled subtree. Cancellation is
     * recursive: the requested run AND every transitive child-workflow
     * descendant are cancelled as one operation. Time-travel forks are spared.
     */
    cancelledAttempts?: number;
    /** Every descendant the cascade reached, excluding the requested run. */
    descendants?: CancelledRunOutcome$1[];
    /** Detached owner processes terminated because they outlived their run. */
    terminatedOwners?: CancelledProcess$1[];
    /** Agent process trees terminated for runs in the cancelled subtree. */
    terminatedAgents?: CancelledProcess$1[];
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
    force?: boolean;
    noRevert?: boolean;
};
type CrossedEffect$1 = {
    kind: "tool" | "task";
    toolName: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    seq: number;
    effectStatus: "succeeded" | "unknown";
    idempotent: boolean;
    hasRevert: boolean;
    startedAtMs: number;
    reason?: string;
};
type EffectBoundaryReport$1 = {
    blocking: CrossedEffect$1[];
    revertible: CrossedEffect$1[];
    warnings: CrossedEffect$1[];
};
type RewindRunResponse$1 = {
    ok: true;
    newFrameNo: number;
    revertedSandboxes: number;
    deletedFrames: number;
    deletedAttempts: number;
    invalidatedDiffs: number;
    durationMs: number;
    effectBoundary: EffectBoundaryReport$1;
};
type EffectRevertStarted$1 = {
    type: "EffectRevertStarted";
    runId: string;
    operation: string;
    kind: "tool" | "task";
    toolName: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    seq: number;
    effectStatus: "succeeded" | "unknown";
    timestampMs: number;
};
type EffectRevertFinished$1 = {
    type: "EffectRevertFinished";
    runId: string;
    operation: string;
    kind: "tool" | "task";
    toolName: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    seq: number;
    timestampMs: number;
};
type EffectRevertFailed$1 = Omit<EffectRevertFinished$1, "type"> & {
    type: "EffectRevertFailed";
    error: string;
};
type SideEffectBoundaryCrossed$1 = {
    type: "SideEffectBoundaryCrossed";
    runId: string;
    opId: string;
    operation: string;
    report: EffectBoundaryReport$1;
    timestampMs: number;
    parentRunId?: string;
    warningOnly?: boolean;
    lateCompletion?: boolean;
    archivedByOp?: string;
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
/** One persisted `TokenUsageReported` attempt event. */
type RunTokenUsageEvent$1 = {
    nodeId: string;
    iteration: number;
    attempt: number;
    model: string;
    agent: string;
    inputTokens: number;
    freshInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    costUsd: number | null;
    timestampMs: number;
};
type ListRunTokenUsageRequest$1 = {
    runId: string;
};
type ListRunTokenUsageResponse$1 = {
    runId: string;
    events: RunTokenUsageEvent$1[];
};
type GatewayDiffPatch$1 = {
    path: string;
    operation: "add" | "modify" | "delete";
    diff: string;
    binaryContent?: string;
};
type GatewayDiffBundle$1 = {
    seq: number;
    baseRef: string;
    patches: GatewayDiffPatch$1[];
    /** True when computed from the live working copy of a non-terminal run. */
    live?: boolean;
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
        /** Rows to skip after the newest-first sort — server-side pagination with `limit`. */
        offset?: number;
        workflow?: string;
        /** Return only direct children of this run. */
        parentRunId?: string;
        /** System runs are excluded unless an explicit debug surface opts in. */
        includeSystem?: boolean;
        /** Admin-only explicit filter; tenant callers are always scoped to their authenticated pair. */
        owner?: string;
        /** Must be supplied with `owner`. */
        app?: string;
    };
};
type GatewayRunSummary$1 = Record<string, unknown> & {
    runId: string;
    workflowKey?: string;
    status?: string;
    createdAtMs?: number;
    parentRunId?: string | null;
    /** Missing historical metadata is projected as `true` (fail closed). */
    system: boolean;
    startedBy?: RunStartedBy$1;
    /** Missing only when the run has not been cancelled or attribution was not persisted. */
    cancellationSource?: RunCancellationSource$1;
    ownership?: RunOwnership$1;
};
type GetRunResponse$1 = Record<string, unknown> & {
    runId: string;
    workflowKey?: string;
    status?: string;
    createdAtMs?: number;
    startedAtMs?: number | null;
    finishedAtMs?: number | null;
    system: boolean;
    summary?: Record<string, number>;
    runState?: Record<string, unknown>;
    startedBy?: RunStartedBy$1;
    /** Missing only when the run has not been cancelled or attribution was not persisted. */
    cancellationSource?: RunCancellationSource$1;
    ownership?: RunOwnership$1;
};
type ListRunsResponse$1 = GatewayRunSummary$1[];
type ListRunDescendantsRequest$1 = {
    runId: string;
    /** Maximum lineage rows, including the requested root run. */
    limit?: number;
};
type GatewayRunDescendant$1 = {
    runId: string;
    parentRunId: string | null;
    /** Zero for the requested run, one for direct children, and so on. */
    depth: number;
};
type ListRunDescendantsResponse$1 = GatewayRunDescendant$1[];
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
    system: boolean;
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
    provider: "claude-code" | "antigravity" | "codex" | "gemini" | "kimi" | "grok" | "anthropic-api" | "openai-api" | "gemini-api" | "xai-api";
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
type BrowserFrameEvent$1 = {
    sessionId: string;
    seq: number;
    jpegBase64: string;
    viewport: {
        width: number;
        height: number;
    };
};
type BrowserActivityEvent$1 = {
    sessionId: string;
    actionId: string;
    actor: Exclude<BrowserActor$1, "page">;
    revision: number;
    action: BrowserAction$1;
    result: BrowserOutcome$1;
};
type GatewayRpcErrorDetails$1 = Record<string, unknown> & {
    report?: EffectBoundaryReport$1;
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
        details?: GatewayRpcErrorDetails$1;
    };
};

type SmithersApiVersion = SmithersApiVersion$1;
type GatewayRpcErrorCode = GatewayRpcErrorCode$1;
type GatewayRpcMethod = GatewayRpcMethod$1;
type RunStartedBy = RunStartedBy$1;
type RunOwnership = RunOwnership$1;
type RunCancellationSource = RunCancellationSource$1;
type LaunchRunRequest = LaunchRunRequest$1;
type LaunchRunResponse = LaunchRunResponse$1;
type ResumeRunRequest = ResumeRunRequest$1;
type ResumeRunResponse = ResumeRunResponse$1;
type CancelRunRequest = CancelRunRequest$1;
type CancelRunResponse = CancelRunResponse$1;
type CancelledRunOutcome = CancelledRunOutcome$1;
type CancelledProcess = CancelledProcess$1;
type PauseRunRequest = PauseRunRequest$1;
type PauseRunResponse = PauseRunResponse$1;
type HijackRunRequest = HijackRunRequest$1;
type HijackRunResponse = HijackRunResponse$1;
type RewindRunRequest = RewindRunRequest$1;
type RewindRunResponse = RewindRunResponse$1;
type CrossedEffect = CrossedEffect$1;
type EffectBoundaryReport = EffectBoundaryReport$1;
type EffectRevertStarted = EffectRevertStarted$1;
type EffectRevertFinished = EffectRevertFinished$1;
type EffectRevertFailed = EffectRevertFailed$1;
type SideEffectBoundaryCrossed = SideEffectBoundaryCrossed$1;
type SubmitApprovalRequest = SubmitApprovalRequest$1;
type SubmitApprovalResponse = SubmitApprovalResponse$1;
type SubmitSignalRequest = SubmitSignalRequest$1;
type GetRunRequest = GetRunRequest$1;
type GetRunResponse = GetRunResponse$1;
type RunTokenUsageEvent = RunTokenUsageEvent$1;
type ListRunTokenUsageRequest = ListRunTokenUsageRequest$1;
type ListRunTokenUsageResponse = ListRunTokenUsageResponse$1;
type GetRunDiffRequest = GetRunDiffRequest$1;
type GetRunDiffResponse = GetRunDiffResponse$1;
type GetRunDiffOversizedResponse = GetRunDiffOversizedResponse$1;
type GatewayDiffBundle = GatewayDiffBundle$1;
type GatewayDiffPatch = GatewayDiffPatch$1;
type ListRunsRequest = ListRunsRequest$1;
type GatewayRunSummary = GatewayRunSummary$1;
type ListRunsResponse = ListRunsResponse$1;
type ListRunDescendantsRequest = ListRunDescendantsRequest$1;
type GatewayRunDescendant = GatewayRunDescendant$1;
type ListRunDescendantsResponse = ListRunDescendantsResponse$1;
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
type CreateBrowserSessionRequest = CreateBrowserSessionRequest$1;
type BrowserSource = BrowserSource$1;
type BrowserActor = BrowserActor$1;
type BrowserViewport = BrowserViewport$1;
type BrowserPoint = BrowserPoint$1;
type BrowserRectangle = BrowserRectangle$1;
type BrowserModifier = BrowserModifier$1;
type BrowserRedaction = BrowserRedaction$1;
type BrowserOutcome = BrowserOutcome$1;
type BrowserJournalEntry = BrowserJournalEntry$1;
type BrowserContextSlice = BrowserContextSlice$1;
type BrowserSummary = BrowserSummary$1;
type BrowserClickAction = BrowserClickAction$1;
type BrowserFrameEvent = BrowserFrameEvent$1;
type BrowserActivityEvent = BrowserActivityEvent$1;
type BrowserLocator = BrowserLocator$1;
type BrowserSnapshot = BrowserSnapshot$1;
type BrowserAction = BrowserAction$1;
type BrowserActRequest = BrowserActRequest$1;
type BrowserContextRequest = BrowserContextRequest$1;
type BrowserPickRequest = BrowserPickRequest$1;
type CloseBrowserSessionRequest = CloseBrowserSessionRequest$1;
type CreateBrowserSessionResponse = CreateBrowserSessionResponse$1;
type BrowserActResponse = BrowserActResponse$1;
type BrowserContextResponse = BrowserContextResponse$1;
type BrowserScreenshot = BrowserScreenshot$1;
type BrowserSelection = BrowserSelection$1;
type BrowserPickResponse = BrowserPickResponse$1;
type CloseBrowserSessionResponse = CloseBrowserSessionResponse$1;
type ListBrowserSessionsResponse = ListBrowserSessionsResponse$1;
type GatewayRpcErrorDetails = GatewayRpcErrorDetails$1;
type GatewayEventFrame<Payload = unknown> = GatewayEventFrame$1<Payload>;
type GatewayResponseFrame<Payload = unknown> = GatewayResponseFrame$1<Payload>;

export type { BrowserActRequest, BrowserActResponse, BrowserAction, BrowserActivityEvent, BrowserActor, BrowserClickAction, BrowserContextRequest, BrowserContextResponse, BrowserContextSlice, BrowserFrameEvent, BrowserJournalEntry, BrowserLocator, BrowserModifier, BrowserOutcome, BrowserPickRequest, BrowserPickResponse, BrowserPoint, BrowserRectangle, BrowserRedaction, BrowserScreenshot, BrowserSelection, BrowserSnapshot, BrowserSource, BrowserSummary, BrowserViewport, CancelRunRequest, CancelRunResponse, CancelledProcess, CancelledRunOutcome, CloseBrowserSessionRequest, CloseBrowserSessionResponse, CreateBrowserSessionRequest, CreateBrowserSessionResponse, CreateTicketRequest, CronCreateRequest, CronDeleteRequest, CronListRequest, CronRunRequest, CrossedEffect, DeleteTicketRequest, EffectBoundaryReport, EffectRevertFailed, EffectRevertFinished, EffectRevertStarted, GatewayAccount, GatewayApprovalSummary, GatewayComparisonScoreRow, GatewayDiffBundle, GatewayDiffPatch, GatewayDocKind, GatewayDocRow, GatewayEventFrame, GatewayMemoryFact, GatewayPrompt, GatewayResponseFrame, GatewayRpcErrorCode, GatewayRpcErrorDetails, GatewayRpcMethod, GatewayRunDescendant, GatewayRunSummary, GatewayScoreDetail, GatewayScoreRow, GatewayTicketRow, GatewayWorkflowSummary, GetDevToolsSnapshotRequest, GetDevToolsSnapshotResponse, GetRunDiffOversizedResponse, GetRunDiffRequest, GetRunDiffResponse, GetRunRequest, GetRunResponse, GetSchemaSignatureRequest, GetSchemaSignatureResponse, GetScoreDetailRequest, GetScoreDetailResponse, HijackRunRequest, HijackRunResponse, LaunchRunRequest, LaunchRunResponse, ListAccountsRequest, ListAccountsResponse, ListApprovalsRequest, ListApprovalsResponse, ListBrowserSessionsResponse, ListDocsRequest, ListDocsResponse, ListMemoryFactsRequest, ListMemoryFactsResponse, ListPromptsRequest, ListPromptsResponse, ListRunDescendantsRequest, ListRunDescendantsResponse, ListRunTokenUsageRequest, ListRunTokenUsageResponse, ListRunsRequest, ListRunsResponse, ListScoresForRunsRequest, ListScoresForRunsResponse, ListScoresRequest, ListScoresResponse, ListTicketsRequest, ListTicketsResponse, ListWorkflowsRequest, ListWorkflowsResponse, NodeRequest, PauseRunRequest, PauseRunResponse, ResumeRunRequest, ResumeRunResponse, RewindRunRequest, RewindRunResponse, RunCancellationSource, RunOwnership, RunStartedBy, RunTokenUsageEvent, SideEffectBoundaryCrossed, SmithersApiVersion, StreamDevToolsRequest, StreamRunEventsRequest, StreamRunEventsResponse, SubmitApprovalRequest, SubmitApprovalResponse, SubmitSignalRequest, UpdateTicketRequest, WhatHappenedRequest, WhatHappenedResponse };
