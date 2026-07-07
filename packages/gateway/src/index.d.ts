/**
 * @param {string} scope
 * @returns {scope is GatewayScope}
 */
declare function isGatewayScope(scope: string): scope is GatewayScope$3;
/**
 * @param {readonly string[]} grantedScopes
 * @param {GatewayScope} requiredScope
 * @param {string} [methodName]
 * @returns {boolean}
 */
declare function hasGatewayScope(grantedScopes: readonly string[], requiredScope: GatewayScope$3, methodName?: string): boolean;
/** @typedef {(typeof GATEWAY_SCOPE_VALUES)[number]} GatewayScope */
declare const GATEWAY_SCOPE_VALUES$1: readonly ["run:read", "run:write", "run:admin", "approval:submit", "signal:submit", "cron:read", "cron:write", "account:read", "memory:read", "prompt:read", "score:read", "ticket:read", "ticket:write", "observability:read"];
/** @type {Record<GatewayScope, string>} */
declare const GATEWAY_SCOPE_DESCRIPTIONS: Record<GatewayScope$3, string>;
type GatewayScope$3 = (typeof GATEWAY_SCOPE_VALUES$1)[number];

/**
 * Type-only declarations for the stable v1 Gateway RPC contract. The runtime
 * catalog (schemas, error definitions, lookup helpers) lives in `index.js`,
 * which re-exports every type here via its `@smithers-type-exports` block.
 *
 * This file deliberately does NOT share a basename with `index.js`: a
 * same-basename `.js`/`.ts` pair both compile to one `.d.ts` and the type-only
 * twin silently drops every value export from the `.js`.
 */

type SmithersApiVersion$3 = "v1";
type JsonSchema$3 = {
    readonly type?: string | readonly string[];
    readonly description?: string;
    readonly enum?: readonly unknown[];
    readonly const?: unknown;
    readonly format?: string;
    readonly minimum?: number;
    readonly maximum?: number;
    readonly default?: unknown;
    readonly nullable?: boolean;
    readonly items?: JsonSchema$3;
    readonly properties?: Record<string, JsonSchema$3>;
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean | JsonSchema$3;
    readonly oneOf?: readonly JsonSchema$3[];
    readonly anyOf?: readonly JsonSchema$3[];
};
type GatewayRpcErrorCode$3 = "InvalidRequest" | "InvalidInput" | "Unauthorized" | "Forbidden" | "RunNotFound" | "RUN_NOT_ACTIVE" | "CronNotFound" | "TicketNotFound" | "NodeNotFound" | "IterationNotFound" | "NodeHasNoOutput" | "FrameOutOfRange" | "SeqOutOfRange" | "Busy" | "AlreadyDecided" | "RateLimited" | "PayloadTooLarge" | "BackpressureDisconnect" | "UnsupportedSandbox" | "VcsError" | "RewindFailed" | "Internal";
type GatewayRpcErrorDefinition$3 = {
    readonly version: SmithersApiVersion$3;
    readonly code: GatewayRpcErrorCode$3;
    readonly httpStatus: number;
    readonly description: string;
};
type GatewayRpcDefinition$3 = {
    readonly version: SmithersApiVersion$3;
    readonly method: GatewayRpcMethod$3;
    readonly title: string;
    readonly description: string;
    readonly maturity: "stable";
    readonly transport: "http" | "websocket" | "http+websocket";
    readonly requiredScope: GatewayScope$3;
    readonly requestSchema: JsonSchema$3;
    readonly responseSchema: JsonSchema$3;
    readonly errors: readonly GatewayRpcErrorCode$3[];
    readonly exampleRequest: unknown;
    readonly exampleResponse: unknown;
};
type GatewayRpcMethod$3 = "launchRun" | "resumeRun" | "cancelRun" | "pauseRun" | "hijackRun" | "rewindRun" | "submitApproval" | "submitSignal" | "getRun" | "listRuns" | "getSchemaSignature" | "listWorkflows" | "listApprovals" | "listDocs" | "streamRunEvents" | "streamDevTools" | "getDevToolsSnapshot" | "getNodeOutput" | "getNodeDiff" | "cronList" | "cronCreate" | "cronDelete" | "cronRun" | "listAccounts" | "listMemoryFacts" | "listPrompts" | "listScores" | "listTickets" | "createTicket" | "updateTicket" | "deleteTicket";
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
    kind: "ticket" | "plan" | "spec" | "proposal" | "conflict" | string;
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
 * One registered Smithers agent account — a row in the user-level
 * `~/.smithers/accounts.json` registry that the `smithers agents` CLI manages,
 * surfaced read-only by the `listAccounts` server handler (via the
 * `@smithers-orchestrator/accounts` package). Each account is either a
 * subscription provider (a per-account CLI `configDir`) or an API provider (an
 * `apiKey`); the two are mutually exclusive.
 *
 * SECRET REDACTION: the raw `apiKey` is NEVER sent over the wire — it is a
 * plaintext credential stored mode-600 on disk. Instead `hasApiKey` reports
 * whether an api-key account carries a non-empty key, and `hasConfigDir`
 * reports whether a subscription account has a config dir, so a client can
 * render the account's auth posture without ever receiving the secret.
 */
