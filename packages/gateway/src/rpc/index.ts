import type { GatewayScope } from "../auth/scopes.ts";
import { GATEWAY_SCOPE_VALUES } from "../auth/scopes.ts";

export const SMITHERS_API_VERSION = "v1" as const;
export const GATEWAY_EVENT_WINDOW_DEFAULT = 10_000;

export type SmithersApiVersion = typeof SMITHERS_API_VERSION;

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
  | "hijackRun"
  | "rewindRun"
  | "submitApproval"
  | "submitSignal"
  | "getRun"
  | "listRuns"
  | "listWorkflows"
  | "listApprovals"
  | "streamRunEvents"
  | "streamDevTools"
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
  decision: {
    approved: boolean;
    value?: unknown;
    note?: string;
  };
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
  };
};

export type GatewayWorkflowSummary = {
  key: string;
  readableName?: string;
  description?: string;
  hasUi: boolean;
  uiPath: string | null;
};

export type ListWorkflowsRequest = {
  filter?: {
    hasUi?: boolean;
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
  /** Provider id, one of the fixed `smithers agents` catalog. */
  provider:
    | "claude-code"
    | "antigravity"
    | "codex"
    | "gemini"
    | "kimi"
    | "anthropic-api"
    | "openai-api"
    | "gemini-api";
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

/** A doc kind stored in `_smithers_docs`; the tickets surface uses `ticket`. */
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

const stringSchema = (description: string): JsonSchema => ({ type: "string", description });
const booleanSchema = (description: string): JsonSchema => ({ type: "boolean", description });
const integerSchema = (description: string, minimum = 0): JsonSchema => ({
  type: "integer",
  minimum,
  description,
});
const objectSchema = (
  properties: Record<string, JsonSchema>,
  required: readonly string[] = [],
  description?: string,
  additionalProperties: boolean | JsonSchema = false,
): JsonSchema => ({
  type: "object",
  ...(description ? { description } : {}),
  properties,
  required,
  additionalProperties,
});
const arraySchema = (items: JsonSchema, description: string): JsonSchema => ({
  type: "array",
  description,
  items,
});

export const anyJsonSchema: JsonSchema = {
  // The branches are mutually exclusive so a value matches exactly one of them
  // under strict `oneOf` semantics. The `number` branch already covers integers
  // (an integer is a JSON number), so a separate `integer` branch would make
  // every integer match two branches and fail `oneOf` validation.
  description: "Any JSON value.",
  nullable: true,
  oneOf: [
    { type: "object", additionalProperties: true },
    { type: "array", items: { nullable: true } },
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
};

const runId = stringSchema("Stable run identifier.");
const workflow = stringSchema("Registered Gateway workflow key.");
const nodeId = stringSchema("Workflow node id.");
const iteration = integerSchema("Node iteration.", 0);
const afterSeq = integerSchema("Replay events with sequence numbers greater than this value.", 0);
const fromSeq = integerSchema("Legacy alias for afterSeq on DevTools streams.", 0);
const runSummary = objectSchema(
  {
    runId,
    workflowKey: workflow,
    status: stringSchema("Current run status."),
    createdAtMs: integerSchema("Unix epoch milliseconds.", 0),
  },
  ["runId", "status"],
  "Run summary view.",
  true,
);
const runStateView = objectSchema(
  {
    runId,
    state: stringSchema("Derived lifecycle state."),
    computedAt: stringSchema("ISO timestamp for when the view was computed."),
    blocked: objectSchema({}, [], "Optional blocked-run reason.", true),
    unhealthy: objectSchema({}, [], "Optional unhealthy-run reason.", true),
  },
  ["runId", "state", "computedAt"],
  "Derived RunStateView for the run.",
  true,
);
const runRecord = objectSchema(
  {
    runId,
    workflowKey: workflow,
    status: stringSchema("Persisted run status."),
    createdAtMs: integerSchema("Unix epoch milliseconds.", 0),
    startedAtMs: { ...integerSchema("Unix epoch milliseconds.", 0), nullable: true },
    finishedAtMs: { ...integerSchema("Unix epoch milliseconds.", 0), nullable: true },
    summary: objectSchema({}, [], "Counts keyed by persisted node state.", true),
    runState: runStateView,
  },
  ["runId"],
  "Current run record, including node-state counts and optional derived runState.",
  true,
);

export const GATEWAY_RPC_ERRORS: Record<GatewayRpcErrorCode, GatewayRpcErrorDefinition> = {
  InvalidRequest: { version: SMITHERS_API_VERSION, code: "InvalidRequest", httpStatus: 400, description: "The request shape is invalid." },
  InvalidInput: { version: SMITHERS_API_VERSION, code: "InvalidInput", httpStatus: 400, description: "The request input failed validation." },
  Unauthorized: { version: SMITHERS_API_VERSION, code: "Unauthorized", httpStatus: 401, description: "Authentication failed or the token expired." },
  Forbidden: { version: SMITHERS_API_VERSION, code: "Forbidden", httpStatus: 403, description: "The token is missing the required scope." },
  RunNotFound: { version: SMITHERS_API_VERSION, code: "RunNotFound", httpStatus: 404, description: "The run does not exist." },
  RUN_NOT_ACTIVE: { version: SMITHERS_API_VERSION, code: "RUN_NOT_ACTIVE", httpStatus: 409, description: "The run is not currently active and cannot be cancelled." },
  CronNotFound: { version: SMITHERS_API_VERSION, code: "CronNotFound", httpStatus: 404, description: "The cron schedule does not exist." },
  TicketNotFound: { version: SMITHERS_API_VERSION, code: "TicketNotFound", httpStatus: 404, description: "The ticket/work doc does not exist." },
  NodeNotFound: { version: SMITHERS_API_VERSION, code: "NodeNotFound", httpStatus: 404, description: "The node does not exist on the run." },
  IterationNotFound: { version: SMITHERS_API_VERSION, code: "IterationNotFound", httpStatus: 404, description: "The requested node iteration does not exist." },
  NodeHasNoOutput: { version: SMITHERS_API_VERSION, code: "NodeHasNoOutput", httpStatus: 404, description: "The node has not produced output." },
  FrameOutOfRange: { version: SMITHERS_API_VERSION, code: "FrameOutOfRange", httpStatus: 400, description: "The requested frame is outside the available range." },
  SeqOutOfRange: { version: SMITHERS_API_VERSION, code: "SeqOutOfRange", httpStatus: 400, description: "The requested stream sequence is in the future." },
  Busy: { version: SMITHERS_API_VERSION, code: "Busy", httpStatus: 409, description: "Another conflicting mutation is in progress." },
  AlreadyDecided: { version: SMITHERS_API_VERSION, code: "AlreadyDecided", httpStatus: 409, description: "The approval decision has already been submitted." },
  RateLimited: { version: SMITHERS_API_VERSION, code: "RateLimited", httpStatus: 429, description: "The caller exceeded a configured quota." },
  PayloadTooLarge: { version: SMITHERS_API_VERSION, code: "PayloadTooLarge", httpStatus: 413, description: "The response exceeds the configured payload limit." },
  BackpressureDisconnect: { version: SMITHERS_API_VERSION, code: "BackpressureDisconnect", httpStatus: 429, description: "A stream subscriber exceeded the bounded outbound queue." },
  UnsupportedSandbox: { version: SMITHERS_API_VERSION, code: "UnsupportedSandbox", httpStatus: 501, description: "A sandbox cannot be rewound safely." },
  VcsError: { version: SMITHERS_API_VERSION, code: "VcsError", httpStatus: 500, description: "A version-control operation failed." },
  RewindFailed: { version: SMITHERS_API_VERSION, code: "RewindFailed", httpStatus: 500, description: "The rewind failed and the run may need attention." },
  Internal: { version: SMITHERS_API_VERSION, code: "Internal", httpStatus: 500, description: "The Gateway encountered an internal error." },
};

export const GATEWAY_RPC_LEGACY_METHOD_ALIASES: Record<string, GatewayRpcMethod> = {
  "runs.create": "launchRun",
  "runs.get": "getRun",
  "runs.list": "listRuns",
  "runs.cancel": "cancelRun",
  "approvals.decide": "submitApproval",
  "signals.send": "submitSignal",
  jumpToFrame: "rewindRun",
  "devtools.jumpToFrame": "rewindRun",
  "devtools.getNodeOutput": "getNodeOutput",
  "devtools.getNodeDiff": "getNodeDiff",
  "cron.list": "cronList",
  "cron.add": "cronCreate",
  "cron.remove": "cronDelete",
  "cron.trigger": "cronRun",
};

export const GATEWAY_RPC_DEFINITIONS: readonly GatewayRpcDefinition[] = [
  {
    version: SMITHERS_API_VERSION,
    method: "launchRun",
    title: "Launch Run",
    description: "Start a registered workflow run.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "run:write",
    requestSchema: objectSchema({
      workflow,
      input: objectSchema({}, [], "Workflow input.", true),
      options: objectSchema({
        runId: stringSchema("Optional caller-supplied run id."),
        idempotencyKey: stringSchema("Optional caller idempotency key."),
      }, [], "Launch options."),
    }, ["workflow"]),
    responseSchema: objectSchema({ runId, workflow }, ["runId", "workflow"]),
    errors: ["InvalidRequest", "InvalidInput", "Unauthorized", "Forbidden", "Internal"],
    exampleRequest: { workflow: "deploy", input: { sha: "abc123" }, options: { runId: "deploy-abc123" } },
    exampleResponse: { runId: "deploy-abc123", workflow: "deploy" },
  },
  {
    version: SMITHERS_API_VERSION,
    method: "resumeRun",
    title: "Resume Run",
    description: "Resume a waiting or interrupted run.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "run:write",
    requestSchema: objectSchema({ runId, options: objectSchema({ force: booleanSchema("Force a resume attempt.") }) }, ["runId"]),
    responseSchema: objectSchema({ runId, status: { type: "string", enum: ["resume_requested", "already_terminal"] } }, ["runId", "status"]),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "Internal"],
    exampleRequest: { runId: "run_01", options: { force: false } },
    exampleResponse: { runId: "run_01", status: "resume_requested" },
  },
  {
    version: SMITHERS_API_VERSION,
    method: "cancelRun",
    title: "Cancel Run",
    description: "Cancel an active run.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "run:write",
    requestSchema: objectSchema({ runId }, ["runId"]),
    responseSchema: objectSchema({ runId, status: { type: "string", enum: ["cancelling"] } }, ["runId", "status"]),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RUN_NOT_ACTIVE", "Internal"],
    exampleRequest: { runId: "run_01" },
    exampleResponse: { runId: "run_01", status: "cancelling" },
  },
  {
    version: SMITHERS_API_VERSION,
    method: "hijackRun",
    title: "Hijack Run",
    description: "Create an elevated operator handoff session for a run.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "run:admin",
    requestSchema: objectSchema({ runId, options: objectSchema({}, [], "Hijack options.", true) }, ["runId"]),
    responseSchema: objectSchema({ runId, status: { type: "string", enum: ["hijack-ready"] }, sessionId: stringSchema("Hijack handoff session id.") }, ["runId", "status", "sessionId"]),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "Internal"],
    exampleRequest: { runId: "run_01", options: { reason: "operator takeover" } },
    exampleResponse: { runId: "run_01", status: "hijack-ready", sessionId: "hijack_01" },
  },
  {
    version: SMITHERS_API_VERSION,
    method: "rewindRun",
    title: "Rewind Run",
    description: "Rewind a run to a prior frame.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "run:admin",
    requestSchema: objectSchema({ runId, frameNo: integerSchema("Target frame number.", 0), confirm: { const: true, description: "Must be true." } }, ["runId", "frameNo", "confirm"]),
    responseSchema: objectSchema({}, [], "JumpResult payload.", true),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "FrameOutOfRange", "Busy", "RateLimited", "UnsupportedSandbox", "VcsError", "RewindFailed"],
    exampleRequest: { runId: "run_01", frameNo: 4, confirm: true },
    exampleResponse: { ok: true, newFrameNo: 4, revertedSandboxes: 0, deletedFrames: 2 },
  },
  {
    version: SMITHERS_API_VERSION,
    method: "submitApproval",
    title: "Submit Approval",
    description: "Submit an approval decision for a waiting approval node.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "approval:submit",
    requestSchema: objectSchema({
      runId,
      nodeId,
      iteration,
      decision: objectSchema({
        approved: booleanSchema("Whether the approval is granted."),
        value: anyJsonSchema,
        note: stringSchema("Optional decision note."),
      }, ["approved"]),
    }, ["runId", "nodeId", "decision"]),
    responseSchema: objectSchema({ runId, nodeId, iteration, approved: booleanSchema("Whether the approval was granted.") }, ["runId", "nodeId", "iteration", "approved"]),
    errors: ["InvalidRequest", "InvalidInput", "Unauthorized", "Forbidden", "RunNotFound", "AlreadyDecided", "Internal"],
    exampleRequest: { runId: "run_01", nodeId: "approve", decision: { approved: true, note: "ship it" } },
    exampleResponse: { runId: "run_01", nodeId: "approve", iteration: 0, approved: true },
  },
  {
    version: SMITHERS_API_VERSION,
    method: "submitSignal",
    title: "Submit Signal",
    description: "Deliver a signal payload to a waiting run.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "signal:submit",
    requestSchema: objectSchema({ runId, correlationKey: stringSchema("Signal correlation key."), signalName: stringSchema("Optional explicit signal name."), payload: anyJsonSchema }, ["runId", "correlationKey"]),
    responseSchema: objectSchema({}, [], "Signal delivery metadata.", true),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "Internal"],
    exampleRequest: { runId: "run_01", correlationKey: "issue-42", signalName: "github.comment.created", payload: { body: "ready" } },
    exampleResponse: { runId: "run_01", signalName: "github.comment.created", correlationId: "issue-42", seq: 1 },
  },
  {
    version: SMITHERS_API_VERSION,
    method: "getRun",
    title: "Get Run",
    description: "Fetch one run record with node-state counts and optional derived runState.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "run:read",
    requestSchema: objectSchema({ runId }, ["runId"]),
    responseSchema: runRecord,
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "Internal"],
    exampleRequest: { runId: "run_01" },
    exampleResponse: {
      runId: "run_01",
      status: "finished",
      workflowKey: "deploy",
      summary: { finished: 3 },
      runState: { runId: "run_01", state: "succeeded", computedAt: "2026-01-01T00:00:00.000Z" },
    },
  },
  {
    version: SMITHERS_API_VERSION,
    method: "listRuns",
    title: "List Runs",
    description: "List recent runs matching an optional filter.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "run:read",
    requestSchema: objectSchema({ filter: objectSchema({ status: stringSchema("Optional run status filter."), limit: integerSchema("Maximum number of runs.", 1) }) }),
    responseSchema: arraySchema(runSummary, "Run summaries."),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "Internal"],
    exampleRequest: { filter: { status: "finished", limit: 20 } },
    exampleResponse: [{ runId: "run_01", workflowKey: "deploy", status: "finished", createdAtMs: 1710000000000 }],
  },
  {
    version: SMITHERS_API_VERSION,
    method: "listWorkflows",
    title: "List Workflows",
    description: "List workflows registered with the Gateway.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "run:read",
    requestSchema: objectSchema({
      filter: objectSchema({
        hasUi: booleanSchema("Only return workflows with or without an attached UI."),
      }),
    }),
    responseSchema: arraySchema(objectSchema({
      key: workflow,
      readableName: stringSchema("Human-readable workflow name."),
      description: stringSchema("Workflow description."),
      hasUi: booleanSchema("Whether this workflow has a custom UI mounted."),
      uiPath: { type: ["string", "null"], description: "Mounted UI path when present." },
    }, ["key", "hasUi", "uiPath"]), "Registered workflow summaries."),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "Internal"],
    exampleRequest: { filter: { hasUi: true } },
    exampleResponse: [{ key: "deploy", readableName: "Deploy", hasUi: true, uiPath: "/workflows/deploy" }],
  },
  {
    version: SMITHERS_API_VERSION,
    method: "listApprovals",
    title: "List Approvals",
    description: "List pending Gateway approval requests.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "run:read",
    requestSchema: objectSchema({
      filter: objectSchema({
        runId,
        workflow: stringSchema("Registered Gateway workflow key."),
        limit: integerSchema("Maximum number of approvals.", 1),
      }),
    }),
    responseSchema: arraySchema(objectSchema({}, [], "Pending approval summary.", true), "Pending approvals."),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "Internal"],
    exampleRequest: { filter: { workflow: "deploy", limit: 20 } },
    exampleResponse: [{ runId: "run_01", workflowKey: "deploy", nodeId: "approve", iteration: 0, requestTitle: "Approve deploy", requestedAtMs: 1710000000000 }],
  },
  {
    version: SMITHERS_API_VERSION,
    method: "streamRunEvents",
    title: "Stream Run Events",
    description: "Subscribe to a run event stream with bounded replay and GapResync semantics.",
    maturity: "stable",
    transport: "websocket",
    requiredScope: "run:read",
    requestSchema: objectSchema({ runId, afterSeq }, ["runId"]),
    responseSchema: objectSchema({ streamId: stringSchema("Stream id."), runId, afterSeq: { type: ["integer", "null"] }, currentSeq: integerSchema("Current per-run event sequence.", 0) }, ["streamId", "runId", "afterSeq", "currentSeq"]),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "SeqOutOfRange", "Internal"],
    exampleRequest: { runId: "run_01", afterSeq: 41 },
    exampleResponse: { streamId: "stream_01", runId: "run_01", afterSeq: 41, currentSeq: 45 },
  },
  {
    version: SMITHERS_API_VERSION,
    method: "streamDevTools",
    title: "Stream DevTools",
    description: "Subscribe to the DevTools snapshot and delta stream.",
    maturity: "stable",
    transport: "websocket",
    requiredScope: "observability:read",
    requestSchema: objectSchema({ runId, afterSeq, fromSeq }, ["runId"]),
    responseSchema: objectSchema({
      streamId: stringSchema("Stream id."),
      runId,
      fromSeq: { type: ["integer", "null"] },
      afterSeq: { type: ["integer", "null"] },
    }, ["streamId", "runId", "fromSeq", "afterSeq"]),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "SeqOutOfRange", "BackpressureDisconnect", "Internal"],
    exampleRequest: { runId: "run_01", afterSeq: 10 },
    exampleResponse: { streamId: "stream_01", runId: "run_01", fromSeq: 10, afterSeq: 10 },
  },
  {
    version: SMITHERS_API_VERSION,
    method: "getNodeOutput",
    title: "Get Node Output",
    description: "Fetch a task node output payload.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "run:read",
    requestSchema: objectSchema({ runId, nodeId, iteration }, ["runId", "nodeId"]),
    responseSchema: objectSchema({}, [], "NodeOutputResponse.", true),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "NodeNotFound", "IterationNotFound", "NodeHasNoOutput", "PayloadTooLarge", "Internal"],
    exampleRequest: { runId: "run_01", nodeId: "task", iteration: 0 },
    exampleResponse: { status: "produced", row: { value: 1 }, schema: null },
  },
  {
    version: SMITHERS_API_VERSION,
    method: "getNodeDiff",
    title: "Get Node Diff",
    description: "Fetch a node-level diff bundle for one iteration.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "run:read",
    requestSchema: objectSchema({ runId, nodeId, iteration }, ["runId", "nodeId"]),
    responseSchema: objectSchema({}, [], "Node diff response.", true),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "NodeNotFound", "IterationNotFound", "PayloadTooLarge", "VcsError", "Internal"],
    exampleRequest: { runId: "run_01", nodeId: "task", iteration: 0 },
    exampleResponse: { summary: { filesChanged: 1 }, files: [] },
  },
  {
    version: SMITHERS_API_VERSION,
    method: "cronList",
    title: "Cron List",
    description: "List Gateway cron schedules.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "cron:read",
    requestSchema: objectSchema({ filter: objectSchema({ workflow: stringSchema("Workflow key.") }) }),
    responseSchema: arraySchema(objectSchema({}, [], "Cron row.", true), "Cron rows."),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "Internal"],
    exampleRequest: { filter: { workflow: "deploy" } },
    exampleResponse: [{ cronId: "cron_01", workflow: "deploy", pattern: "0 8 * * 1-5" }],
  },
  {
    version: SMITHERS_API_VERSION,
    method: "cronCreate",
    title: "Cron Create",
    description: "Create or replace a Gateway cron schedule.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "cron:write",
    requestSchema: objectSchema({ workflow, pattern: stringSchema("Cron expression."), cronId: stringSchema("Optional cron id."), enabled: booleanSchema("Whether the schedule is enabled.") }, ["workflow", "pattern"]),
    responseSchema: objectSchema({}, [], "Created cron row.", true),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "Internal"],
    exampleRequest: { workflow: "deploy", pattern: "0 8 * * 1-5" },
    exampleResponse: { cronId: "cron_01", workflow: "deploy", pattern: "0 8 * * 1-5", enabled: true },
  },
  {
    version: SMITHERS_API_VERSION,
    method: "cronDelete",
    title: "Cron Delete",
    description: "Delete a Gateway cron schedule.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "cron:write",
    requestSchema: objectSchema({ cronId: stringSchema("Cron id.") }, ["cronId"]),
    responseSchema: objectSchema({ cronId: stringSchema("Cron id."), removed: booleanSchema("True when removed.") }, ["cronId", "removed"]),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "CronNotFound", "Internal"],
    exampleRequest: { cronId: "cron_01" },
    exampleResponse: { cronId: "cron_01", removed: true },
  },
  {
    version: SMITHERS_API_VERSION,
    method: "cronRun",
    title: "Cron Run",
    description: "Trigger a cron schedule or workflow immediately.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "cron:write",
    requestSchema: objectSchema({ cronId: stringSchema("Cron id."), workflow, input: objectSchema({}, [], "Workflow input.", true) }),
    responseSchema: objectSchema({ runId, workflow }, ["runId", "workflow"]),
    errors: ["InvalidRequest", "InvalidInput", "Unauthorized", "Forbidden", "CronNotFound", "Internal"],
    exampleRequest: { cronId: "cron_01", input: { dryRun: true } },
    exampleResponse: { runId: "run_02", workflow: "deploy" },
  },
  {
    version: SMITHERS_API_VERSION,
    method: "listAccounts",
    title: "List Accounts",
    description: "List the registered Smithers agent accounts — the entries in the user-level `~/.smithers/accounts.json` registry that the `smithers agents` CLI manages. Each account's raw API key is redacted; `hasApiKey`/`hasConfigDir` report its auth posture instead.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "account:read",
    requestSchema: objectSchema({}),
    responseSchema: arraySchema(objectSchema({
      label: stringSchema("Unique account label (the registry key)."),
      provider: {
        type: "string",
        enum: ["claude-code", "antigravity", "codex", "gemini", "kimi", "anthropic-api", "openai-api", "gemini-api"],
        description: "Provider id, one of the fixed `smithers agents` catalog.",
      },
      configDir: { type: ["string", "null"], description: "Per-account CLI config dir for subscription providers (null for api-key accounts)." },
      hasConfigDir: booleanSchema("True when a subscription account has a non-empty config dir."),
      hasApiKey: booleanSchema("True when an api-key account carries a non-empty key (the key itself is never returned)."),
      model: { type: ["string", "null"], description: "Optional default model baked into the account." },
      addedAt: { type: ["string", "null"], description: "ISO timestamp of when the account was added, when known." },
    }, ["label", "provider", "hasConfigDir", "hasApiKey"]), "Registered agent accounts."),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "Internal"],
    exampleRequest: {},
    exampleResponse: [{ label: "claude-work", provider: "claude-code", configDir: "/Users/me/.claude", hasConfigDir: true, hasApiKey: false, model: "claude-opus-4-8", addedAt: "2026-01-01T00:00:00.000Z" }],
  },
  {
    version: SMITHERS_API_VERSION,
    method: "listMemoryFacts",
    title: "List Memory Facts",
    description: "List cross-run memory facts, optionally scoped to a namespace.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "memory:read",
    requestSchema: objectSchema({ namespace: stringSchema("Optional namespace filter (e.g. 'workflow:deploy').") }),
    responseSchema: arraySchema(objectSchema({
      namespace: stringSchema("Fact namespace."),
      key: stringSchema("Fact key (unique within the namespace)."),
      valueJson: stringSchema("Stored value as a JSON string."),
      schemaSig: { type: ["string", "null"], description: "Optional value-schema signature." },
      createdAtMs: integerSchema("Unix epoch milliseconds when first written.", 0),
      updatedAtMs: integerSchema("Unix epoch milliseconds when last written.", 0),
      ttlMs: { type: ["integer", "null"], description: "Time-to-live in milliseconds, or null when the fact does not expire." },
    }, ["namespace", "key", "valueJson", "createdAtMs", "updatedAtMs"]), "Memory facts."),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "Internal"],
    exampleRequest: { namespace: "workflow:deploy" },
    exampleResponse: [{ namespace: "workflow:deploy", key: "last-sha", valueJson: "\"abc123\"", createdAtMs: 1710000000000, updatedAtMs: 1710000000000 }],
  },
  {
    version: SMITHERS_API_VERSION,
    method: "listPrompts",
    title: "List Prompts",
    description: "List registered prompts — the `.md`/`.mdx` files under the project's `.smithers/prompts/` directory, each returned with its source.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "prompt:read",
    requestSchema: objectSchema({}),
    responseSchema: arraySchema(objectSchema({
      id: stringSchema("Prompt id — the relative path under `.smithers/prompts/` without its extension (e.g. 'refactor')."),
      entryFile: stringSchema("Workspace-relative source path (e.g. 'prompts/refactor.mdx')."),
      source: stringSchema("Raw prompt file text."),
      createdAtMs: integerSchema("Unix epoch milliseconds the file was created (fs birthtime).", 0),
      updatedAtMs: integerSchema("Unix epoch milliseconds the file was last modified (fs mtime).", 0),
    }, ["id", "entryFile", "source"]), "Registered prompts."),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "Internal"],
    exampleRequest: {},
    exampleResponse: [{ id: "refactor", entryFile: "prompts/refactor.mdx", source: "# Refactor\n\nRefactor {{file}}.", createdAtMs: 1710000000000, updatedAtMs: 1710000000000 }],
  },
  {
    version: SMITHERS_API_VERSION,
    method: "listScores",
    title: "List Scores",
    description: "List scorer/eval results for one run, optionally scoped to a node.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "score:read",
    requestSchema: objectSchema({
      runId: stringSchema("Run id whose scorer results to list."),
      nodeId: stringSchema("Optional node id filter."),
    }, ["runId"]),
    responseSchema: arraySchema(objectSchema({
      runId: stringSchema("Run id the score belongs to."),
      nodeId: stringSchema("Node id the score was produced for."),
      iteration: integerSchema("Node iteration the score belongs to.", 0),
      attempt: integerSchema("Node attempt the score belongs to.", 0),
      scorerId: stringSchema("Stable scorer id."),
      scorerName: stringSchema("Human scorer name."),
      source: stringSchema("Where the score came from (e.g. 'scorer', 'eval')."),
      score: { type: "number", description: "The scorer's numeric verdict." },
      reason: { type: ["string", "null"], description: "Optional human reason for the score." },
      scoredAtMs: integerSchema("Unix epoch milliseconds when the score was recorded.", 0),
      latencyMs: { type: ["number", "null"], description: "Optional scorer latency in milliseconds." },
      durationMs: { type: ["number", "null"], description: "Optional node duration in milliseconds." },
    }, ["runId", "nodeId", "iteration", "attempt", "scorerId", "scorerName", "source", "score", "scoredAtMs"]), "Scorer results."),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "Internal"],
    exampleRequest: { runId: "run_01", nodeId: "review" },
    exampleResponse: [{ runId: "run_01", nodeId: "review", iteration: 0, attempt: 0, scorerId: "correctness", scorerName: "correctness", source: "scorer", score: 0.92, scoredAtMs: 1710000000000 }],
  },
  {
    version: SMITHERS_API_VERSION,
    method: "listTickets",
    title: "List Tickets",
    description: "List live work docs (tickets/plans/specs/proposals) from `_smithers_docs`; soft-deleted tombstones are never returned.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "ticket:read",
    requestSchema: objectSchema({
      kind: { type: "string", enum: ["ticket", "plan", "spec", "proposal"], description: "Optional doc-kind filter; omit to list every kind." },
    }),
    responseSchema: arraySchema(objectSchema({
      path: stringSchema("Doc identity (primary key); e.g. a ticket id."),
      kind: { type: "string", enum: ["ticket", "plan", "spec", "proposal"], description: "Doc kind." },
      content: stringSchema("Full markdown body."),
      contentHash: stringSchema("sha256(content), lowercase hex."),
      status: { type: ["string", "null"], description: "Free-form status (e.g. todo/in-progress/done); rides the row so it survives reload." },
      updatedAtMs: integerSchema("Unix epoch milliseconds of the last write.", 0),
    }, ["path", "kind", "content", "contentHash", "updatedAtMs"]), "Live work docs."),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "Internal"],
    exampleRequest: { kind: "ticket" },
    exampleResponse: [{ path: "feat-issues-card", kind: "ticket", content: "# Issues card", contentHash: "0000000000000000000000000000000000000000000000000000000000000000", status: "in-progress", updatedAtMs: 1710000000000 }],
  },
  {
    version: SMITHERS_API_VERSION,
    method: "createTicket",
    title: "Create Ticket",
    description: "Create or replace a work doc by `path`. Stamps `content_hash = sha256(content)` and `updated_at_ms = now`; reviving a previously soft-deleted path is intentional.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "ticket:write",
    requestSchema: objectSchema({
      path: stringSchema("Doc identity (primary key); e.g. `feat-issues-card`."),
      content: stringSchema("Full markdown body."),
      kind: { type: "string", enum: ["ticket", "plan", "spec", "proposal"], description: "Doc kind (default `ticket`)." },
      status: stringSchema("Optional initial status."),
    }, ["path", "content"]),
    responseSchema: objectSchema({
      path: stringSchema("Doc identity (primary key)."),
      kind: { type: "string", enum: ["ticket", "plan", "spec", "proposal"], description: "Doc kind." },
      content: stringSchema("Full markdown body."),
      contentHash: stringSchema("sha256(content), lowercase hex."),
      status: { type: ["string", "null"], description: "Free-form status." },
      updatedAtMs: integerSchema("Unix epoch milliseconds of the write.", 0),
    }, ["path", "kind", "content", "contentHash", "updatedAtMs"], "The created doc row."),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "Internal"],
    exampleRequest: { path: "feat-issues-card", content: "# Issues card", kind: "ticket", status: "todo" },
    exampleResponse: { path: "feat-issues-card", kind: "ticket", content: "# Issues card", contentHash: "0000000000000000000000000000000000000000000000000000000000000000", status: "todo", updatedAtMs: 1710000000000 },
  },
  {
    version: SMITHERS_API_VERSION,
    method: "updateTicket",
    title: "Update Ticket",
    description: "Patch a work doc's `content` and/or `status` by `path`. Re-stamps `content_hash` + `updated_at_ms` when content changes.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "ticket:write",
    requestSchema: objectSchema({
      path: stringSchema("Doc identity (primary key)."),
      content: stringSchema("Optional new markdown body."),
      status: stringSchema("Optional new status."),
    }, ["path"]),
    responseSchema: objectSchema({
      path: stringSchema("Doc identity (primary key)."),
      kind: { type: "string", enum: ["ticket", "plan", "spec", "proposal"], description: "Doc kind." },
      content: stringSchema("Full markdown body."),
      contentHash: stringSchema("sha256(content), lowercase hex."),
      status: { type: ["string", "null"], description: "Free-form status." },
      updatedAtMs: integerSchema("Unix epoch milliseconds of the write.", 0),
    }, ["path", "kind", "content", "contentHash", "updatedAtMs"], "The updated doc row."),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "TicketNotFound", "Internal"],
    exampleRequest: { path: "feat-issues-card", status: "in-progress" },
    exampleResponse: { path: "feat-issues-card", kind: "ticket", content: "# Issues card", contentHash: "0000000000000000000000000000000000000000000000000000000000000000", status: "in-progress", updatedAtMs: 1710000000000 },
  },
  {
    version: SMITHERS_API_VERSION,
    method: "deleteTicket",
    title: "Delete Ticket",
    description: "Soft-delete a work doc by `path` (stamps a `deleted_at_ms` tombstone). The row survives so `listTickets` hides it without losing history; the watcher never materializes a tombstone to disk.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "ticket:write",
    requestSchema: objectSchema({ path: stringSchema("Doc identity (primary key).") }, ["path"]),
    responseSchema: objectSchema({
      path: stringSchema("Doc identity (primary key)."),
      deleted: booleanSchema("True when the doc was soft-deleted."),
    }, ["path", "deleted"], "Soft-delete acknowledgement."),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "TicketNotFound", "Internal"],
    exampleRequest: { path: "feat-issues-card" },
    exampleResponse: { path: "feat-issues-card", deleted: true },
  },
] as const;

