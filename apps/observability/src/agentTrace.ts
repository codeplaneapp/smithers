export type AgentFamily =
  | "pi"
  | "codex"
  | "claude-code"
  | "gemini"
  | "kimi"
  | "openai"
  | "anthropic"
  | "amp"
  | "forge"
  | "unknown";

export type AgentCaptureMode =
  | "sdk-events"
  | "rpc-events"
  | "cli-json-stream"
  | "cli-json"
  | "cli-text"
  | "artifact-import";

export type TraceCompleteness =
  | "full-observed"
  | "partial-observed"
  | "final-only"
  | "capture-failed";

export type CanonicalAgentTraceEventKind =
  | "session.start"
  | "session.end"
  | "turn.start"
  | "turn.end"
  | "message.start"
  | "message.update"
  | "message.end"
  | "assistant.text.delta"
  | "assistant.thinking.delta"
  | "assistant.message.final"
  | "tool.execution.start"
  | "tool.execution.update"
  | "tool.execution.end"
  | "tool.result"
  | "retry.start"
  | "retry.end"
  | "compaction.start"
  | "compaction.end"
  | "stderr"
  | "stdout"
  | "usage"
  | "capture.warning"
  | "capture.error"
  | "artifact.created";

export type CanonicalAgentTraceEventPhase =
  | "agent"
  | "turn"
  | "message"
  | "tool"
  | "session"
  | "capture"
  | "artifact";

export type CanonicalAgentTraceEvent = {
  traceVersion: "1";
  runId: string;
  workflowPath?: string;
  workflowHash?: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  timestampMs: number;
  event: {
    sequence: number;
    kind: CanonicalAgentTraceEventKind;
    phase: CanonicalAgentTraceEventPhase;
  };
  source: {
    agentFamily: AgentFamily;
    captureMode: AgentCaptureMode;
    rawType?: string;
    rawEventId?: string;
    observed: boolean;
  };
  traceCompleteness: TraceCompleteness;
  payload: Record<string, unknown> | null;
  raw: unknown;
  redaction: {
    applied: boolean;
    ruleIds: string[];
  };
  annotations: Record<string, string | number | boolean>;
};

export type AgentTraceSummary = {
  traceVersion: "1";
  runId: string;
  workflowPath?: string;
  workflowHash?: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  traceStartedAtMs: number;
  traceFinishedAtMs: number;
  agentFamily: AgentFamily;
  agentId?: string;
  model?: string;
  captureMode: AgentCaptureMode;
  traceCompleteness: TraceCompleteness;
  unsupportedEventKinds: CanonicalAgentTraceEventKind[];
  missingExpectedEventKinds: CanonicalAgentTraceEventKind[];
  rawArtifactRefs: string[];
};

export type AgentSessionTranscriptEvent = {
  transcriptVersion: "1";
  runId: string;
  workflowPath?: string;
  workflowHash?: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  timestampMs: number;
  event: {
    sequence: number;
    rowType: string;
  };
  source: {
    agentFamily: AgentFamily;
    captureMode: AgentCaptureMode;
    ingestSource: "live" | "artifact";
    observedLive: boolean;
    providerSessionId?: string;
    providerThreadId?: string;
  };
  raw: unknown;
  redaction: {
    applied: boolean;
    ruleIds: string[];
  };
  annotations: Record<string, string | number | boolean>;
};

export type AgentTraceCapabilityProfile = {
  sessionMetadata: boolean;
  assistantTextDeltas: boolean;
  visibleThinkingDeltas: boolean;
  finalAssistantMessage: boolean;
  toolExecutionStart: boolean;
  toolExecutionUpdate: boolean;
  toolExecutionEnd: boolean;
  retryEvents: boolean;
  compactionEvents: boolean;
  rawStderrDiagnostics: boolean;
  persistedSessionArtifact: boolean;
};