type GatewayAccount$1 = {
    /** Unique account label (the registry key, `--label`). */
    label: string;
    /**
     * Provider id, one of the fixed `smithers agents` catalog. The runtime
     * `ACCOUNT_PROVIDERS` tuple in `index.js` is annotated against this union so
     * the listAccounts schema enum cannot carry a provider this type rejects.
     */
    provider: "claude-code" | "antigravity" | "codex" | "gemini" | "kimi" | "anthropic-api" | "openai-api" | "gemini-api";
    /** Per-account CLI config dir for subscription providers (absent for api-key accounts). */
    configDir?: string | null;
    /** True when a subscription account has a non-empty config dir. */
    hasConfigDir: boolean;
    /** True when an api-key account carries a non-empty key (the key itself is NEVER returned). */
    hasApiKey: boolean;
    /** Optional default model baked into the account. */
    model?: string | null;
    /** ISO timestamp of when the account was added, when known. */
    addedAt?: string | null;
};
type ListAccountsRequest$1 = Record<string, never>;
type ListAccountsResponse$1 = GatewayAccount$1[];
/** One cross-run memory fact row (the `_smithers_memory_facts` table, snake→camel cased). */
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
/**
 * One registered prompt row — a `.md`/`.mdx` file walked from the project's
 * `.smithers/prompts/` directory by the `listPrompts` server handler. `id` is the
 * prompt's relative path without extension (e.g. `refactor` or
 * `release-content/changelog`); `entryFile` is the workspace-relative source path
 * (e.g. `prompts/refactor.mdx`); `source` is the raw file text. The timestamps
 * come from `fs.stat` (`birthtimeMs`/`mtimeMs`) so a freshly-edited prompt sorts
 * recent.
 */
type GatewayPrompt$1 = {
    id: string;
    entryFile: string;
    source: string;
    createdAtMs?: number;
    updatedAtMs?: number;
};
type ListPromptsRequest$1 = Record<string, never>;
type ListPromptsResponse$1 = GatewayPrompt$1[];
/**
 * One scorer/eval result row (the `_smithers_scorers` table, snake→camel cased).
 * `score` is the scorer's verdict; `latencyMs`/`durationMs` are the only timing
 * metrics the table carries (there is NO token/cost data — those tiles are
 * computed client-side and em-dashed when absent).
 */
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
/**
 * A doc kind stored in `_smithers_docs`; the tickets surface uses `ticket`. The
 * runtime `DOC_KINDS` tuple in `index.js` (which feeds every ticket-RPC schema
 * enum) is annotated against this union so the two cannot drift apart.
 */
type GatewayDocKind$1 = "ticket" | "plan" | "spec" | "proposal";
/**
 * One LIVE doc row (the `_smithers_docs` table, snake→camel cased) returned by
 * `listTickets`. Tombstones (`deletedAtMs != null`) are filtered server-side and
 * NEVER appear here. `status` rides the row so a ticket's status survives reload
 * (LOCKED Path A); `contentHash` is `sha256(content)`.
 */
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

/** @typedef {(typeof GATEWAY_SCOPE_VALUES)[number]} GatewayScope */
declare const GATEWAY_SCOPE_VALUES: readonly ["run:read", "run:write", "run:admin", "approval:submit", "signal:submit", "cron:read", "cron:write", "account:read", "memory:read", "prompt:read", "score:read", "ticket:read", "ticket:write", "observability:read"];
type GatewayScope$1 = (typeof GATEWAY_SCOPE_VALUES)[number];

/**
 * Type-only declarations for the stable v1 Gateway RPC contract. The runtime
 * catalog (schemas, error definitions, lookup helpers) lives in `index.js`,
 * which re-exports every type here via its `@smithers-type-exports` block.
 *
 * This file deliberately does NOT share a basename with `index.js`: a
 * same-basename `.js`/`.ts` pair both compile to one `.d.ts` and the type-only
 * twin silently drops every value export from the `.js`.
 */

