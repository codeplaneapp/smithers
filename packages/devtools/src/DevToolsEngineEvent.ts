/**
 * Discriminated union of Smithers engine events that {@link DevToolsRunStore}
 * understands when reducing engine state. Any other `type` value flows through
 * the open-ended tail so future event kinds can be added without changes to
 * consumers.
 */
export type DevToolsEngineEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | FrameCommittedEvent
  | NodePendingEvent
  | NodeStartedEvent
  | NodeFinishedEvent
  | NodeFailedEvent
  | NodeCancelledEvent
  | NodeSkippedEvent
  | NodeRetryingEvent
  | NodeWaitingApprovalEvent
  | NodeWaitingEventEvent
  | NodeWaitingTimerEvent
  | ToolCallStartedEvent
  | ToolCallFinishedEvent
  | UnknownEngineEvent;

type RunEventBase = {
  runId: string;
  timestampMs: number;
};

type NodeEventBase = RunEventBase & {
  nodeId: string;
  iteration: number;
};

export type RunStartedEvent = RunEventBase & { type: "RunStarted" };
export type RunFinishedEvent = RunEventBase & { type: "RunFinished" };
export type RunFailedEvent = RunEventBase & { type: "RunFailed"; error?: unknown };
export type RunCancelledEvent = RunEventBase & { type: "RunCancelled" };

export type FrameCommittedEvent = RunEventBase & {
  type: "FrameCommitted";
  frameNo: number;
};

export type NodePendingEvent = NodeEventBase & { type: "NodePending" };
export type NodeStartedEvent = NodeEventBase & {
  type: "NodeStarted";
  attempt: number;
};
export type NodeFinishedEvent = NodeEventBase & {
  type: "NodeFinished";
  attempt: number;
};
export type NodeFailedEvent = NodeEventBase & {
  type: "NodeFailed";
  attempt: number;
  error?: unknown;
};
export type NodeCancelledEvent = NodeEventBase & { type: "NodeCancelled" };
export type NodeSkippedEvent = NodeEventBase & { type: "NodeSkipped" };
export type NodeRetryingEvent = NodeEventBase & {
  type: "NodeRetrying";
  attempt: number;
};
export type NodeWaitingApprovalEvent = NodeEventBase & {
  type: "NodeWaitingApproval";
};
export type NodeWaitingEventEvent = NodeEventBase & {
  type: "NodeWaitingEvent";
};
export type NodeWaitingTimerEvent = NodeEventBase & {
  type: "NodeWaitingTimer";
};

export type ToolCallStartedEvent = NodeEventBase & {
  type: "ToolCallStarted";
  toolName: string;
  seq: number;
};
export type ToolCallFinishedEvent = NodeEventBase & {
  type: "ToolCallFinished";
  toolName: string;
  seq: number;
  status?: string;
};

/**
 * Open tail: any future engine event with the minimal shape we require
 * (`type` + `runId` + `timestampMs`). The store ignores unknown `type`s but
 * still records them in `run.events`.
 */
export type UnknownEngineEvent = {
  type: string;
  runId: string;
  timestampMs: number;
} & Record<string, unknown>;
