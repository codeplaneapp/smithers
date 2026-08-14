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
  | "TIME_TRAVEL_SIDE_EFFECT_BLOCKED"
  | "Internal"
  | "REVISION_CONFLICT"
  | "SSRF_BLOCKED"
  | "QUOTA_EXCEEDED";

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
  | "listRunTokenUsage"
  | "listRuns"
  | "listRunDescendants"
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
  | "listUsageReports"
  | "listMemoryFacts"
  | "listPrompts"
  | "listScores"
  | "listScoresForRuns"
  | "getScoreDetail"
  | "listTickets"
  | "createTicket"
  | "updateTicket"
  | "deleteTicket"
  | "createBrowserSession"
  | "browserAct"
  | "browserContext"
  | "browserPick"
  | "closeBrowserSession"
  | "listBrowserSessions";

export type BrowserActor = "user" | "agent" | "page";
export type BrowserViewport = { width: number; height: number };
export type BrowserPoint = { x: number; y: number };
export type BrowserRectangle = BrowserPoint & { width: number; height: number };
export type BrowserModifier = "Alt" | "Control" | "Meta" | "Shift" | (string & {});
export type BrowserRedaction = { redacted: true; length: number };
export type BrowserOutcome =
  | { ok: true; redirectedTo?: string; redacted?: boolean; length?: number }
  | { ok: false; code: string; message: string };
export type BrowserJournalEntry = {
  actionId: string;
  actor: Exclude<BrowserActor, "page">;
  revision: number;
  action: BrowserAction;
  result: BrowserOutcome;
};
export type BrowserContextSlice =
  | "visible-text"
  | "accessibility"
  | "interactive-elements"
  | "screenshot"
  | "selections"
  | "recent-actions"
  | "console-summary"
  | "network-summary";
export type BrowserSummary = { message?: string; count?: number; truncated?: boolean } & Record<string, unknown>;
export type BrowserSource = { kind: "url"; url: string } | { kind: "dev-server"; port: number; path?: string };
export type BrowserSnapshot = {
  sessionId: string;
  source: BrowserSource;
  status: "starting" | "ready" | "loading" | "suspended" | "closed" | "failed";
  revision: number;
  page: { url: string; title: string; canGoBack: boolean; canGoForward: boolean } | null;
  viewport: BrowserViewport;
  control: { owner: "user" | "agent" | null };
};
export type BrowserLocator = { testId: string } | { role: string; name?: string } | { css: string };
export type BrowserClickAction =
  | {
      kind: "click";
      locator: BrowserLocator;
      point?: never;
      button?: "left" | "right" | "middle";
      modifiers?: BrowserModifier[];
    }
  | {
      kind: "click";
      point: BrowserPoint;
      locator?: never;
      button?: "left" | "right" | "middle";
      modifiers?: BrowserModifier[];
    };
export type BrowserAction =
  | { kind: "navigate"; url: string }
  | { kind: "back" | "forward" | "reload" | "stop" }
  | BrowserClickAction
  | { kind: "type"; locator: BrowserLocator; text: string; replace?: boolean }
  | { kind: "press"; key: string; modifiers?: BrowserModifier[] }
  | { kind: "scroll"; deltaX: number; deltaY: number }
  | { kind: "dialog"; decision: "accept" | "dismiss"; promptText?: string };
export type CreateBrowserSessionRequest = { source: BrowserSource; viewport?: { width: number; height: number } };
export type BrowserActRequest = {
  sessionId: string;
  actionId: string;
  expectedRevision?: number;
  action: BrowserAction;
};
export type BrowserContextRequest = { sessionId: string; sinceRevision?: number; include?: string[] };
export type BrowserPickRequest = { sessionId: string; point: { x: number; y: number } };
export type CloseBrowserSessionRequest = { sessionId: string };
export type CreateBrowserSessionResponse = BrowserSnapshot;
export type BrowserActResponse = { revision: number; page: BrowserSnapshot["page"]; outcome: BrowserOutcome };
export type BrowserScreenshot = { data: string; mediaType: "image/jpeg" };
export type BrowserSelection = {
  locator: BrowserLocator;
  role: string;
  name: string;
  text: string;
  fingerprint: string;
  rect: BrowserRectangle;
  viewport: BrowserViewport;
};
export type BrowserContextResponse = {
  fresh: boolean;
  reason?: string;
  snapshot: BrowserSnapshot;
  revision: number;
  include: string[];
  visibleText?: string;
  visibleTextTruncated?: boolean;
  interactiveElements?: unknown[];
  interactiveElementsTruncated?: boolean;
  accessibility?: string | null;
  recentActions?: unknown[];
  selections?: BrowserSelection[];
  consoleSummary?: unknown[];
  networkSummary?: unknown[];
  screenshot?: BrowserScreenshot | null;
};
export type BrowserPickResponse = BrowserSelection & { screenshot: BrowserScreenshot | null };
export type CloseBrowserSessionResponse = { closed: boolean; sessionId?: string };
export type ListBrowserSessionsResponse = BrowserSnapshot[];

