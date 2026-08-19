/**
 * Which `_smithers_events` types the parity suite treats as engine-observable
 * semantics, and which belong to one engine's internals.
 *
 * The classification is an explicit allowlist on both sides rather than a
 * filter, so a type that belongs to neither list lands in the projection as
 * `unclassified:<type>` and shows up as an oracle diff instead of being
 * silently dropped. When a new event type is introduced it must be classified
 * here on purpose.
 */

/**
 * Durable workflow semantics. An engine that claims parity must emit these
 * for the same nodes in the same per-node order.
 */
export const PARITY_SEMANTIC_EVENT_TYPES: ReadonlySet<string> = new Set([
  // Run lifecycle
  "RunStarted",
  "RunFinished",
  "RunFailed",
  "RunCancelled",
  "RunCanceled",
  "RunContinuedAsNew",
  "RunStatusChanged",
  "RunHijackRequested",
  "RunHijacked",
  // Attributed control verbs (stage 1.4). `RunControlRequested` is journaled
  // before the durable flip and `RunControlApplied` after it, so a pause,
  // cancel, steer, or hijack carries who asked and why. They are semantics,
  // not bookkeeping: an engine that drops them loses the attribution record.
  "RunControlRequested",
  "RunControlApplied",
  // Node lifecycle
  "NodePending",
  "NodeStarted",
  "NodeFinished",
  "NodeFailed",
  "NodeRetrying",
  "NodeSkipped",
  "NodeCancelled",
  "NodeStalled",
  "NodeOutput",
  // Waiting taxonomy (stage 1.4 routes these through FlowRuntime.annotateWaiting).
  // The legacy engine's event union has exactly these two: a signal park emits
  // no per-node waiting event at all, only the run-level RunStatusChanged. If
  // the flows engine adds a third it lands as `unclassified:` and has to be
  // classified here on purpose, which is the point of the allowlist.
  "NodeWaitingApproval",
  "NodeWaitingTimer",
  // Approvals, timers, steering, scorers
  "ApprovalRequested",
  "ApprovalGranted",
  "ApprovalDenied",
  "ApprovalAutoApproved",
  "TimerCreated",
  "TimerFired",
  "TimerCancelled",
  "SteerQueued",
  "SteerConsumed",
  "SteerExpired",
  "ScorerStarted",
  "ScorerFinished",
  "ScorerFailed",
]);

/**
 * Types produced by one engine's own bookkeeping. They carry content hashes,
 * frame numbers, or scheduler timing, none of which the other engine is
 * required to reproduce, so they are excluded from the projection entirely.
 *
 * `FrameCommitted` and `SnapshotCaptured` are the legacy React render loop's
 * frame journal. `RunConcurrencySaturated` is scheduler backpressure telemetry
 * that fires or not depending on machine load. Agent, tool, and sandbox
 * streams are per-attempt transport, not workflow semantics.
 */
export const ENGINE_INTERNAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "FrameCommitted",
  "SnapshotCaptured",
  "RunConcurrencySaturated",
  "RunOwnerAlive",
  "NodeChatStream",
  "ToolCall",
  "ToolCallStarted",
  "ToolCallFinished",
  "AgentEvent",
  "AgentSessionEvent",
  "AgentTraceEvent",
  "SandboxCreated",
  "SandboxHeartbeat",
  "SandboxBundleReceived",
  "SandboxCompleted",
  "SandboxFailed",
  "SandboxShipped",
  "SandboxDiffReviewRequested",
  "SandboxDiffAccepted",
  "SandboxDiffRejected",
  "CheckpointPublicationFailure",
]);

export type ParityEventClass = "semantic" | "engine-internal" | "unclassified";

export function classifyParityEvent(type: string): ParityEventClass {
  if (PARITY_SEMANTIC_EVENT_TYPES.has(type)) return "semantic";
  if (ENGINE_INTERNAL_EVENT_TYPES.has(type)) return "engine-internal";
  return "unclassified";
}
