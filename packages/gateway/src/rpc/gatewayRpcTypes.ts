/**
 * Type-only declarations for the stable v1 Gateway RPC contract. The runtime
 * catalog (schemas, error definitions, lookup helpers) lives in `index.js`,
 * which re-exports every type here via its `@smithers-type-exports` block.
 *
 * This file deliberately does NOT share a basename with `index.js`: a
 * same-basename `.js`/`.ts` pair both compile to one `.d.ts` and the type-only
 * twin silently drops every value export from the `.js`.
 */
import type { GatewayScope } from "../auth/scopes.js";

export type SmithersApiVersion = "v1";

export type JsonSchema = {
  readonly type?: string | readonly string[];
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly format?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: unknown;
  readonly nullable?: boolean;
  readonly items?: JsonSchema;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
};

export type GatewayRpcErrorCode =
  | "InvalidRequest"
  | "InvalidInput"
  | "Unauthorized"
  | "Forbidden"
  | "RunNotFound"
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

export type GatewayRpcErrorDefinition = {
  readonly version: SmithersApiVersion;
  readonly code: GatewayRpcErrorCode;
  readonly httpStatus: number;
  readonly description: string;
};

export type GatewayRpcDefinition = {
  readonly version: SmithersApiVersion;
  readonly method: GatewayRpcMethod;
  readonly title: string;
  readonly description: string;
  readonly maturity: "stable";
  readonly transport: "http" | "websocket" | "http+websocket";
  readonly requiredScope: GatewayScope;
  readonly requestSchema: JsonSchema;
  readonly responseSchema: JsonSchema;
  readonly errors: readonly GatewayRpcErrorCode[];
  readonly exampleRequest: unknown;
  readonly exampleResponse: unknown;
};

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
  | "cronList"
  | "cronCreate"
  | "cronDelete"
  | "cronRun"
  | "listAccounts"
  | "listMemoryFacts"
  | "listPrompts"
  | "listScores"
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
  kind: "ticket" | "plan" | "spec" | "proposal" | "conflict" | string;
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
export type GatewayAccount = {
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

export type ListAccountsRequest = Record<string, never>;

export type ListAccountsResponse = GatewayAccount[];

/** One cross-run memory fact row (the `_smithers_memory_facts` table, snake→camel cased). */
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

/**
 * One registered prompt row — a `.md`/`.mdx` file walked from the project's
 * `.smithers/prompts/` directory by the `listPrompts` server handler. `id` is the
 * prompt's relative path without extension (e.g. `refactor` or
 * `release-content/changelog`); `entryFile` is the workspace-relative source path
 * (e.g. `prompts/refactor.mdx`); `source` is the raw file text. The timestamps
 * come from `fs.stat` (`birthtimeMs`/`mtimeMs`) so a freshly-edited prompt sorts
 * recent.
 */
export type GatewayPrompt = {
  id: string;
  entryFile: string;
  source: string;
  createdAtMs?: number;
  updatedAtMs?: number;
};

export type ListPromptsRequest = Record<string, never>;

export type ListPromptsResponse = GatewayPrompt[];

/**
 * One scorer/eval result row (the `_smithers_scorers` table, snake→camel cased).
 * `score` is the scorer's verdict; `latencyMs`/`durationMs` are the only timing
 * metrics the table carries (there is NO token/cost data — those tiles are
 * computed client-side and em-dashed when absent).
 */
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

/**
 * A doc kind stored in `_smithers_docs`; the tickets surface uses `ticket`. The
 * runtime `DOC_KINDS` tuple in `index.js` (which feeds every ticket-RPC schema
 * enum) is annotated against this union so the two cannot drift apart.
 */
export type GatewayDocKind = "ticket" | "plan" | "spec" | "proposal";

/**
 * One LIVE doc row (the `_smithers_docs` table, snake→camel cased) returned by
 * `listTickets`. Tombstones (`deletedAtMs != null`) are filtered server-side and
 * NEVER appear here. `status` rides the row so a ticket's status survives reload
 * (LOCKED Path A); `contentHash` is `sha256(content)`.
 */
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