/**
 * Self-reported launch provenance, distinct from authenticated identity.
 * `harness` and `sessionId` are trimmed and limited to 64 and 256 Unicode
 * code points. `prompt` is explicit-only and is visibly clipped at 8,192 code
 * points. `detected` may only be literal `true` when identity was inferred.
 */
export type RunStartedBy = {
  harness?: string;
  sessionId?: string;
  prompt?: string;
  detected?: true;
};

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
    startedBy?: RunStartedBy;
  };
};

export type LaunchRunResponse = {
  runId: string;
  workflow: string;
  /** Immutable visibility copied from the registered workflow when the run was created. */
  system: boolean;
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
  force?: boolean;
  noRevert?: boolean;
};

export type CrossedEffect = {
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

export type EffectBoundaryReport = {
  blocking: CrossedEffect[];
  revertible: CrossedEffect[];
  warnings: CrossedEffect[];
};

export type RewindRunResponse = {
  ok: true;
  newFrameNo: number;
  revertedSandboxes: number;
  deletedFrames: number;
  deletedAttempts: number;
  invalidatedDiffs: number;
  durationMs: number;
  effectBoundary: EffectBoundaryReport;
};

export type EffectRevertStarted = {
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

export type EffectRevertFinished = {
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

export type EffectRevertFailed = Omit<EffectRevertFinished, "type"> & {
  type: "EffectRevertFailed";
  error: string;
};

export type SideEffectBoundaryCrossed = {
  type: "SideEffectBoundaryCrossed";
  runId: string;
  opId: string;
  operation: string;
  report: EffectBoundaryReport;
  timestampMs: number;
  parentRunId?: string;
  warningOnly?: boolean;
  lateCompletion?: boolean;
  archivedByOp?: string;
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

/** One persisted `TokenUsageReported` attempt event. */
export type RunTokenUsageEvent = {
  nodeId: string;
  iteration: number;
  attempt: number;
  model: string;
  agent: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  timestampMs: number;
};

export type ListRunTokenUsageRequest = {
  runId: string;
};

export type ListRunTokenUsageResponse = {
  runId: string;
  events: RunTokenUsageEvent[];
};

export type GatewayDiffPatch = {
  path: string;
  operation: "add" | "modify" | "delete";
  diff: string;
  binaryContent?: string;
};

export type GatewayDiffBundle = {
  seq: number;
  baseRef: string;
  patches: GatewayDiffPatch[];
  /** True when computed from the live working copy of a non-terminal run. */
  live?: boolean;
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
    /** Rows to skip after the newest-first sort — server-side pagination with `limit`. */
    offset?: number;
    workflow?: string;
    /** Return only direct children of this run. */
    parentRunId?: string;
    /** System runs are excluded unless an explicit debug surface opts in. */
    includeSystem?: boolean;
  };
};

export type GatewayRunSummary = Record<string, unknown> & {
  runId: string;
  workflowKey?: string;
  status?: string;
  createdAtMs?: number;
  parentRunId?: string | null;
  /** Missing historical metadata is projected as `true` (fail closed). */
  system: boolean;
  startedBy?: RunStartedBy;
};

export type ListRunsResponse = GatewayRunSummary[];

export type ListRunDescendantsRequest = {
  runId: string;
  /** Maximum lineage rows, including the requested root run. */
  limit?: number;
};

export type GatewayRunDescendant = {
  runId: string;
  parentRunId: string | null;
  /** Zero for the requested run, one for direct children, and so on. */
  depth: number;
};

export type ListRunDescendantsResponse = GatewayRunDescendant[];

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
  system: boolean;
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
export type BrowserFrameEvent = {
  sessionId: string;
  seq: number;
  jpegBase64: string;
  viewport: { width: number; height: number };
};
export type BrowserActivityEvent = {
  sessionId: string;
  actionId: string;
  actor: Exclude<BrowserActor, "page">;
  revision: number;
  action: BrowserAction;
  result: BrowserOutcome;
};

export type GatewayRpcErrorDetails = Record<string, unknown> & {
  report?: EffectBoundaryReport;
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
        details?: GatewayRpcErrorDetails;
      };
    };
