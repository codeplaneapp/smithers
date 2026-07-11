// @smithers-type-exports-begin
/** @typedef {import("./gatewayRpcTypes.ts").SmithersApiVersion} SmithersApiVersion */
/** @typedef {import("./gatewayRpcTypes.ts").JsonSchema} JsonSchema */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayRpcErrorCode} GatewayRpcErrorCode */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayRpcErrorDefinition} GatewayRpcErrorDefinition */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayRpcDefinition} GatewayRpcDefinition */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayRpcMethod} GatewayRpcMethod */
/** @typedef {import("./gatewayRpcTypes.ts").LaunchRunRequest} LaunchRunRequest */
/** @typedef {import("./gatewayRpcTypes.ts").LaunchRunResponse} LaunchRunResponse */
/** @typedef {import("./gatewayRpcTypes.ts").ResumeRunRequest} ResumeRunRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ResumeRunResponse} ResumeRunResponse */
/** @typedef {import("./gatewayRpcTypes.ts").CancelRunRequest} CancelRunRequest */
/** @typedef {import("./gatewayRpcTypes.ts").CancelRunResponse} CancelRunResponse */
/** @typedef {import("./gatewayRpcTypes.ts").PauseRunRequest} PauseRunRequest */
/** @typedef {import("./gatewayRpcTypes.ts").PauseRunResponse} PauseRunResponse */
/** @typedef {import("./gatewayRpcTypes.ts").HijackRunRequest} HijackRunRequest */
/** @typedef {import("./gatewayRpcTypes.ts").HijackRunResponse} HijackRunResponse */
/** @typedef {import("./gatewayRpcTypes.ts").RewindRunRequest} RewindRunRequest */
/** @typedef {import("./gatewayRpcTypes.ts").SubmitApprovalRequest} SubmitApprovalRequest */
/** @typedef {import("./gatewayRpcTypes.ts").SubmitApprovalResponse} SubmitApprovalResponse */
/** @typedef {import("./gatewayRpcTypes.ts").SubmitSignalRequest} SubmitSignalRequest */
/** @typedef {import("./gatewayRpcTypes.ts").GetRunRequest} GetRunRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListRunsRequest} ListRunsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").GetSchemaSignatureRequest} GetSchemaSignatureRequest */
/** @typedef {import("./gatewayRpcTypes.ts").GetSchemaSignatureResponse} GetSchemaSignatureResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayWorkflowSummary} GatewayWorkflowSummary */
/** @typedef {import("./gatewayRpcTypes.ts").ListWorkflowsRequest} ListWorkflowsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListWorkflowsResponse} ListWorkflowsResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayApprovalSummary} GatewayApprovalSummary */
/** @typedef {import("./gatewayRpcTypes.ts").ListApprovalsRequest} ListApprovalsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListApprovalsResponse} ListApprovalsResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayDocRow} GatewayDocRow */
/** @typedef {import("./gatewayRpcTypes.ts").ListDocsRequest} ListDocsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListDocsResponse} ListDocsResponse */
/** @typedef {import("./gatewayRpcTypes.ts").StreamRunEventsRequest} StreamRunEventsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").StreamRunEventsResponse} StreamRunEventsResponse */
/** @typedef {import("./gatewayRpcTypes.ts").StreamDevToolsRequest} StreamDevToolsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").GetDevToolsSnapshotRequest} GetDevToolsSnapshotRequest */
/** @typedef {import("./gatewayRpcTypes.ts").GetDevToolsSnapshotResponse} GetDevToolsSnapshotResponse */
/** @typedef {import("./gatewayRpcTypes.ts").NodeRequest} NodeRequest */
/** @typedef {import("./gatewayRpcTypes.ts").WhatHappenedRequest} WhatHappenedRequest */
/** @typedef {import("./gatewayRpcTypes.ts").WhatHappenedResponse} WhatHappenedResponse */
/** @typedef {import("./gatewayRpcTypes.ts").CronListRequest} CronListRequest */
/** @typedef {import("./gatewayRpcTypes.ts").CronCreateRequest} CronCreateRequest */
/** @typedef {import("./gatewayRpcTypes.ts").CronDeleteRequest} CronDeleteRequest */
/** @typedef {import("./gatewayRpcTypes.ts").CronRunRequest} CronRunRequest */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayAccount} GatewayAccount */
/** @typedef {import("./gatewayRpcTypes.ts").ListAccountsRequest} ListAccountsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListAccountsResponse} ListAccountsResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayMemoryFact} GatewayMemoryFact */
/** @typedef {import("./gatewayRpcTypes.ts").ListMemoryFactsRequest} ListMemoryFactsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListMemoryFactsResponse} ListMemoryFactsResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayPrompt} GatewayPrompt */
/** @typedef {import("./gatewayRpcTypes.ts").ListPromptsRequest} ListPromptsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListPromptsResponse} ListPromptsResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayScoreRow} GatewayScoreRow */
/** @typedef {import("./gatewayRpcTypes.ts").ListScoresRequest} ListScoresRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListScoresResponse} ListScoresResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayDocKind} GatewayDocKind */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayTicketRow} GatewayTicketRow */
/** @typedef {import("./gatewayRpcTypes.ts").ListTicketsRequest} ListTicketsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListTicketsResponse} ListTicketsResponse */
/** @typedef {import("./gatewayRpcTypes.ts").CreateTicketRequest} CreateTicketRequest */
/** @typedef {import("./gatewayRpcTypes.ts").UpdateTicketRequest} UpdateTicketRequest */
/** @typedef {import("./gatewayRpcTypes.ts").DeleteTicketRequest} DeleteTicketRequest */
// @smithers-type-exports-end
/** @typedef {import("../auth/scopes.js").GatewayScope} GatewayScope */

