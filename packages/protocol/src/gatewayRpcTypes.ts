/**
 * Type-only declarations for the stable v1 Gateway wire contract.
 *
 * Runtime schemas, auth scopes, and catalog metadata stay in the gateway
 * package. These transport shapes live in protocol so clients and UI adapters
 * do not depend on the gateway implementation.
 */
export type SmithersApiVersion = "v1";

export type GatewayRpcErrorCode =
  | "InvalidRequest"
  | "InvalidInput"
  | "Unauthorized"
  | "Forbidden"
  | "RunNotFound"
  | "ScoreNotFound"
  | "RUN_NOT_ACTIVE"
  | "CronNotFound"
  | "TicketNotFound"
  | "NodeNotFound"
  | "IterationNotFound"
  | "NodeHasNoOutput"
  | "FrameOutOfRange"
  | "SeqOutOfRange"
  | "Busy"
  | "AlreadyDecided"
  | "RateLimited"
  | "PayloadTooLarge"
  | "BackpressureDisconnect"
  | "UnsupportedSandbox"
  | "VcsError"
  | "RewindFailed"
  | "Internal";

export type GatewayRpcMethod =
  | "launchRun"
  | "resumeRun"
  | "cancelRun"
  | "pauseRun"
  | "hijackRun"
  | "rewindRun"
  | "submitApproval"
  | "submitSignal"
  | "getRun"
  | "listRuns"
  | "getSchemaSignature"
  | "listWorkflows"
  | "listApprovals"
  | "listDocs"
  | "streamRunEvents"
  | "streamDevTools"
  | "getDevToolsSnapshot"
  | "getNodeOutput"
  | "getNodeDiff"
  | "getRunDiff"
  | "whatHappened"
  | "cronList"
  | "cronCreate"
  | "cronDelete"
  | "cronRun"
  | "listAccounts"
  | "listMemoryFacts"
  | "listPrompts"
  | "listScores"
  | "listScoresForRuns"
  | "getScoreDetail"
  | "listTickets"
  | "createTicket"
  | "updateTicket"
  | "deleteTicket";

