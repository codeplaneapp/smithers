// @smithers-type-exports-begin
/** @typedef {import("./gatewayRpcTypes.ts").SmithersApiVersion} SmithersApiVersion */
/** @typedef {import("./gatewayRpcTypes.ts").JsonSchema} JsonSchema */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayRpcErrorCode} GatewayRpcErrorCode */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayRpcErrorDetails} GatewayRpcErrorDetails */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayRpcErrorDefinition} GatewayRpcErrorDefinition */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayRpcDefinition} GatewayRpcDefinition */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayRpcMethod} GatewayRpcMethod */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayResponseFrame} GatewayResponseFrame */
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
/** @typedef {import("./gatewayRpcTypes.ts").RewindRunResponse} RewindRunResponse */
/** @typedef {import("./gatewayRpcTypes.ts").CrossedEffect} CrossedEffect */
/** @typedef {import("./gatewayRpcTypes.ts").EffectBoundaryReport} EffectBoundaryReport */
/** @typedef {import("./gatewayRpcTypes.ts").EffectRevertStarted} EffectRevertStarted */
/** @typedef {import("./gatewayRpcTypes.ts").EffectRevertFinished} EffectRevertFinished */
/** @typedef {import("./gatewayRpcTypes.ts").EffectRevertFailed} EffectRevertFailed */
/** @typedef {import("./gatewayRpcTypes.ts").SideEffectBoundaryCrossed} SideEffectBoundaryCrossed */
/** @typedef {import("./gatewayRpcTypes.ts").SubmitApprovalRequest} SubmitApprovalRequest */
/** @typedef {import("./gatewayRpcTypes.ts").SubmitApprovalResponse} SubmitApprovalResponse */
/** @typedef {import("./gatewayRpcTypes.ts").SubmitSignalRequest} SubmitSignalRequest */
/** @typedef {import("./gatewayRpcTypes.ts").GetRunRequest} GetRunRequest */
/** @typedef {import("./gatewayRpcTypes.ts").RunTokenUsageEvent} RunTokenUsageEvent */
/** @typedef {import("./gatewayRpcTypes.ts").ListRunTokenUsageRequest} ListRunTokenUsageRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListRunTokenUsageResponse} ListRunTokenUsageResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GetRunDiffRequest} GetRunDiffRequest */
/** @typedef {import("./gatewayRpcTypes.ts").GetRunDiffResponse} GetRunDiffResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GetRunDiffOversizedResponse} GetRunDiffOversizedResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayDiffBundle} GatewayDiffBundle */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayDiffPatch} GatewayDiffPatch */
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
/** @typedef {import("./gatewayRpcTypes.ts").GatewayComparisonScoreRow} GatewayComparisonScoreRow */
/** @typedef {import("./gatewayRpcTypes.ts").ListScoresForRunsRequest} ListScoresForRunsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListScoresForRunsResponse} ListScoresForRunsResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GetScoreDetailRequest} GetScoreDetailRequest */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayScoreDetail} GatewayScoreDetail */
/** @typedef {import("./gatewayRpcTypes.ts").GetScoreDetailResponse} GetScoreDetailResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayDocKind} GatewayDocKind */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayTicketRow} GatewayTicketRow */
/** @typedef {import("./gatewayRpcTypes.ts").ListTicketsRequest} ListTicketsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListTicketsResponse} ListTicketsResponse */
/** @typedef {import("./gatewayRpcTypes.ts").CreateTicketRequest} CreateTicketRequest */
/** @typedef {import("./gatewayRpcTypes.ts").UpdateTicketRequest} UpdateTicketRequest */
/** @typedef {import("./gatewayRpcTypes.ts").DeleteTicketRequest} DeleteTicketRequest */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserSource} BrowserSource */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserLocator} BrowserLocator */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserSnapshot} BrowserSnapshot */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserAction} BrowserAction */
/** @typedef {import("./gatewayRpcTypes.ts").CreateBrowserSessionRequest} CreateBrowserSessionRequest */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserActRequest} BrowserActRequest */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserContextRequest} BrowserContextRequest */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserPickRequest} BrowserPickRequest */
/** @typedef {import("./gatewayRpcTypes.ts").CloseBrowserSessionRequest} CloseBrowserSessionRequest */
/** @typedef {import("./gatewayRpcTypes.ts").CreateBrowserSessionResponse} CreateBrowserSessionResponse */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserActResponse} BrowserActResponse */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserContextResponse} BrowserContextResponse */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserPickResponse} BrowserPickResponse */
/** @typedef {import("./gatewayRpcTypes.ts").CloseBrowserSessionResponse} CloseBrowserSessionResponse */
/** @typedef {import("./gatewayRpcTypes.ts").ListBrowserSessionsResponse} ListBrowserSessionsResponse */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserActor} BrowserActor */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserViewport} BrowserViewport */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserPoint} BrowserPoint */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserRectangle} BrowserRectangle */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserModifier} BrowserModifier */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserRedaction} BrowserRedaction */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserOutcome} BrowserOutcome */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserJournalEntry} BrowserJournalEntry */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserContextSlice} BrowserContextSlice */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserSummary} BrowserSummary */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserClickAction} BrowserClickAction */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserFrameEvent} BrowserFrameEvent */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserActivityEvent} BrowserActivityEvent */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserScreenshot} BrowserScreenshot */
/** @typedef {import("./gatewayRpcTypes.ts").BrowserSelection} BrowserSelection */
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
const stringSchema = (description, minLength) => ({ type: "string", ...(minLength ? { minLength } : {}), description });
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
  oneOf: [
    { type: "object", additionalProperties: true },
    { type: "array", items: {} },
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
    startedAtMs: { type: ["integer", "null"], minimum: 0, description: "Unix epoch milliseconds." },
    finishedAtMs: { type: ["integer", "null"], minimum: 0, description: "Unix epoch milliseconds." },
    summary: objectSchema({}, [], "Counts keyed by persisted node state.", true),
    runState: runStateView,
  },
  ["runId"],
  "Current run record, including node-state counts and optional derived runState.",
  true,
);
const crossedEffectSchema = objectSchema({
  kind: { type: "string", enum: ["tool", "task"] },
  toolName: stringSchema("Defined tool name or task node id."),
  nodeId,
  iteration,
  attempt: integerSchema("Attempt number.", 1),
  seq: integerSchema("Tool-call sequence.", 0),
  effectStatus: { type: "string", enum: ["succeeded", "unknown"] },
  idempotent: booleanSchema("Whether the original effect is idempotent."),
  hasRevert: booleanSchema("Whether a revert handler was registered."),
  startedAtMs: integerSchema("Effect start time.", 0),
  reason: stringSchema("Disposition explanation."),
}, ["kind", "toolName", "nodeId", "iteration", "attempt", "seq", "effectStatus", "idempotent", "hasRevert", "startedAtMs"]);
const effectBoundaryReportSchema = objectSchema({
  blocking: arraySchema(crossedEffectSchema, "Uncompensated effects that block the operation."),
  revertible: arraySchema(crossedEffectSchema, "Effects with registered compensation handlers."),
  warnings: arraySchema(crossedEffectSchema, "Legacy or previously forced effects that do not block."),
}, ["blocking", "revertible", "warnings"]);
const browserErrors = ["InvalidRequest", "Unauthorized", "Forbidden", "REVISION_CONFLICT", "SSRF_BLOCKED", "QUOTA_EXCEEDED", "Internal"];
const browserSourceSchema = { oneOf: [objectSchema({ kind: { const: "url" }, url: stringSchema("Public http or https URL.", 1) }, ["kind", "url"]), objectSchema({ kind: { const: "dev-server" }, port: integerSchema("Declared loopback port.", 1), path: stringSchema("Absolute path on the dev server.", 1) }, ["kind", "port"])], description: "Browser navigation source." };
const browserViewportSchema = objectSchema({ width: { ...integerSchema("Viewport width.", 1), maximum: 3840 }, height: { ...integerSchema("Viewport height.", 1), maximum: 2160 } }, ["width", "height"]);
const browserPageSchema = objectSchema({ url: stringSchema("Current URL."), title: stringSchema("Page title."), canGoBack: booleanSchema("Whether history can go back."), canGoForward: booleanSchema("Whether history can go forward.") }, ["url", "title", "canGoBack", "canGoForward"]);
const browserSnapshotSchema = objectSchema({ sessionId: stringSchema("Opaque session identifier."), source: browserSourceSchema, status: { type: "string", enum: ["starting", "ready", "loading", "suspended", "closed", "failed"] }, revision: integerSchema("Settled action revision."), page: { oneOf: [browserPageSchema, { type: "null" }] }, viewport: browserViewportSchema, control: objectSchema({ owner: { type: ["string", "null"], enum: ["user", "agent", null] } }, ["owner"]) }, ["sessionId", "source", "status", "revision", "page", "viewport", "control"]);
const browserSnapshotExample = { sessionId: "s1", source: { kind: "url", url: "https://example.com" }, status: "ready", revision: 0, page: { url: "https://example.com/", title: "Example", canGoBack: false, canGoForward: false }, viewport: { width: 1280, height: 720 }, control: { owner: null } };
const browserLocatorSchema = { oneOf: [objectSchema({ testId: stringSchema("Stable test id.", 1) }, ["testId"]), objectSchema({ role: stringSchema("Accessible role.", 1), name: stringSchema("Accessible name.", 1) }, ["role"]), objectSchema({ css: stringSchema("Safe CSS selector.", 1) }, ["css"]) ] };
const browserActionSchema = { oneOf: [{ type: "object", properties: { kind: { const: "navigate" }, url: stringSchema("Destination URL.", 1) }, required: ["kind", "url"], additionalProperties: false }, ...["back", "forward", "reload", "stop"].map((kind) => ({ type: "object", properties: { kind: { const: kind } }, required: ["kind"], additionalProperties: false })), { oneOf: [{ type: "object", properties: { kind: { const: "click" }, locator: browserLocatorSchema, button: { type: "string", enum: ["left", "right", "middle"] }, modifiers: arraySchema(stringSchema("Keyboard modifier.", 1), "Modifiers.") }, required: ["kind", "locator"], additionalProperties: false }, { type: "object", properties: { kind: { const: "click" }, point: objectSchema({ x: { type: "number" }, y: { type: "number" } }, ["x", "y"]), button: { type: "string", enum: ["left", "right", "middle"] }, modifiers: arraySchema(stringSchema("Keyboard modifier.", 1), "Modifiers.") }, required: ["kind", "point"], additionalProperties: false }] }, { type: "object", properties: { kind: { const: "type" }, locator: browserLocatorSchema, text: stringSchema("Text input.", 1), replace: booleanSchema("Replace existing value.") }, required: ["kind", "locator", "text"], additionalProperties: false }, { type: "object", properties: { kind: { const: "press" }, key: stringSchema("Keyboard key.", 1), modifiers: arraySchema(stringSchema("Keyboard modifier.", 1), "Modifiers.") }, required: ["kind", "key"], additionalProperties: false }, { type: "object", properties: { kind: { const: "scroll" }, deltaX: { type: "number" }, deltaY: { type: "number" } }, required: ["kind", "deltaX", "deltaY"], additionalProperties: false }, { type: "object", properties: { kind: { const: "dialog" }, decision: { type: "string", enum: ["accept", "dismiss"] }, promptText: stringSchema("Replacement prompt text.", 1) }, required: ["kind", "decision"], additionalProperties: false }] };
const browserCreateRequestSchema = objectSchema({ source: browserSourceSchema, viewport: browserViewportSchema }, ["source"]);
const browserActRequestSchema = objectSchema({ sessionId: stringSchema("Opaque session identifier.", 1), actionId: stringSchema("Caller-created dedupe identifier.", 1), expectedRevision: integerSchema("Optimistic revision fence.", 0), action: browserActionSchema }, ["sessionId", "actionId", "action"]);
const browserContextRequestSchema = objectSchema({ sessionId: stringSchema("Opaque session identifier.", 1), sinceRevision: integerSchema("Freshness fence.", 0), include: arraySchema({ type: "string", minLength: 1, enum: ["visible-text", "accessibility", "interactive-elements", "screenshot", "selections", "recent-actions", "console-summary", "network-summary"] }, "Requested context slices.") }, ["sessionId"]);
const browserOutcomeSchema = { oneOf: [objectSchema({ ok: { const: true }, redirectedTo: stringSchema("Redirect destination.", 1), redacted: booleanSchema("Whether sensitive content was redacted."), length: integerSchema("Redacted content length.", 0) }, ["ok"], "Successful browser action result."), objectSchema({ ok: { const: false }, code: stringSchema("Browser action failure code.", 1), message: stringSchema("Browser action failure message.", 1) }, ["ok", "code", "message"], "Failed browser action result.")] };
const browserActResponseSchema = objectSchema({ revision: integerSchema("Settled revision."), page: { oneOf: [browserPageSchema, { type: "null" }] }, outcome: browserOutcomeSchema }, ["revision", "page", "outcome"]);
const browserScreenshotSchema = { oneOf: [objectSchema({ data: stringSchema("Base64-encoded JPEG bytes; at most 512 KiB decoded."), mediaType: { const: "image/jpeg" } }, ["data", "mediaType"]), { type: "null" }] };
const browserSelectionSchema = objectSchema({ locator: objectSchema({}, [], "Safe locator ladder.", true), role: stringSchema("Element role."), name: stringSchema("Element accessible name."), text: stringSchema("Redacted and bounded visible text."), fingerprint: stringSchema("Staleness fingerprint."), rect: objectSchema({ x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } }, ["x", "y", "width", "height"]), viewport: browserViewportSchema }, ["locator", "role", "name", "text", "fingerprint", "rect", "viewport"]);
const browserContextResponseSchema = objectSchema({ fresh: booleanSchema("Whether all requested slices were captured at the current revision."), reason: stringSchema("Freshness failure reason."), snapshot: browserSnapshotSchema, revision: integerSchema("Current revision."), include: arraySchema(stringSchema("Slice name."), "Returned slices."), screenshot: browserScreenshotSchema, selections: arraySchema(browserSelectionSchema, "Bounded successful pick history.") }, ["fresh", "snapshot", "revision", "include"], "Bounded browser context.", true);
const browserPickRequestSchema = objectSchema({ sessionId: stringSchema("Opaque session identifier.", 1), point: objectSchema({ x: { type: "number" }, y: { type: "number" } }, ["x", "y"]) }, ["sessionId", "point"]);
const browserPickResponseSchema = objectSchema({ locator: objectSchema({}, [], "Safe locator ladder.", true), role: stringSchema("Element role."), name: stringSchema("Element accessible name."), text: stringSchema("Redacted and bounded visible text."), fingerprint: stringSchema("Staleness fingerprint."), rect: objectSchema({ x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } }, ["x", "y", "width", "height"]), viewport: browserViewportSchema, screenshot: browserScreenshotSchema }, ["locator", "role", "name", "text", "fingerprint", "rect", "viewport", "screenshot"]);

