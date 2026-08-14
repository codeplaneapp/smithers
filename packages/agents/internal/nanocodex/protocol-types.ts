import type { AgentCheckpoint, AgentCheckpointJsonObject } from "../../src/AgentCheckpoint";

export type NanocodexProtocolName = "smithers.nanocodex";
export type NanocodexProtocolVersion = 1;
export type NanocodexBridgeVersion = "0.0.2";
export type NanocodexShippedTarget = "x86_64-unknown-linux-gnu" | "aarch64-apple-darwin";
export type NanocodexCheckpointCodec = "nanocodex.session-snapshot";
export type NanocodexCheckpointVersion = 1;
export type NanocodexSnapshotVersion = 1;

export type NanocodexErrorCategory =
  | "protocol"
  | "config"
  | "auth"
  | "checkpoint"
  | "workspace"
  | "provider"
  | "tool"
  | "cleanup"
  | "internal";

export type NanocodexRetryDisposition = "never" | "safe" | "after";

declare const nanocodexCancellationReasonBrand: unique symbol;

/**
 * Bridge-reflected cancellation text: 1–128 UTF-8 bytes with no control
 * characters. It remains arbitrary, untrusted upstream input and must not be
 * persisted, logged, or attached to a durable/public error.
 */
export type NanocodexCancellationReason = string & {
  readonly [nanocodexCancellationReasonBrand]: "bounded-untrusted-text";
};

export type NanocodexPublicError = {
  code: string;
  category: NanocodexErrorCategory;
  message: string;
  retry: NanocodexRetryDisposition;
  retryAfterMs?: number;
};

export type NanocodexProtocolCapabilities = {
  name: NanocodexProtocolName;
  versions: [NanocodexProtocolVersion];
};

export type NanocodexCheckpointCapabilities = {
  codec: NanocodexCheckpointCodec;
  codecVersions: [NanocodexCheckpointVersion];
  snapshotVersions: [NanocodexSnapshotVersion];
  continuationModes: ["resume"];
  resumeRequiresSameCanonicalWorkspace: true;
};

export type NanocodexFeatureCapabilities = {
  codeMode: true;
  codeModeDisable: false;
  websocketHttpsFallback: true;
  customEndpoints: false;
  mcp: false;
  subagents: false;
  steering: false;
  workspaceRelocation: false;
};

export type NanocodexProtocolLimits = {
  maxInputRecordBytes: 25165824;
  maxOutputRecordBytes: 41943040;
  maxPromptBytes: 4194304;
  maxSnapshotBytes: 15728640;
  maxEventBytes: 1048576;
  maxEventTotalBytes: 16777216;
  maxStderrBytes: 65536;
  maxCommandRecords: 256;
  maxJsonDepth: 64;
  maxJsonNodes: 262144;
  maxJsonObjectMembers: 16384;
  maxJsonArrayElements: 131072;
  maxJsonStringBytes: 18874368;
  maxJsonKeyBytes: 1024;
  maxManagedAuthFileBytes: 1048576;
};

/** The value returned by `capabilities --json` and carried by `hello.data`. */
export type NanocodexCapabilities = {
  bridgeVersion: string;
  target: NanocodexShippedTarget;
  nanocodexVersion: "0.5.0";
  protocol: NanocodexProtocolCapabilities;
  checkpoint: NanocodexCheckpointCapabilities;
  authenticationModes: ["api-key-env", "chatgpt"];
  transportModes: ["websocket"];
  models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
  defaultModel: "gpt-5.6-sol";
  thinkingLevels: ["none", "low", "medium", "high", "xhigh", "max"];
  defaultThinking: "high";
  reasoningModes: ["standard", "pro"];
  features: NanocodexFeatureCapabilities;
  limits: NanocodexProtocolLimits;
};

export type NanocodexUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  estimatedUsd: string | null;
  costStatus: string;
  serviceTier: string | null;
};

export type NanocodexWireModel = "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna";