type SmithersApiVersion$1 = "v1";
type JsonSchema$1 = {
    readonly type?: string | readonly string[];
    readonly description?: string;
    readonly enum?: readonly unknown[];
    readonly const?: unknown;
    readonly format?: string;
    readonly minimum?: number;
    readonly maximum?: number;
    readonly default?: unknown;
    readonly nullable?: boolean;
    readonly items?: JsonSchema$1;
    readonly properties?: Record<string, JsonSchema$1>;
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean | JsonSchema$1;
    readonly oneOf?: readonly JsonSchema$1[];
    readonly anyOf?: readonly JsonSchema$1[];
};
type GatewayRpcErrorCode$1 = "InvalidRequest" | "InvalidInput" | "Unauthorized" | "Forbidden" | "RunNotFound" | "RUN_NOT_ACTIVE" | "CronNotFound" | "TicketNotFound" | "NodeNotFound" | "IterationNotFound" | "NodeHasNoOutput" | "FrameOutOfRange" | "SeqOutOfRange" | "Busy" | "AlreadyDecided" | "RateLimited" | "PayloadTooLarge" | "BackpressureDisconnect" | "UnsupportedSandbox" | "VcsError" | "RewindFailed" | "Internal";
type GatewayRpcErrorDefinition$1 = {
    readonly version: SmithersApiVersion$1;
    readonly code: GatewayRpcErrorCode$1;
    readonly httpStatus: number;
    readonly description: string;
};
type GatewayRpcDefinition$1 = {
    readonly version: SmithersApiVersion$1;
    readonly method: GatewayRpcMethod$1;
    readonly title: string;
    readonly description: string;
    readonly maturity: "stable";
    readonly transport: "http" | "websocket" | "http+websocket";
    readonly requiredScope: GatewayScope$1;
    readonly requestSchema: JsonSchema$1;
    readonly responseSchema: JsonSchema$1;
    readonly errors: readonly GatewayRpcErrorCode$1[];
    readonly exampleRequest: unknown;
    readonly exampleResponse: unknown;
};
type GatewayRpcMethod$1 = "launchRun" | "resumeRun" | "cancelRun" | "pauseRun" | "hijackRun" | "rewindRun" | "submitApproval" | "submitSignal" | "getRun" | "listRuns" | "getSchemaSignature" | "listWorkflows" | "listApprovals" | "listDocs" | "streamRunEvents" | "streamDevTools" | "getDevToolsSnapshot" | "getNodeOutput" | "getNodeDiff" | "cronList" | "cronCreate" | "cronDelete" | "cronRun" | "listAccounts" | "listMemoryFacts" | "listPrompts" | "listScores" | "listTickets" | "createTicket" | "updateTicket" | "deleteTicket";

/**
 * @param {string} method
 * @returns {GatewayRpcMethod | undefined}
 */
declare function canonicalGatewayRpcMethod(method: string): GatewayRpcMethod$2 | undefined;
/**
 * @param {string} method
 * @returns {GatewayRpcDefinition | undefined}
 */
declare function getGatewayRpcDefinition(method: string): GatewayRpcDefinition$2 | undefined;
/**
 * @param {string} method
 * @returns {GatewayScope | undefined}
 */
declare function getRequiredScopeForGatewayMethod(method: string): GatewayScope$2 | undefined;
/**
 * @returns {readonly GatewayRpcMethod[]}
 */
declare function listGatewayRpcMethods(): readonly GatewayRpcMethod$2[];
/**
 * @param {string} method
 * @returns {method is GatewayRpcMethod}
 */
declare function isGatewayRpcMethod(method: string): method is GatewayRpcMethod$2;
/**
 * @returns {readonly GatewayScope[]}
 */
declare function getGatewayScopeValues(): readonly GatewayScope$2[];
declare const SMITHERS_API_VERSION: SmithersApiVersion$2;
declare const GATEWAY_EVENT_WINDOW_DEFAULT: 10000;
/** @type {JsonSchema} */
declare const anyJsonSchema: JsonSchema$2;
/** @type {Record<GatewayRpcErrorCode, GatewayRpcErrorDefinition>} */
declare const GATEWAY_RPC_ERRORS: Record<GatewayRpcErrorCode$2, GatewayRpcErrorDefinition$2>;
/** @type {Record<string, GatewayRpcMethod>} */
declare const GATEWAY_RPC_LEGACY_METHOD_ALIASES: Record<string, GatewayRpcMethod$2>;
/** @type {readonly GatewayRpcDefinition[]} */
declare const GATEWAY_RPC_DEFINITIONS: readonly GatewayRpcDefinition$2[];
type SmithersApiVersion$2 = SmithersApiVersion$1;
type JsonSchema$2 = JsonSchema$1;
type GatewayRpcErrorCode$2 = GatewayRpcErrorCode$1;
type GatewayRpcErrorDefinition$2 = GatewayRpcErrorDefinition$1;
type GatewayRpcDefinition$2 = GatewayRpcDefinition$1;
type GatewayRpcMethod$2 = GatewayRpcMethod$1;
type GatewayScope$2 = GatewayScope$1;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeAccountRow<Row extends Record<string, unknown>>(row: Row): Row;

