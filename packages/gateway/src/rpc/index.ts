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
  | "NodeNotFound"
  | "IterationNotFound"
  | "NodeHasNoOutput"
  | "FrameOutOfRange"
  | "SeqOutOfRange"
  | "Busy"
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
  | "streamRunEvents"
  | "streamDevTools"
  | "getNodeOutput"
  | "getNodeDiff"
  | "cronList"
  | "cronCreate"
  | "cronDelete"
  | "cronRun";

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
  description: "Any JSON value.",
  nullable: true,
  oneOf: [
    { type: "object", additionalProperties: true },
    { type: "array", items: { nullable: true } },
    { type: "string" },
    { type: "number" },
    { type: "integer" },
    { type: "boolean" },
    { type: "null" },
  ],
};

const runId = stringSchema("Stable run identifier.");
const workflow = stringSchema("Registered Gateway workflow key.");
const nodeId = stringSchema("Workflow node id.");
const iteration = integerSchema("Node iteration.", 0);
const afterSeq = integerSchema("Replay events with sequence numbers greater than this value.", 0);
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

export const GATEWAY_RPC_ERRORS: Record<GatewayRpcErrorCode, GatewayRpcErrorDefinition> = {
  InvalidRequest: { version: SMITHERS_API_VERSION, code: "InvalidRequest", httpStatus: 400, description: "The request shape is invalid." },
  InvalidInput: { version: SMITHERS_API_VERSION, code: "InvalidInput", httpStatus: 400, description: "The request input failed validation." },
  Unauthorized: { version: SMITHERS_API_VERSION, code: "Unauthorized", httpStatus: 401, description: "Authentication failed or the token expired." },
  Forbidden: { version: SMITHERS_API_VERSION, code: "Forbidden", httpStatus: 403, description: "The token is missing the required scope." },
  RunNotFound: { version: SMITHERS_API_VERSION, code: "RunNotFound", httpStatus: 404, description: "The run does not exist." },
  NodeNotFound: { version: SMITHERS_API_VERSION, code: "NodeNotFound", httpStatus: 404, description: "The node does not exist on the run." },
  IterationNotFound: { version: SMITHERS_API_VERSION, code: "IterationNotFound", httpStatus: 404, description: "The requested node iteration does not exist." },
  NodeHasNoOutput: { version: SMITHERS_API_VERSION, code: "NodeHasNoOutput", httpStatus: 404, description: "The node has not produced output." },
  FrameOutOfRange: { version: SMITHERS_API_VERSION, code: "FrameOutOfRange", httpStatus: 400, description: "The requested frame is outside the available range." },
  SeqOutOfRange: { version: SMITHERS_API_VERSION, code: "SeqOutOfRange", httpStatus: 400, description: "The requested stream sequence is in the future." },
  Busy: { version: SMITHERS_API_VERSION, code: "Busy", httpStatus: 409, description: "Another conflicting mutation is in progress." },
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
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "Busy", "Internal"],
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
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "NodeNotFound", "Internal"],
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
    description: "Fetch the current RunStateView for one run.",
    maturity: "stable",
    transport: "http+websocket",
    requiredScope: "run:read",
    requestSchema: objectSchema({ runId }, ["runId"]),
    responseSchema: objectSchema({}, [], "RunStateView.", true),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "Internal"],
    exampleRequest: { runId: "run_01" },
    exampleResponse: { runId: "run_01", status: "finished", workflowKey: "deploy" },
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
    requestSchema: objectSchema({ runId, afterSeq }, ["runId"]),
    responseSchema: objectSchema({ streamId: stringSchema("Stream id."), runId, afterSeq: { type: ["integer", "null"] } }, ["streamId", "runId"]),
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "SeqOutOfRange", "BackpressureDisconnect", "Internal"],
    exampleRequest: { runId: "run_01", afterSeq: 10 },
    exampleResponse: { streamId: "stream_01", runId: "run_01", afterSeq: 10 },
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
    errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "Internal"],
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
    errors: ["InvalidRequest", "InvalidInput", "Unauthorized", "Forbidden", "RunNotFound", "Internal"],
    exampleRequest: { cronId: "cron_01", input: { dryRun: true } },
    exampleResponse: { runId: "run_02", workflow: "deploy" },
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