export type NanocodexCompletedData = {
  finalMessage: string;
  usage: NanocodexUsage;
  model: NanocodexWireModel;
  snapshotVersion: NanocodexSnapshotVersion;
  snapshot: AgentCheckpointJsonObject;
  canonicalWorkspace: string;
};

export type NanocodexRecoveryData = Pick<
  NanocodexCompletedData,
  "model" | "snapshotVersion" | "snapshot" | "canonicalWorkspace"
>;

export type NanocodexServerRecordType =
  | "hello"
  | "turn.accepted"
  | "agent.event"
  | "agent.event-truncated"
  | "command.accepted"
  | "command.rejected"
  | "turn.completed"
  | "turn.failed"
  | "turn.cancelled"
  | "process.failed";

type NanocodexServerRecordBase<Type extends NanocodexServerRecordType, Data> = {
  protocol: NanocodexProtocolName;
  version: NanocodexProtocolVersion;
  type: Type;
  seq: number;
  data: Data;
};

export type NanocodexHelloRecord = NanocodexServerRecordBase<"hello", NanocodexCapabilities>;

export type NanocodexTurnAcceptedRecord = NanocodexServerRecordBase<"turn.accepted", Record<string, never>> & {
  requestId: string;
  commandId: string;
  sessionId: string;
};

export type NanocodexAssistantEventPayload = {
  modelCallIndex: number;
  itemId: string | null;
  phase: "commentary" | "final_answer" | null;
  text: string;
};

export type NanocodexProjectedLifecycleEventType =
  | "run.started"
  | "run.steered"
  | "run.error"
  | "run.completed"
  | "run.failed"
  | "model.warmup.started"
  | "model.warmup.completed"
  | "model.warmup.failed"
  | "model.call.started"
  | "model.call.completed"
  | "model.call.failed"
  | "model.compaction.started"
  | "model.compaction.completed"
  | "model.compaction.failed"
  | "model.attempt.started"
  | "model.attempt.failed"
  | "model.attempt.retrying"
  | "model.connection.started"
  | "model.connection.completed"
  | "model.connection.failed";

declare const nanocodexUnknownProjectedEventTypeBrand: unique symbol;
type NanocodexUnknownProjectedEventType = string & {
  readonly [nanocodexUnknownProjectedEventTypeBrand]: "unknown-projected-event";
};

export type NanocodexProjectedAgentEvent =
  | {
      type: "assistant.delta" | "assistant.message";
      upstreamSeq: number;
      payload: NanocodexAssistantEventPayload;
    }
  | {
      type: "tool.call";
      upstreamSeq: number;
      payload: { callId: string; tool: string; modelCallIndex: number };
    }
  | {
      type: "tool.result";
      upstreamSeq: number;
      payload: {
        callId: string;
        tool: string;
        status: "completed" | "failed" | "cancelled" | "unknown";
        durationNs: number;
        startedAfterNs: number | null;
      };
    }
  | {
      type: NanocodexProjectedLifecycleEventType;
      upstreamSeq: number;
      payload: Record<string, never>;
    }
  | {
      /** Unknown upstream kinds are the sole open v1 event projection point. */
      type: NanocodexUnknownProjectedEventType;
      upstreamSeq: number;
      payload: AgentCheckpointJsonObject;
    };

export type NanocodexAgentEventRecord = NanocodexServerRecordBase<
  "agent.event",
  { event: NanocodexProjectedAgentEvent }
> & {
  requestId: string;
  sessionId: string;
};

export type NanocodexAgentEventTruncatedRecord = NanocodexServerRecordBase<
  "agent.event-truncated",
  {
    upstreamType: string | null;
    upstreamSeq: number | null;
    reason: "event_limit" | "aggregate_event_limit" | "bridge_event_backpressure" | "event_policy";
  }
> & {
  requestId: string;
  sessionId: string;
};

export type NanocodexCommandAcceptedRecord = NanocodexServerRecordBase<
  "command.accepted",
  { command: "turn.cancel" }