export type LaunchRunRequest = {
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

export type LaunchRunResponse = {
  runId: string;
  workflow: string;
};

export type ResumeRunRequest = {
  runId: string;
  options?: {
    force?: boolean;
  };
};

export type ResumeRunResponse = {
  runId: string;
  status: "resume_requested" | "already_terminal";
};

export type CancelRunRequest = {
  runId: string;
};

export type CancelRunResponse = {
  runId: string;
  status: "cancelling";
};

export type PauseRunRequest = {
  runId: string;
};

export type PauseRunResponse = {
  runId: string;
  status: "pausing";
};

export type HijackRunRequest = {
  runId: string;
  options?: Record<string, unknown>;
};

export type HijackRunResponse = {
  runId: string;
  status: "hijack-ready";
  sessionId: string;
};

export type RewindRunRequest = {
  runId: string;
  frameNo: number;
  confirm: true;
};

export type SubmitApprovalRequest = {
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

export type SubmitApprovalResponse = {
  runId: string;
  nodeId: string;
  iteration: number;
  approved: boolean;
};

export type SubmitSignalRequest = {
  runId: string;
  correlationKey: string;
  payload?: unknown;
  signalName?: string;
};

export type GetRunRequest = {
  runId: string;
};

export type GatewayDiffPatch = {
  path: string;
  diff: string;
  additions?: number;
  deletions?: number;
  binary?: boolean;
};

export type GatewayDiffBundle = {
  seq: number;
  baseRef: string;
  patches: GatewayDiffPatch[];
};

export type GetRunDiffRequest = {
  runId: string;
};

export type GetRunDiffOversizedResponse = {
  status: "oversized";
  baseRef: string;
  terminalRef: string;
  sizeBytes: number;
  maxBytes: number;
};

export type GetRunDiffResponse = GatewayDiffBundle | GetRunDiffOversizedResponse;

export type ListRunsRequest = {
  filter?: {
    status?: string;
    limit?: number;
    workflow?: string;
  };
};

export type GetSchemaSignatureRequest = Record<string, never>;

export type GetSchemaSignatureResponse = {
  schemaVersion: string;
  signature: string;
  components?: Record<string, string>;
};

export type GatewayWorkflowSummary = {
  key: string;
  readableName?: string;
  description?: string;
  hasUi: boolean;
  uiPath: string | null;
  /** True for internal plumbing workflows (e.g. init) hidden from default listings. */
  system?: boolean;
};

export type ListWorkflowsRequest = {
  filter?: {
    hasUi?: boolean;
    /** System workflows are excluded from results unless this is true. */
    includeSystem?: boolean;
  };
};

export type ListWorkflowsResponse = GatewayWorkflowSummary[];

export type GatewayApprovalSummary = {
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

export type ListApprovalsRequest = {
  filter?: {
    runId?: string;
    workflow?: string;
    limit?: number;
  };
};

export type ListApprovalsResponse = GatewayApprovalSummary[];

export type GatewayDocRow = {
  path: string;
  kind: "ticket" | "plan" | "spec" | "proposal" | "conflict" | (string & {});
  content: string;
  contentHash: string;
  updatedAtMs: number;
  deletedAtMs: number | null;
};

export type ListDocsRequest = {
  filter?: {
    kind?: string;
    includeDeleted?: boolean;
    updatedAfterMs?: number;
    limit?: number;
  };
};

export type ListDocsResponse = GatewayDocRow[];

export type StreamRunEventsRequest = {
  runId: string;
  afterSeq?: number;
};

export type StreamRunEventsResponse = {
  streamId: string;
  runId: string;
  afterSeq: number | null;
  currentSeq: number;
};

export type StreamDevToolsRequest = {
  runId: string;
  afterSeq?: number;
  fromSeq?: number;
};

export type GetDevToolsSnapshotRequest = {
  runId: string;
  frameNo?: number;
};

export type GetDevToolsSnapshotResponse = Record<string, unknown>;

export type NodeRequest = {
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
export type WhatHappenedRequest = {
  runId: string;
  nodeId?: string;
  iteration?: number;
};

export type WhatHappenedResponse = {
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

export type CronListRequest = {
  filter?: {
    workflow?: string;
  };
};

export type CronCreateRequest = {
  workflow: string;
  pattern: string;
  cronId?: string;
  enabled?: boolean;
};

export type CronDeleteRequest = {
  cronId: string;
};

export type CronRunRequest = {
  cronId?: string;
  workflow?: string;
  input?: Record<string, unknown>;
};

/**
 * One registered Smithers agent account: a row in the user-level
 * `~/.smithers/accounts.json` registry surfaced read-only by `listAccounts`.
 * Secret API keys are never included in this wire shape.
 */
export type GatewayAccount = {
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

export type ListAccountsRequest = Record<string, never>;

export type ListAccountsResponse = GatewayAccount[];

/** One cross-run memory fact row (the `_smithers_memory_facts` table, snake-to-camel cased). */
export type GatewayMemoryFact = {
  namespace: string;
  key: string;
  valueJson: string;
  schemaSig?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  ttlMs?: number | null;
};

export type ListMemoryFactsRequest = {
  namespace?: string;
};

export type ListMemoryFactsResponse = GatewayMemoryFact[];

/** One registered prompt row returned by `listPrompts`. */
export type GatewayPrompt = {
  id: string;
  entryFile: string;
  source: string;
  createdAtMs?: number;
  updatedAtMs?: number;
};

export type ListPromptsRequest = Record<string, never>;

export type ListPromptsResponse = GatewayPrompt[];

/** One scorer/eval result row returned by `listScores`. */
export type GatewayScoreRow = {
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

export type ListScoresRequest = {
  runId: string;
  nodeId?: string;
};

export type ListScoresResponse = GatewayScoreRow[];

/** One cross-run score row, including the exact persisted score identity. */
export type GatewayComparisonScoreRow = GatewayScoreRow & {
  scoreId: string;
};

/** Batch score rows for explicit run ids. */
export type ListScoresForRunsRequest = {
  runIds: string[];
  nodeId?: string;
  scorerId?: string;
  scorerName?: string;
  source?: "live" | "batch";
  order?: "scoredAtAsc" | "scoredAtDesc";
  offset?: number;
  limit?: number;
};

export type ListScoresForRunsResponse = {
  rows: GatewayComparisonScoreRow[];
  total: number;
};

export type GetScoreDetailRequest = {
  runId: string;
  scoreId: string;
};

/** One exact persisted score with its JSON detail columns decoded. */
export type GatewayScoreDetail = GatewayComparisonScoreRow & {
  meta: unknown;
  input: unknown;
  output: unknown;
  groundTruth: unknown;
  context: unknown;
};

export type GetScoreDetailResponse = GatewayScoreDetail;

/** A doc kind stored in `_smithers_docs`; the tickets surface uses `ticket`. */
export type GatewayDocKind = "ticket" | "plan" | "spec" | "proposal";

/** One live doc row returned by `listTickets`. */
export type GatewayTicketRow = {
  path: string;
  kind: GatewayDocKind;
  content: string;
  contentHash: string;
  status?: string | null;
  updatedAtMs: number;
};

export type ListTicketsRequest = {
  /** Optional doc-kind filter; omit to list every kind. Defaults to all. */
  kind?: GatewayDocKind;
};

export type ListTicketsResponse = GatewayTicketRow[];

export type CreateTicketRequest = {
  /** Doc identity (PK); e.g. a ticket id like `feat-issues-card`. */
  path: string;
  content: string;
  kind?: GatewayDocKind;
  status?: string;
};

export type UpdateTicketRequest = {
  path: string;
  content?: string;
  status?: string;
};

export type DeleteTicketRequest = {
  path: string;
};

export type GatewayEventFrame<Payload = unknown> = {
  type: "event";
  event: string;
  payload?: Payload;
  seq: number;
  stateVersion: number;
  apiVersion?: SmithersApiVersion;
};

export type GatewayResponseFrame<Payload = unknown> =
  | {
      type: "res";
      id: string;
      ok: true;
      apiVersion?: SmithersApiVersion;
      payload: Payload;
    }
  | {
      type: "res";
      id: string;
      ok: false;
      apiVersion?: SmithersApiVersion;
      error: {
        version?: SmithersApiVersion;
        code: string;
        message: string;
        requiredScope?: string;
        refresh?: string;
        details?: unknown;
      };
    };