const definitionByMethod = new Map<string, GatewayRpcDefinition>(
  GATEWAY_RPC_DEFINITIONS.map((definition) => [definition.method, definition]),
);

export function canonicalGatewayRpcMethod(method: string): GatewayRpcMethod | undefined {
  if (definitionByMethod.has(method)) {
    return method as GatewayRpcMethod;
  }
  return GATEWAY_RPC_LEGACY_METHOD_ALIASES[method];
}

export function getGatewayRpcDefinition(method: string): GatewayRpcDefinition | undefined {
  const canonical = canonicalGatewayRpcMethod(method);
  return canonical ? definitionByMethod.get(canonical) : undefined;
}

export function getRequiredScopeForGatewayMethod(method: string): GatewayScope | undefined {
  if (method === "health") {
    return "run:read";
  }
  if (method === "approvals.list") {
    return "run:read";
  }
  if (method === "workflows.list") {
    return "run:read";
  }
  if (method === "runs.diff" || method === "frames.list" || method === "frames.get" || method === "attempts.list" || method === "attempts.get") {
    return "run:read";
  }
  if (method === "getDevToolsSnapshot") {
    return "observability:read";
  }
  if (method === "runs.rerun") {
    return "run:write";
  }
  if (method === "approve") {
    return "approval:submit";
  }
  const definition = getGatewayRpcDefinition(method);
  return definition?.requiredScope;
}

export function listGatewayRpcMethods(): readonly GatewayRpcMethod[] {
  return GATEWAY_RPC_DEFINITIONS.map((definition) => definition.method);
}

export function isGatewayRpcMethod(method: string): method is GatewayRpcMethod {
  return definitionByMethod.has(method);
}

export function getGatewayScopeValues(): readonly GatewayScope[] {
  return GATEWAY_SCOPE_VALUES;
}