> & {
  requestId: string;
  commandId: string;
  sessionId?: string;
};

export type NanocodexCommandRejectedRecord = NanocodexServerRecordBase<
  "command.rejected",
  { error: NanocodexPublicError }
> & {
  requestId: string;
  commandId: string;
  sessionId?: string;
};

export type NanocodexTurnCompletedRecord = NanocodexServerRecordBase<"turn.completed", NanocodexCompletedData> & {
  requestId: string;
  sessionId: string;
};

export type NanocodexTurnFailedRecord = NanocodexServerRecordBase<
  "turn.failed",
  { error: NanocodexPublicError; completed?: NanocodexRecoveryData }
> & {
  requestId: string;
  sessionId: string;
};

export type NanocodexTurnCancelledRecord = NanocodexServerRecordBase<
  "turn.cancelled",
  { reason: NanocodexCancellationReason }
> & {
  requestId: string;
  sessionId: string;
};

export type NanocodexProcessFailedRecord = NanocodexServerRecordBase<
  "process.failed",
  { error: NanocodexPublicError }
> & {
  requestId?: string;
};

export type NanocodexServerRecord =
  | NanocodexHelloRecord
  | NanocodexTurnAcceptedRecord
  | NanocodexAgentEventRecord
  | NanocodexAgentEventTruncatedRecord
  | NanocodexCommandAcceptedRecord
  | NanocodexCommandRejectedRecord
  | NanocodexTurnCompletedRecord
  | NanocodexTurnFailedRecord
  | NanocodexTurnCancelledRecord
  | NanocodexProcessFailedRecord;

export type NanocodexThinkingLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type NanocodexReasoningMode = "standard" | "pro";

export type NanocodexAuthConfig =
  | { mode: "api-key-env"; environmentVariable: string }
  | { mode: "chatgpt"; authFile?: string | null };

export type NanocodexTurnOptions = {
  instructions?: string | null;
  model?: NanocodexWireModel | "sol" | "terra" | "luna" | null;
  thinking?: NanocodexThinkingLevel | null;
  reasoningMode?: NanocodexReasoningMode | null;
  fastMode?: boolean | null;
};

export type NanocodexTurnContinuation = {
  mode: "resume";
  snapshot: AgentCheckpointJsonObject;
};

export type NanocodexTurnStartData = {
  prompt: string;
  workspace: string;
  auth: NanocodexAuthConfig;
  transport: { kind: "websocket" };
  options: NanocodexTurnOptions;
  continuation: NanocodexTurnContinuation | null;
};

export type NanocodexTurnStartCommand = {
  protocol: NanocodexProtocolName;
  version: NanocodexProtocolVersion;
  type: "turn.start";
  commandId: string;
  requestId: string;
  data: NanocodexTurnStartData;
};

export type NanocodexTurnCancelCommand = {
  protocol: NanocodexProtocolName;
  version: NanocodexProtocolVersion;
  type: "turn.cancel";
  commandId: string;
  requestId: string;
  sessionId?: string;
  data: { reason?: string };
};

export type NanocodexCheckpointPayload = {
  bridgeProtocolVersion: NanocodexProtocolVersion;
  nanocodexVersion: "0.5.0";
  snapshotVersion: NanocodexSnapshotVersion;
  model?: NanocodexWireModel;
  canonicalWorkspace: string;
  policyFingerprint: `sha256:${string}`;
  nanocodexSnapshot: AgentCheckpointJsonObject;
};

export type NanocodexCheckpoint = AgentCheckpoint & {
  codec: NanocodexCheckpointCodec;
  version: NanocodexCheckpointVersion;
  payload: NanocodexCheckpointPayload;
};

export type NanocodexPolicy = {
  fingerprintVersion: 1;
  instructions: string | null;
  tools: {
    profile: "nanocodex-stock-0.5.0";
    codeMode: true;
    mcp: false;
    subagents: false;
  };
};