declare const apiCollectionNames: readonly ["runs", "run_events", "nodes", "node_outputs", "approvals", "crons", "tickets", "docs"];

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeApprovalRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeCronRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeDocRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeMemoryFactRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializePromptRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeRunEventRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeRunRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeScoreRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeTicketRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeWorkflowRow<Row extends Record<string, unknown>>(row: Row): Row;

type GatewayScope = GatewayScope$3;
type SmithersApiVersion = SmithersApiVersion$3;
type JsonSchema = JsonSchema$3;
type GatewayRpcErrorCode = GatewayRpcErrorCode$3;
type GatewayRpcErrorDefinition = GatewayRpcErrorDefinition$3;
type GatewayRpcDefinition = GatewayRpcDefinition$3;
type GatewayRpcMethod = GatewayRpcMethod$3;
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
type GatewayDocKind = GatewayDocKind$1;
type GatewayTicketRow = GatewayTicketRow$1;
type ListTicketsRequest = ListTicketsRequest$1;
type ListTicketsResponse = ListTicketsResponse$1;
type CreateTicketRequest = CreateTicketRequest$1;
type UpdateTicketRequest = UpdateTicketRequest$1;
type DeleteTicketRequest = DeleteTicketRequest$1;

export { type CancelRunRequest, type CancelRunResponse, type CreateTicketRequest, type CronCreateRequest, type CronDeleteRequest, type CronListRequest, type CronRunRequest, type DeleteTicketRequest, GATEWAY_EVENT_WINDOW_DEFAULT, GATEWAY_RPC_DEFINITIONS, GATEWAY_RPC_ERRORS, GATEWAY_RPC_LEGACY_METHOD_ALIASES, GATEWAY_SCOPE_DESCRIPTIONS, GATEWAY_SCOPE_VALUES$1 as GATEWAY_SCOPE_VALUES, type GatewayAccount, type GatewayApprovalSummary, type GatewayDocKind, type GatewayDocRow, type GatewayMemoryFact, type GatewayPrompt, type GatewayRpcDefinition, type GatewayRpcErrorCode, type GatewayRpcErrorDefinition, type GatewayRpcMethod, type GatewayScope, type GatewayScoreRow, type GatewayTicketRow, type GatewayWorkflowSummary, type GetDevToolsSnapshotRequest, type GetDevToolsSnapshotResponse, type GetRunRequest, type GetSchemaSignatureRequest, type GetSchemaSignatureResponse, type HijackRunRequest, type HijackRunResponse, type JsonSchema, type LaunchRunRequest, type LaunchRunResponse, type ListAccountsRequest, type ListAccountsResponse, type ListApprovalsRequest, type ListApprovalsResponse, type ListDocsRequest, type ListDocsResponse, type ListMemoryFactsRequest, type ListMemoryFactsResponse, type ListPromptsRequest, type ListPromptsResponse, type ListRunsRequest, type ListScoresRequest, type ListScoresResponse, type ListTicketsRequest, type ListTicketsResponse, type ListWorkflowsRequest, type ListWorkflowsResponse, type NodeRequest, type PauseRunRequest, type PauseRunResponse, type ResumeRunRequest, type ResumeRunResponse, type RewindRunRequest, SMITHERS_API_VERSION, type SmithersApiVersion, type StreamDevToolsRequest, type StreamRunEventsRequest, type StreamRunEventsResponse, type SubmitApprovalRequest, type SubmitApprovalResponse, type SubmitSignalRequest, type UpdateTicketRequest, anyJsonSchema, apiCollectionNames, canonicalGatewayRpcMethod, getGatewayRpcDefinition, getGatewayScopeValues, getRequiredScopeForGatewayMethod, hasGatewayScope, isGatewayRpcMethod, isGatewayScope, listGatewayRpcMethods, serializeAccountRow, serializeApprovalRow, serializeCronRow, serializeDocRow, serializeMemoryFactRow, serializePromptRow, serializeRunEventRow, serializeRunRow, serializeScoreRow, serializeTicketRow, serializeWorkflowRow };