/** @type {Record<GatewayRpcErrorCode, GatewayRpcErrorDefinition>} */
export const GATEWAY_RPC_ERRORS = {
  InvalidRequest: { version: SMITHERS_API_VERSION, code: "InvalidRequest", httpStatus: 400, description: "The request shape is invalid." },
  InvalidInput: { version: SMITHERS_API_VERSION, code: "InvalidInput", httpStatus: 400, description: "The request input failed validation." },
  Unauthorized: { version: SMITHERS_API_VERSION, code: "Unauthorized", httpStatus: 401, description: "Authentication failed or the token expired." },
  Forbidden: { version: SMITHERS_API_VERSION, code: "Forbidden", httpStatus: 403, description: "The token is missing the required scope." },
  RunNotFound: { version: SMITHERS_API_VERSION, code: "RunNotFound", httpStatus: 404, description: "The run does not exist." },
  ScoreNotFound: { version: SMITHERS_API_VERSION, code: "ScoreNotFound", httpStatus: 404, description: "The score does not exist on the requested run." },
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
  TIME_TRAVEL_SIDE_EFFECT_BLOCKED: { version: SMITHERS_API_VERSION, code: "TIME_TRAVEL_SIDE_EFFECT_BLOCKED", httpStatus: 409, description: "The requested time travel crosses an unresolved external side effect." },
  Internal: { version: SMITHERS_API_VERSION, code: "Internal", httpStatus: 500, description: "The Gateway encountered an internal error." },
  REVISION_CONFLICT: { version: SMITHERS_API_VERSION, code: "REVISION_CONFLICT", httpStatus: 409, description: "The browser session revision is stale." },
  SSRF_BLOCKED: { version: SMITHERS_API_VERSION, code: "SSRF_BLOCKED", httpStatus: 400, description: "The browser destination is not allowed." },
  QUOTA_EXCEEDED: { version: SMITHERS_API_VERSION, code: "QUOTA_EXCEEDED", httpStatus: 429, description: "The browser session quota is exhausted." },
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
        startedBy: objectSchema({
          harness: { type: "string", maxLength: 64, description: "Self-reported launch harness; surrounding whitespace is trimmed." },
          sessionId: { type: "string", maxLength: 256, description: "Self-reported harness session; surrounding whitespace is trimmed." },
          prompt: { type: "string", description: "Explicit launch context, stored durably and visibly clipped to 8,192 Unicode code points. Never inferred from workflow input." },
          detected: { type: "boolean", const: true, description: "Present only when harness or session attribution was auto-detected." },
        }, [], "Optional self-reported launch provenance, distinct from authenticated identity."),
      }, [], "Launch options."),
    }, ["workflow"]),
    responseSchema: objectSchema({ runId, workflow }, ["runId", "workflow"]),
    errors: ["InvalidRequest", "InvalidInput", "Unauthorized", "Forbidden", "Internal"],
    exampleRequest: { workflow: "deploy", input: { sha: "abc123" }, options: { runId: "deploy-abc123", allowNetwork: true, startedBy: { harness: "codex", sessionId: "thread_123" } } },
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
    requestSchema: objectSchema({
      runId,
      frameNo: integerSchema("Target frame number.", 0),
      confirm: { const: true, description: "Must be true." },
      force: booleanSchema("Cross unresolved effects and mark the run needs-attention."),
      noRevert: booleanSchema("Skip registered revert handlers."),
    }, ["runId", "frameNo", "confirm"]),
    responseSchema: objectSchema({
      ok: { const: true },
      newFrameNo: integerSchema("Committed target frame.", 0),
      revertedSandboxes: integerSchema("Reverted sandbox count.", 0),
      deletedFrames: integerSchema("Discarded frame count.", 0),
      deletedAttempts: integerSchema("Discarded attempt count.", 0),
      invalidatedDiffs: integerSchema("Invalidated diff count.", 0),
      durationMs: integerSchema("Operation duration.", 0),
      effectBoundary: effectBoundaryReportSchema,
    }, ["ok", "newFrameNo", "revertedSandboxes", "deletedFrames", "deletedAttempts", "invalidatedDiffs", "durationMs", "effectBoundary"]),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "FrameOutOfRange", "Busy", "RateLimited", "UnsupportedSandbox", "VcsError", "RewindFailed", "TIME_TRAVEL_SIDE_EFFECT_BLOCKED"],
    exampleRequest: { runId: "run_01", frameNo: 4, confirm: true, force: false, noRevert: false },
    exampleResponse: { ok: true, newFrameNo: 4, revertedSandboxes: 0, deletedFrames: 2, deletedAttempts: 1, invalidatedDiffs: 0, durationMs: 12, effectBoundary: { blocking: [], revertible: [], warnings: [] } },
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
      note: stringSchema("Optional approval note."),
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
    method: "listRunTokenUsage",
    title: "List Run Token Usage",
    description: "List every persisted TokenUsageReported attempt event for a run, ordered by event sequence.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "run:read",
    requestSchema: objectSchema({ runId }, ["runId"]),
    responseSchema: objectSchema({
      runId,
      events: arraySchema(objectSchema({
        nodeId,
        iteration,
        attempt: integerSchema("Attempt number.", 0),
        model: stringSchema("Resolved provider model id."),
        agent: stringSchema("Agent id or adapter name."),
        inputTokens: integerSchema("Reported input tokens.", 0),
        outputTokens: integerSchema("Reported output tokens.", 0),
        cacheReadTokens: integerSchema("Reported cache-read tokens.", 0),
        cacheWriteTokens: integerSchema("Reported cache-write tokens.", 0),
        reasoningTokens: integerSchema("Reported reasoning tokens.", 0),
        timestampMs: integerSchema("Event timestamp in Unix epoch milliseconds.", 0),
      }, ["nodeId", "iteration", "attempt", "model", "agent", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "timestampMs"]), "Persisted token-usage attempt events."),
    }, ["runId", "events"]),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "Internal"],
    exampleRequest: { runId: "run_01" },
    exampleResponse: {
      runId: "run_01",
      events: [{
        nodeId: "implement",
        iteration: 0,
        attempt: 1,
        model: "gpt-5.4-codex",
        agent: "codex-work",
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 40,
        cacheWriteTokens: 5,
        reasoningTokens: 12,
        timestampMs: 1710000000000,
      }],
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
    requestSchema: objectSchema({ filter: objectSchema({ status: stringSchema("Optional run status filter."), limit: integerSchema("Maximum number of runs.", 1), offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Rows to skip after the newest-first sort (server-side pagination); a safe non-negative integer." }, workflow: stringSchema("Optional workflow key filter.") }) }),
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
    method: "getRunDiff",
    title: "Get Run Diff",
    description: "Fetch the final base-to-terminal DiffBundle for a run. An oversized result is returned as an explicit marker.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "run:read",
    requestSchema: objectSchema({ runId }, ["runId"]),
    responseSchema: {
      oneOf: [
        objectSchema({
          seq: integerSchema("Terminal diff sequence.", 0),
          baseRef: stringSchema("Immutable run base commit.") ,
          patches: arraySchema({
            type: "object",
            properties: {
              path: stringSchema("Changed file path."),
              operation: { type: "string", enum: ["add", "modify", "delete"] },
              diff: stringSchema("Unified patch text."),
              binaryContent: { type: ["string", "null"], description: "Base64 binary content when applicable." },
            },
            required: ["path", "operation", "diff"],
            additionalProperties: false,
          }, "Changed files."),
        }, ["seq", "baseRef", "patches"], "Final run DiffBundle."),
        objectSchema({
          status: { type: "string", enum: ["oversized"] },
          baseRef: stringSchema("Immutable run base commit."),
          terminalRef: stringSchema("Terminal commit, or multiple when lanes were merged."),
          sizeBytes: integerSchema("Serialized response size.", 0),
          maxBytes: integerSchema("Maximum response size.", 1),
        }, ["status", "baseRef", "terminalRef", "sizeBytes", "maxBytes"], "Explicit oversized marker."),
      ],
    },
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "VcsError", "Internal"],
    exampleRequest: { runId: "run_01" },
    exampleResponse: { seq: 3, baseRef: "abc123", patches: [] },
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
    method: "listUsageReports",
    title: "List Usage Reports",
    description: "List normalized provider rate-limit and subscription-usage reports for registered Smithers accounts.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "account:read",
    requestSchema: objectSchema({ fresh: booleanSchema("Bypass the Gateway's 60-second in-memory cache.") }),
    responseSchema: arraySchema(objectSchema({
      accountLabel: stringSchema("Registered account label."),
      provider: {
        type: "string",
        enum: ACCOUNT_PROVIDERS,
        description: "Provider id, one of the fixed `smithers agents` catalog.",
      },
      authMode: { type: "string", enum: ["subscription", "api-key"] },
      source: { type: "string", enum: ["oauth", "headers", "local", "none"] },
      windows: arraySchema(objectSchema({
        id: stringSchema("Stable quota-window id."),
        label: stringSchema("Human-readable quota-window label."),
        unit: { type: "string", enum: ["percent", "count", "estimated"] },
        usedPercent: { type: "number" },
        used: { type: "number" },
        limit: { type: "number" },
        remaining: { type: "number" },
        resetsAt: stringSchema("ISO-8601 reset timestamp."),
      }, ["id", "label", "unit"]), "Provider quota windows."),
      planType: stringSchema("Provider plan or tier label."),
      credits: objectSchema({
        hasCredits: booleanSchema("Whether a credit balance is present."),
        unlimited: booleanSchema("Whether credits are unlimited."),
        balance: stringSchema("Provider-formatted credit balance."),
      }, ["hasCredits", "unlimited"]),
      fetchedAt: stringSchema("ISO-8601 report timestamp."),
      stale: booleanSchema("Whether the usage package served a cached report."),
      estimate: booleanSchema("Whether the report is locally estimated."),
      error: stringSchema("Human-readable probe failure reason."),
    }, ["accountLabel", "provider", "authMode", "source", "windows", "fetchedAt", "stale", "estimate"]), "Provider usage reports."),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "Internal"],
    exampleRequest: {},
    exampleResponse: [{
      accountLabel: "codex-work",
      provider: "codex",
      authMode: "subscription",
      source: "oauth",
      windows: [{ id: "5h", label: "5-hour session", unit: "percent", usedPercent: 42, resetsAt: "2026-01-01T05:00:00.000Z" }],
      planType: "pro",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      stale: false,
      estimate: false,
    }],
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
      source: stringSchema("Persisted score provenance (`live` or `batch` for production scorer rows)."),
      score: { type: "number", description: "The scorer's numeric verdict." },
      reason: { type: ["string", "null"], description: "Optional human reason for the score." },
      scoredAtMs: integerSchema("Unix epoch milliseconds when the score was recorded.", 0),
      latencyMs: { type: ["number", "null"], description: "Optional scorer latency in milliseconds." },
      durationMs: { type: ["number", "null"], description: "Optional node duration in milliseconds." },
    }, ["runId", "nodeId", "iteration", "attempt", "scorerId", "scorerName", "source", "score", "scoredAtMs"]), "Scorer results."),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "Internal"],
    exampleRequest: { runId: "run_01", nodeId: "review" },
    exampleResponse: [{ runId: "run_01", nodeId: "review", iteration: 0, attempt: 0, scorerId: "correctness", scorerName: "correctness", source: "live", score: 0.92, scoredAtMs: 1710000000000 }],
  },
  {
    version: SMITHERS_API_VERSION,
    method: "listScoresForRuns",
    title: "List Scores For Runs",
    description: "List and globally page persisted scorer rows across up to 30 explicit run ids. The caller must supply the scorer-producing run ids; this does not expand an eval wrapper into child case runs or provide experiment/case alignment.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "score:read",
    requestSchema: objectSchema({
      runIds: {
        type: "array",
        description: "Up to 30 run-id entries to compare. The server trims values and deduplicates them in first-seen order.",
        items: { type: "string", minLength: 1, maxLength: 256 },
        maxItems: 30,
      },
      nodeId: stringSchema("Optional exact, case-sensitive node id filter."),
      scorerId: stringSchema("Optional exact, case-sensitive scorer id filter."),
      scorerName: stringSchema("Optional exact, case-sensitive scorer name filter."),
      source: { type: "string", enum: ["live", "batch"], description: "Optional exact production score provenance filter." },
      order: { type: "string", enum: ["scoredAtAsc", "scoredAtDesc"], default: "scoredAtAsc", description: "Primary score timestamp order." },
      offset: { type: "integer", minimum: 0, maximum: 9_999, default: 0, description: "Global result offset after merging distinct stores. The offset plus limit may not exceed the 10,000-row comparison window." },
      limit: { type: "integer", minimum: 1, maximum: 500, default: 500, description: "Maximum globally merged rows to return. The offset plus limit may not exceed the 10,000-row comparison window." },
    }, ["runIds"]),
    responseSchema: objectSchema({
      rows: arraySchema(objectSchema({
        scoreId: stringSchema("Exact persisted score id."),
        runId: stringSchema("Run id the score belongs to."),
        nodeId: stringSchema("Node id the score was produced for."),
        iteration: integerSchema("Node iteration the score belongs to.", 0),
        attempt: integerSchema("Node attempt the score belongs to.", 0),
        scorerId: stringSchema("Stable scorer id."),
        scorerName: stringSchema("Human scorer name."),
        source: stringSchema("Persisted score source."),
        score: { type: "number", description: "The scorer's numeric verdict." },
        reason: { type: ["string", "null"], description: "Optional human reason for the score." },
        scoredAtMs: integerSchema("Unix epoch milliseconds when the score was recorded.", 0),
        latencyMs: { type: ["number", "null"], description: "Optional scorer latency in milliseconds." },
        durationMs: { type: ["number", "null"], description: "Optional node duration in milliseconds." },
      }, ["scoreId", "runId", "nodeId", "iteration", "attempt", "scorerId", "scorerName", "source", "score", "scoredAtMs"]), "Globally ordered persisted scorer rows."),
      total: integerSchema("Total filtered row count before global pagination.", 0),
    }, ["rows", "total"]),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "Internal"],
    exampleRequest: { runIds: ["run_01", "run_02"], order: "scoredAtDesc", offset: 0, limit: 500 },
    exampleResponse: {
      rows: [{ scoreId: "run_01:review:correctness", runId: "run_01", nodeId: "review", iteration: 0, attempt: 0, scorerId: "correctness", scorerName: "correctness", source: "live", score: 0.92, scoredAtMs: 1710000000000 }],
      total: 1,
    },
  },
  {
    version: SMITHERS_API_VERSION,
    method: "getScoreDetail",
    title: "Get Score Detail",
    description: "Read one exact persisted score row with its JSON detail columns decoded.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "score:read",
    requestSchema: objectSchema({
      runId: { type: "string", minLength: 1, maxLength: 256, description: "Owning run id (trimmed by the server)." },
      scoreId: { type: "string", minLength: 1, maxLength: 256, description: "Exact persisted score id (trimmed by the server)." },
    }, ["runId", "scoreId"]),
    responseSchema: objectSchema({
      scoreId: stringSchema("Exact persisted score id."),
      runId: stringSchema("Run id the score belongs to."),
      nodeId: stringSchema("Node id the score was produced for."),
      iteration: integerSchema("Node iteration the score belongs to.", 0),
      attempt: integerSchema("Node attempt the score belongs to.", 0),
      scorerId: stringSchema("Stable scorer id."),
      scorerName: stringSchema("Human scorer name."),
      source: stringSchema("Persisted score source."),
      score: { type: "number", description: "The scorer's numeric verdict." },
      reason: { type: ["string", "null"], description: "Optional human reason for the score." },
      scoredAtMs: integerSchema("Unix epoch milliseconds when the score was recorded.", 0),
      latencyMs: { type: ["number", "null"], description: "Optional scorer latency in milliseconds." },
      durationMs: { type: ["number", "null"], description: "Optional node duration in milliseconds." },
      meta: anyJsonSchema,
      input: anyJsonSchema,
      output: anyJsonSchema,
      groundTruth: anyJsonSchema,
      context: anyJsonSchema,
    }, ["scoreId", "runId", "nodeId", "iteration", "attempt", "scorerId", "scorerName", "source", "score", "scoredAtMs", "meta", "input", "output", "groundTruth", "context"]),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "ScoreNotFound", "Internal"],
    exampleRequest: { runId: "run_01", scoreId: "run_01:review:correctness" },
    exampleResponse: {
      scoreId: "run_01:review:correctness",
      runId: "run_01",
      nodeId: "review",
      iteration: 0,
      attempt: 0,
      scorerId: "correctness",
      scorerName: "correctness",
      source: "live",
      score: 0.92,
      scoredAtMs: 1710000000000,
      meta: { rubric: "correctness" },
      input: { prompt: "Review this." },
      output: { verdict: "pass" },
      groundTruth: null,
      context: null,
    },
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
  { version: SMITHERS_API_VERSION, method: "createBrowserSession", title: "createBrowserSession", description: "Create an ephemeral Chromium browser session.", maturity: "stable", transport: "http+websocket", requiredScope: "run:write", requestSchema: browserCreateRequestSchema, responseSchema: browserSnapshotSchema, errors: ["InvalidRequest", "Unauthorized", "Forbidden", "REVISION_CONFLICT", "SSRF_BLOCKED", "QUOTA_EXCEEDED", "Internal"], exampleRequest: { source: { kind: "url", url: "https://example.com" } }, exampleResponse: browserSnapshotExample },
  { version: SMITHERS_API_VERSION, method: "browserAct", title: "browserAct", description: "Perform one ordered, deduplicated browser action.", maturity: "stable", transport: "http+websocket", requiredScope: "run:write", requestSchema: browserActRequestSchema, responseSchema: browserActResponseSchema, errors: ["InvalidRequest", "Unauthorized", "Forbidden", "REVISION_CONFLICT", "SSRF_BLOCKED", "QUOTA_EXCEEDED", "Internal"], exampleRequest: { sessionId: "s1", actionId: "a1", action: { kind: "reload" } }, exampleResponse: { revision: 1, page: null, outcome: { ok: true } } },
  { version: SMITHERS_API_VERSION, method: "browserContext", title: "browserContext", description: "Read bounded live browser perception slices; screenshots are inline JPEGs and selections are a bounded metadata-only history.", maturity: "stable", transport: "http+websocket", requiredScope: "run:read", requestSchema: browserContextRequestSchema, responseSchema: browserContextResponseSchema, errors: ["InvalidRequest", "Unauthorized", "Forbidden", "REVISION_CONFLICT", "SSRF_BLOCKED", "QUOTA_EXCEEDED", "Internal"], exampleRequest: { sessionId: "s1", include: ["visible-text", "screenshot"] }, exampleResponse: { fresh: true, snapshot: browserSnapshotExample, revision: 0, include: ["visible-text"], screenshot: { data: "/9j/4AAQ", mediaType: "image/jpeg" } } },
  { version: SMITHERS_API_VERSION, method: "browserPick", title: "browserPick", description: "Hit-test a live page and return safe locator metadata with an inline JPEG (at most 512 KiB decoded).", maturity: "stable", transport: "http+websocket", requiredScope: "run:read", requestSchema: browserPickRequestSchema, responseSchema: browserPickResponseSchema, errors: ["InvalidRequest", "Unauthorized", "Forbidden", "REVISION_CONFLICT", "SSRF_BLOCKED", "QUOTA_EXCEEDED", "Internal"], exampleRequest: { sessionId: "s1", point: { x: 10, y: 10 } }, exampleResponse: { locator: { role: "button", name: "Continue" }, role: "button", name: "Continue", text: "Continue", fingerprint: "button:Continue:0:0", rect: { x: 0, y: 0, width: 80, height: 30 }, viewport: { width: 1280, height: 720 }, screenshot: { data: "/9j/4AAQ", mediaType: "image/jpeg" } } },
  { version: SMITHERS_API_VERSION, method: "closeBrowserSession", title: "closeBrowserSession", description: "Close and wipe a browser session.", maturity: "stable", transport: "http+websocket", requiredScope: "run:write", requestSchema: objectSchema({ sessionId: stringSchema("Opaque browser session identifier.", 1) }, ["sessionId"]), responseSchema: objectSchema({ closed: booleanSchema("Whether the session is closed."), sessionId: stringSchema("Closed session identifier.") }, ["closed"]), errors: ["InvalidRequest", "Unauthorized", "Forbidden", "REVISION_CONFLICT", "SSRF_BLOCKED", "QUOTA_EXCEEDED", "Internal"], exampleRequest: { sessionId: "s1" }, exampleResponse: { closed: true, sessionId: "s1" } },
  { version: SMITHERS_API_VERSION, method: "listBrowserSessions", title: "listBrowserSessions", description: "List live browser sessions in this workspace.", maturity: "stable", transport: "http+websocket", requiredScope: "run:read", requestSchema: objectSchema({}, [], "No parameters."), responseSchema: arraySchema(browserSnapshotSchema, "Browser session snapshots."), errors: ["InvalidRequest", "Unauthorized", "Forbidden", "REVISION_CONFLICT", "SSRF_BLOCKED", "QUOTA_EXCEEDED", "Internal"], exampleRequest: {}, exampleResponse: [browserSnapshotExample] },
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
  return Object.hasOwn(GATEWAY_RPC_LEGACY_METHOD_ALIASES, method)
    ? GATEWAY_RPC_LEGACY_METHOD_ALIASES[method]
    : undefined;
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