import { GATEWAY_SCOPE_VALUES } from "../auth/scopes.js";

export const SMITHERS_API_VERSION = /** @type {SmithersApiVersion} */ ("v1");
// Default `eventWindowSize` for the server: how many per-run events are retained
// for streamRunEvents bounded replay. A subscriber reconnecting from further back
// than this window gets GapResync semantics instead of a replay.
export const GATEWAY_EVENT_WINDOW_DEFAULT = 10_000;

// The fixed `smithers agents` provider catalog. The GatewayAccount["provider"]
// union and the listAccounts schema enum both derive from this so they cannot drift.
/** @type {readonly GatewayAccount["provider"][]} */
const ACCOUNT_PROVIDERS = ["claude-code", "antigravity", "codex", "gemini", "kimi", "anthropic-api", "openai-api", "gemini-api"];

// The closed set of work-doc kinds in `_smithers_docs`. The GatewayDocKind
// union and every ticket-RPC schema enum derive from this so they cannot drift.
/** @type {readonly GatewayDocKind[]} */
const DOC_KINDS = ["ticket", "plan", "spec", "proposal"];

/**
 * @param {string} description
 * @returns {JsonSchema}
 */
const stringSchema = (description) => ({ type: "string", description });
/**
 * @param {string} description
 * @returns {JsonSchema}
 */
const booleanSchema = (description) => ({ type: "boolean", description });
/**
 * @param {string} description
 * @param {number} [minimum]
 * @returns {JsonSchema}
 */
const integerSchema = (description, minimum = 0) => ({
  type: "integer",
  minimum,
  description,
});
/**
 * @param {Record<string, JsonSchema>} properties
 * @param {readonly string[]} [required]
 * @param {string} [description]
 * @param {boolean | JsonSchema} [additionalProperties]
 * @returns {JsonSchema}
 */
const objectSchema = (
  properties,
  required = [],
  description,
  additionalProperties = false,
) => ({
  type: "object",
  ...(description ? { description } : {}),
  properties,
  required,
  additionalProperties,
});
/**
 * @param {JsonSchema} items
 * @param {string} description
 * @returns {JsonSchema}
 */
const arraySchema = (items, description) => ({
  type: "array",
  description,
  items,
});

