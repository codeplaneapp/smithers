/** @typedef {import("./EventCategory.ts").EventCategory} EventCategory */
/** @typedef {import("./SmithersEventType.ts").SmithersEventType} SmithersEventType */
// FORMAT IS LOAD-BEARING: apps/cli/tests/docs-public-surface-coverage.test.js
// parses this file textually — it slices from the first `const` declaration
// below to the aliases map that follows it (matching on the declaration text,
// so do not repeat those `const ...` strings earlier in this file) and
// extracts entries with /^\s{4}([A-Za-z0-9]+): /gm, then requires the set to
// equal the SmithersEvent union. Keep one event per line at exactly 4-space
// indent, and add every new engine event type here AND to
// docs/reference/event-types.mdx.
const EVENT_CATEGORY_BY_TYPE = {
  SupervisorStarted: "supervisor",
  SupervisorPollCompleted: "supervisor",
  RunAutoResumed: "run",
  RunAutoResumeSkipped: "run",
  RunStarted: "run",
  RunStatusChanged: "run",
  RunStateChanged: "run",
  RunConcurrencySaturated: "run",
  RunFinished: "run",
  RunFailed: "run",
  RunCancelled: "run",
  RunContinuedAsNew: "run",
  RunHijackRequested: "run",
  RunHijacked: "run",
  OneshotSteerQueued: "run",
  OneshotSteerDelivered: "run",
  OneshotSteerAcknowledged: "run",
  OneshotSteerFailed: "run",
  OneshotRestartRequested: "run",
  OneshotRestartLaunched: "run",
  OneshotRestartFailed: "run",
  SandboxCreated: "sandbox",
  SandboxShipped: "sandbox",
  SandboxHeartbeat: "sandbox",
  SandboxBundleReceived: "sandbox",
  SandboxCompleted: "sandbox",
  SandboxFailed: "sandbox",
  SandboxDiffReviewRequested: "sandbox",
  SandboxDiffAccepted: "sandbox",
  SandboxDiffRejected: "sandbox",
  FrameCommitted: "frame",
  NodePending: "node",
  NodeStarted: "node",
  TaskHeartbeat: "node",
  TaskHeartbeatTimeout: "node",
  NodeFinished: "node",
  NodeFailed: "node",
  NodeStalled: "node",
  NodeCancelled: "node",
  NodeSkipped: "node",
  NodeRetrying: "node",
  NodeWaitingApproval: "node",
  NodeWaitingTimer: "node",
  ApprovalRequested: "approval",
  ApprovalGranted: "approval",
  ApprovalAutoApproved: "approval",
  ApprovalDenied: "approval",
  SteerQueued: "steer",
  SteerConsumed: "steer",
  SteerExpired: "steer",
  ToolCallStarted: "tool-call",
  ToolCallFinished: "tool-call",
  NodeOutput: "output",
  AgentEvent: "agent",
  RetryTaskStarted: "run",
  RetryTaskFinished: "run",
  RevertStarted: "revert",
  RevertFinished: "revert",
  TimeTravelStarted: "revert",
  TimeTravelFinished: "revert",
  TimeTravelJumped: "revert",
  EffectRevertStarted: "revert",
  EffectRevertFinished: "revert",
  EffectRevertFailed: "revert",
  SideEffectBoundaryCrossed: "revert",
  WorkflowReloadDetected: "workflow",
  WorkflowReloaded: "workflow",
  WorkflowReloadFailed: "workflow",
  WorkflowReloadUnsafe: "workflow",
  ScorerStarted: "scorer",
  ScorerFinished: "scorer",
  ScorerFailed: "scorer",
  TokenUsageReported: "token",
  SnapshotCaptured: "snapshot",
  RunForked: "run",
  ReplayStarted: "run",
  MemoryFactSet: "memory",
  MemoryRecalled: "memory",
  MemoryMessageSaved: "memory",
  OpenApiToolCalled: "openapi",
  TimerCreated: "timer",
  TimerFired: "timer",
  TimerCancelled: "timer",
  AgentTraceEvent: "agent",
  AgentTraceSummary: "agent",
  AgentSessionEvent: "agent",
};
const CATEGORY_ALIASES = {
  agent: "agent",
  approval: "approval",
  approvals: "approval",
  frame: "frame",
  memory: "memory",
  node: "node",
  steer: "steer",
  openapi: "openapi",
  output: "output",
  revert: "revert",
  run: "run",
  sandbox: "sandbox",
  scorer: "scorer",
  snapshot: "snapshot",
  supervisor: "supervisor",
  timer: "timer",
  token: "token",
  tool: "tool-call",
  toolcall: "tool-call",
  "tool-call": "tool-call",
  tool_call: "tool-call",
  workflow: "workflow",
  reload: "workflow",
};
const EVENT_TYPES_BY_CATEGORY = Object.entries(EVENT_CATEGORY_BY_TYPE).reduce(
  (acc, [type, category]) => {
    if (!acc[category]) acc[category] = [];
    acc[category].push(type);
    return acc;
  },
  {
    agent: [],
    approval: [],
    frame: [],
    memory: [],
    node: [],
    steer: [],
    openapi: [],
    output: [],
    revert: [],
    run: [],
    sandbox: [],
    scorer: [],
    snapshot: [],
    supervisor: [],
    timer: [],
    token: [],
    "tool-call": [],
    workflow: [],
  },
);
export const EVENT_CATEGORY_VALUES = Object.keys(EVENT_TYPES_BY_CATEGORY);
/**
 * @param {string} raw
 * @returns {EventCategory | null}
 */
export function normalizeEventCategory(raw) {
  const key = raw.trim().toLowerCase();
  return CATEGORY_ALIASES[key] ?? null;
}
/**
 * @param {string} type
 * @returns {EventCategory | null}
 */
export function eventCategoryForType(type) {
  return EVENT_CATEGORY_BY_TYPE[type] ?? null;
}
/**
 * @param {EventCategory} category
 * @returns {readonly SmithersEventType[]}
 */
export function eventTypesForCategory(category) {
  return EVENT_TYPES_BY_CATEGORY[category];
}