/** @type {JsonSchema} */
export const anyJsonSchema = {
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

/** @type {Record<GatewayRpcErrorCode, GatewayRpcErrorDefinition>} */
export const GATEWAY_RPC_ERRORS = {
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

/** @type {Record<string, GatewayRpcMethod>} */
export const GATEWAY_RPC_LEGACY_METHOD_ALIASES = {
  "runs.create": "launchRun",
  "runs.get": "getRun",
  "runs.list": "listRuns",
  "runs.cancel": "cancelRun",
  "runs.pause": "pauseRun",
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

// packages/server HTTP/legacy routes with no GATEWAY_RPC_DEFINITIONS entry, kept
// here so scope enforcement (auth/scopes.js methodGrantSatisfiesRequiredScope)
// and the OpenAPI generator share one source of truth for required scopes.
/** @type {Record<string, GatewayScope>} */
const HTTP_ROUTE_SCOPES = {
  health: "run:read",
  "approvals.list": "run:read",
  "workflows.list": "run:read",
  "runs.diff": "run:read",
  listNodeStates: "run:read",
  retryTask: "run:write",
  "frames.list": "run:read",
  "frames.get": "run:read",
  "attempts.list": "run:read",
  "attempts.get": "run:read",
  "runs.rerun": "run:write",
  approve: "approval:submit",
};

/** @type {readonly GatewayRpcDefinition[]} */
export const GATEWAY_RPC_DEFINITIONS = [
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
        maxConcurrency: integerSchema("Maximum parallel workflow tasks.", 1),
        allowNetwork: booleanSchema("Allow network access for workflow tools."),
        maxOutputBytes: integerSchema("Maximum captured output bytes per tool/process.", 1),
        toolTimeoutMs: integerSchema("Maximum wall-clock time per tool call in milliseconds.", 1),
      }, [], "Launch options."),
    }, ["workflow"]),
    responseSchema: objectSchema({ runId, workflow }, ["runId", "workflow"]),
    errors: ["InvalidRequest", "InvalidInput", "Unauthorized", "Forbidden", "Internal"],
    exampleRequest: { workflow: "deploy", input: { sha: "abc123" }, options: { runId: "deploy-abc123", allowNetwork: true } },
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
    method: "pauseRun",
    title: "Pause Run",
    description: "Gracefully pause an active run: stop scheduling new tasks, let in-flight tasks finish, then park it resumably.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "run:write",
    requestSchema: objectSchema({ runId }, ["runId"]),
    responseSchema: objectSchema({ runId, status: { type: "string", enum: ["pausing"] } }, ["runId", "status"]),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "RUN_NOT_ACTIVE", "Internal"],
    exampleRequest: { runId: "run_01" },
    exampleResponse: { runId: "run_01", status: "pausing" },
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
      approved: booleanSchema("Whether the approval is granted."),
      decision: objectSchema({
        approved: booleanSchema("Whether the approval is granted."),
        value: anyJsonSchema,
        note: stringSchema("Optional decision note."),
      }, [], "Approval decision payload.", true),
    }, ["runId", "nodeId", "decision"]),
    responseSchema: objectSchema({ runId, nodeId, iteration, approved: booleanSchema("Whether the approval was granted.") }, ["runId", "nodeId", "iteration", "approved"]),
    errors: ["InvalidRequest", "InvalidInput", "Unauthorized", "Forbidden", "RunNotFound", "AlreadyDecided", "Internal"],
    exampleRequest: { runId: "run_01", nodeId: "approve", approved: true, decision: { note: "ship it" } },
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
    requestSchema: objectSchema({ filter: objectSchema({ status: stringSchema("Optional run status filter."), limit: integerSchema("Maximum number of runs.", 1), workflow: stringSchema("Optional workflow key filter.") }) }),
    responseSchema: arraySchema(runSummary, "Run summaries."),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "Internal"],
    exampleRequest: { filter: { status: "finished", limit: 20, workflow: "deploy" } },
    exampleResponse: [{ runId: "run_01", workflowKey: "deploy", status: "finished", createdAtMs: 1710000000000 }],
  },
  {
    version: SMITHERS_API_VERSION,
    method: "getSchemaSignature",
    title: "Get Schema Signature",
    description: "Return the server Smithers schema migration head and table-catalog signature used by client persistence.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "run:read",
    requestSchema: objectSchema({}),
    responseSchema: objectSchema({
      schemaVersion: stringSchema("Current _smithers_schema_migrations head id."),
      signature: stringSchema("Stable hash of the server schema catalog."),
      components: objectSchema({}, [], "Per-table schema component hashes.", true),
    }, ["schemaVersion", "signature"]),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "Internal"],
    exampleRequest: {},
    exampleResponse: { schemaVersion: "0016", signature: "sha256" },
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
        includeSystem: booleanSchema("Include system (internal plumbing) workflows; they are excluded by default."),
      }),
    }),
    responseSchema: arraySchema(objectSchema({
      key: workflow,
      readableName: stringSchema("Human-readable workflow name."),
      description: stringSchema("Workflow description."),
      hasUi: booleanSchema("Whether this workflow has a custom UI mounted."),
      uiPath: { type: ["string", "null"], description: "Mounted UI path when present." },
      system: booleanSchema("Whether this is a system (internal plumbing) workflow hidden from default listings."),
    }, ["key", "hasUi", "uiPath"]), "Registered workflow summaries."),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "Internal"],
    exampleRequest: { filter: { hasUi: true } },
    exampleResponse: [{ key: "deploy", readableName: "Deploy", hasUi: true, uiPath: "/workflows/deploy", system: false }],
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
    method: "listDocs",
    title: "List Docs",
    description: "List DB-backed Smithers markdown artifacts for tickets, plans, specs, proposals, and conflict markers.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "run:read",
    requestSchema: objectSchema({
      filter: objectSchema({
        kind: stringSchema("Optional doc kind filter."),
        includeDeleted: booleanSchema("Include tombstone rows."),
        updatedAfterMs: integerSchema("Only return docs updated after this millisecond timestamp.", 0),
        limit: integerSchema("Maximum number of docs.", 1),
      }),
    }),
    responseSchema: arraySchema(objectSchema({
      path: stringSchema("Path relative to .smithers, e.g. tickets/smithers/0030.md."),
      kind: stringSchema("ticket, plan, spec, proposal, or conflict."),
      content: stringSchema("Markdown or conflict marker content."),
      contentHash: stringSchema("SHA-256 hash of content."),
      updatedAtMs: integerSchema("Last DB update time in milliseconds.", 0),
      deletedAtMs: { type: ["integer", "null"], description: "Tombstone timestamp when deleted." },
    }, ["path", "kind", "content", "contentHash", "updatedAtMs"]), "Smithers docs rows."),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "Internal"],
    exampleRequest: { filter: { kind: "ticket", limit: 100 } },
    exampleResponse: [{ path: "tickets/smithers/0030-jjhub-sse-seam.md", kind: "ticket", content: "# Ticket", contentHash: "sha256", updatedAtMs: 1710000000000, deletedAtMs: null }],
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
    method: "getDevToolsSnapshot",
    title: "Get DevTools Snapshot",
    description: "Fetch a DevTools snapshot tree for a run, optionally pinned to a frame number.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "observability:read",
    requestSchema: objectSchema({ runId, frameNo: integerSchema("Target frame number.", 0) }, ["runId"]),
    responseSchema: objectSchema({}, [], "DevTools snapshot payload.", true),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "FrameOutOfRange", "PayloadTooLarge", "Internal"],
    exampleRequest: { runId: "run_01", frameNo: 4 },
    exampleResponse: {
      version: 1,
      runId: "run_01",
      frameNo: 4,
      seq: 18,
      root: { id: 0, type: "workflow", name: "deploy", props: {}, children: [], depth: 0 },
    },
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
    method: "whatHappened",
    title: "What Happened",
    description: "Summarize what happened in a run, or in one node when nodeId is provided. A Gateway-configured narrator agent produces a short plain-text recap; without one the Gateway answers with a deterministic fact summary.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "run:read",
    requestSchema: objectSchema({ runId, nodeId, iteration }, ["runId"]),
    responseSchema: objectSchema({
      runId,
      nodeId: { type: ["string", "null"], description: "Node id when node-scoped, null for a run summary." },
      iteration: { type: ["integer", "null"], description: "Resolved node iteration, null for a run summary." },
      scope: { type: "string", enum: ["run", "node"] },
      summary: stringSchema("Short plain-text recap of what happened."),
      agentId: { type: ["string", "null"], description: "Narrator agent id, or null for the deterministic fallback." },
      source: { type: "string", enum: ["agent", "facts"] },
      cached: booleanSchema("True when served from the Gateway summary cache."),
      generatedAtMs: integerSchema("Unix epoch milliseconds when the summary was generated.", 0),
    }, ["runId", "nodeId", "iteration", "scope", "summary", "agentId", "source", "cached", "generatedAtMs"]),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "NodeNotFound", "Internal"],
    exampleRequest: { runId: "run_01", nodeId: "implement", iteration: 0 },
    exampleResponse: { runId: "run_01", nodeId: "implement", iteration: 0, scope: "node", summary: "The implement step finished in 42s after one retry.", agentId: "codex", source: "agent", cached: false, generatedAtMs: 1751000000000 },
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
        enum: ACCOUNT_PROVIDERS,
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
      kind: { type: "string", enum: DOC_KINDS, description: "Optional doc-kind filter; omit to list every kind." },
    }),
    responseSchema: arraySchema(objectSchema({
      path: stringSchema("Doc identity (primary key); e.g. a ticket id."),
      kind: { type: "string", enum: DOC_KINDS, description: "Doc kind." },
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
      kind: { type: "string", enum: DOC_KINDS, description: "Doc kind (default `ticket`)." },
      status: stringSchema("Optional initial status."),
    }, ["path", "content"]),
    responseSchema: objectSchema({
      path: stringSchema("Doc identity (primary key)."),
      kind: { type: "string", enum: DOC_KINDS, description: "Doc kind." },
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
      kind: { type: "string", enum: DOC_KINDS, description: "Doc kind." },
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
];

/** @type {Map<string, GatewayRpcDefinition>} */
const definitionByMethod = new Map(
  GATEWAY_RPC_DEFINITIONS.map((definition) => /** @type {[string, GatewayRpcDefinition]} */ ([definition.method, definition])),
);

/**
 * @param {string} method
 * @returns {GatewayRpcMethod | undefined}
 */
export function canonicalGatewayRpcMethod(method) {
  if (definitionByMethod.has(method)) {
    return /** @type {GatewayRpcMethod} */ (method);
  }
  return GATEWAY_RPC_LEGACY_METHOD_ALIASES[method];
}

/**
 * @param {string} method
 * @returns {GatewayRpcDefinition | undefined}
 */
export function getGatewayRpcDefinition(method) {
  const canonical = canonicalGatewayRpcMethod(method);
  return canonical ? definitionByMethod.get(canonical) : undefined;
}

/**
 * @param {string} method
 * @returns {GatewayScope | undefined}
 */
export function getRequiredScopeForGatewayMethod(method) {
  // hasOwn (not plain indexing) so inherited Object.prototype keys such as
  // "toString" fall through to the catalog lookup instead of matching.
  if (Object.hasOwn(HTTP_ROUTE_SCOPES, method)) {
    return HTTP_ROUTE_SCOPES[method];
  }
  return getGatewayRpcDefinition(method)?.requiredScope;
}

/**
 * @returns {readonly GatewayRpcMethod[]}
 */
export function listGatewayRpcMethods() {
  return GATEWAY_RPC_DEFINITIONS.map((definition) => definition.method);
}

/**
 * @param {string} method
 * @returns {method is GatewayRpcMethod}
 */
export function isGatewayRpcMethod(method) {
  return definitionByMethod.has(method);
}

/**
 * @returns {readonly GatewayScope[]}
 */
export function getGatewayScopeValues() {
  return GATEWAY_SCOPE_VALUES;
}
