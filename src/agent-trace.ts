import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SmithersEvent } from "./SmithersEvent";
import type { EventBus } from "./events";
import { logErrorAwait, logInfoAwait, logWarningAwait } from "./effect/logging";
import { extractTextFromJsonValue } from "./utils/text-extraction";
import { nowMs } from "./utils/time";
import { normalizeTokenUsage } from "./utils/usage";

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
    phase:
      | "agent"
      | "turn"
      | "message"
      | "tool"
      | "session"
      | "capture"
      | "artifact";
  };
  source: {
    agentFamily: AgentFamily;
    captureMode: AgentCaptureMode;
    rawType?: string;
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

export type AgentTraceSmithersEvent = {
  type: "AgentTraceEvent";
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  trace: CanonicalAgentTraceEvent;
  timestampMs: number;
};

export type AgentTraceSummarySmithersEvent = {
  type: "AgentTraceSummary";
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  summary: AgentTraceSummary;
  timestampMs: number;
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

export const agentTraceCapabilities: Record<
  AgentFamily,
  AgentTraceCapabilityProfile
> = {
  pi: {
    sessionMetadata: true,
    assistantTextDeltas: true,
    visibleThinkingDeltas: true,
    finalAssistantMessage: true,
    toolExecutionStart: true,
    toolExecutionUpdate: true,
    toolExecutionEnd: true,
    retryEvents: true,
    compactionEvents: true,
    rawStderrDiagnostics: true,
    persistedSessionArtifact: true,
  },
  codex: {
    sessionMetadata: false,
    assistantTextDeltas: false,
    visibleThinkingDeltas: false,
    finalAssistantMessage: true,
    toolExecutionStart: false,
    toolExecutionUpdate: false,
    toolExecutionEnd: false,
    retryEvents: false,
    compactionEvents: false,
    rawStderrDiagnostics: true,
    persistedSessionArtifact: false,
  },
  "claude-code": {
    sessionMetadata: false,
    assistantTextDeltas: true,
    visibleThinkingDeltas: false,
    finalAssistantMessage: true,
    toolExecutionStart: false,
    toolExecutionUpdate: false,
    toolExecutionEnd: false,
    retryEvents: false,
    compactionEvents: false,
    rawStderrDiagnostics: true,
    persistedSessionArtifact: false,
  },
  gemini: {
    sessionMetadata: false,
    assistantTextDeltas: false,
    visibleThinkingDeltas: false,
    finalAssistantMessage: true,
    toolExecutionStart: false,
    toolExecutionUpdate: false,
    toolExecutionEnd: false,
    retryEvents: false,
    compactionEvents: false,
    rawStderrDiagnostics: true,
    persistedSessionArtifact: false,
  },
  kimi: {
    sessionMetadata: false,
    assistantTextDeltas: false,
    visibleThinkingDeltas: false,
    finalAssistantMessage: true,
    toolExecutionStart: false,
    toolExecutionUpdate: false,
    toolExecutionEnd: false,
    retryEvents: false,
    compactionEvents: false,
    rawStderrDiagnostics: true,
    persistedSessionArtifact: false,
  },
  openai: {
    sessionMetadata: false,
    assistantTextDeltas: false,
    visibleThinkingDeltas: false,
    finalAssistantMessage: true,
    toolExecutionStart: true,
    toolExecutionUpdate: false,
    toolExecutionEnd: true,
    retryEvents: false,
    compactionEvents: false,
    rawStderrDiagnostics: false,
    persistedSessionArtifact: false,
  },
  anthropic: {
    sessionMetadata: false,
    assistantTextDeltas: false,
    visibleThinkingDeltas: false,
    finalAssistantMessage: true,
    toolExecutionStart: true,
    toolExecutionUpdate: false,
    toolExecutionEnd: true,
    retryEvents: false,
    compactionEvents: false,
    rawStderrDiagnostics: false,
    persistedSessionArtifact: false,
  },
  amp: {
    sessionMetadata: false,
    assistantTextDeltas: false,
    visibleThinkingDeltas: false,
    finalAssistantMessage: true,
    toolExecutionStart: true,
    toolExecutionUpdate: false,
    toolExecutionEnd: true,
    retryEvents: false,
    compactionEvents: false,
    rawStderrDiagnostics: true,
    persistedSessionArtifact: false,
  },
  forge: {
    sessionMetadata: false,
    assistantTextDeltas: false,
    visibleThinkingDeltas: false,
    finalAssistantMessage: true,
    toolExecutionStart: true,
    toolExecutionUpdate: false,
    toolExecutionEnd: true,
    retryEvents: false,
    compactionEvents: false,
    rawStderrDiagnostics: true,
    persistedSessionArtifact: false,
  },
  unknown: {
    sessionMetadata: false,
    assistantTextDeltas: false,
    visibleThinkingDeltas: false,
    finalAssistantMessage: true,
    toolExecutionStart: true,
    toolExecutionUpdate: false,
    toolExecutionEnd: true,
    retryEvents: false,
    compactionEvents: false,
    rawStderrDiagnostics: true,
    persistedSessionArtifact: false,
  },
};

const capabilityKindMap: Array<
  [keyof AgentTraceCapabilityProfile, CanonicalAgentTraceEventKind[]]
> = [
  ["sessionMetadata", ["session.start", "session.end"]],
  ["assistantTextDeltas", ["assistant.text.delta"]],
  ["visibleThinkingDeltas", ["assistant.thinking.delta"]],
  ["finalAssistantMessage", ["assistant.message.final"]],
  ["toolExecutionStart", ["tool.execution.start"]],
  ["toolExecutionUpdate", ["tool.execution.update"]],
  ["toolExecutionEnd", ["tool.execution.end", "tool.result"]],
  ["retryEvents", ["retry.start", "retry.end"]],
  ["compactionEvents", ["compaction.start", "compaction.end"]],
  ["rawStderrDiagnostics", ["stderr"]],
  ["persistedSessionArtifact", ["artifact.created"]],
];

export function resolveAgentTraceCapabilities(
  agentFamily: AgentFamily,
  captureMode: AgentCaptureMode,
): AgentTraceCapabilityProfile {
  const base = {
    ...agentTraceCapabilities[agentFamily],
    // Smithers persists a canonical NDJSON trace artifact for every successful
    // flush regardless of the upstream agent family.
    persistedSessionArtifact: true,
  };

  if (captureMode === "sdk-events" || captureMode === "cli-text") {
    return base;
  }

  if (agentFamily === "codex") {
    return {
      ...base,
      assistantTextDeltas: captureMode === "cli-json-stream",
      toolExecutionStart: captureMode === "cli-json-stream",
      toolExecutionUpdate: captureMode === "cli-json-stream",
      toolExecutionEnd: captureMode === "cli-json-stream",
    };
  }

  if (agentFamily === "claude-code") {
    return {
      ...base,
      toolExecutionStart: captureMode === "cli-json-stream",
      toolExecutionUpdate: captureMode === "cli-json-stream",
      toolExecutionEnd: captureMode === "cli-json-stream",
    };
  }

  if (agentFamily === "gemini") {
    return {
      ...base,
      assistantTextDeltas: captureMode === "cli-json-stream",
      toolExecutionStart: captureMode === "cli-json-stream",
      toolExecutionUpdate: captureMode === "cli-json-stream",
      toolExecutionEnd: captureMode === "cli-json-stream",
    };
  }

  if (agentFamily === "kimi") {
    return {
      ...base,
      assistantTextDeltas: captureMode === "cli-json-stream",
      toolExecutionStart: captureMode === "cli-json-stream",
      toolExecutionUpdate: captureMode === "cli-json-stream",
      toolExecutionEnd: captureMode === "cli-json-stream",
    };
  }

  return base;
}

function unsupportedKindsForCapabilities(
  profile: AgentTraceCapabilityProfile,
): CanonicalAgentTraceEventKind[] {
  const kinds: CanonicalAgentTraceEventKind[] = [];
  for (const [field, mappedKinds] of capabilityKindMap) {
    if (!profile[field]) kinds.push(...mappedKinds);
  }
  return kinds;
}

export function detectAgentFamily(agent: any): AgentFamily {
  const constructorName = String(agent?.constructor?.name ?? "").toLowerCase();
  const idName = String(agent?.id ?? "").toLowerCase();
  const name =
    constructorName && constructorName !== "object"
      ? `${constructorName} ${idName}`
      : idName;
  if (name.includes("pi")) return "pi";
  if (name.includes("codex")) return "codex";
  if (name.includes("claude")) return "claude-code";
  if (name.includes("gemini")) return "gemini";
  if (name.includes("kimi")) return "kimi";
  if (name.includes("openai")) return "openai";
  if (name.includes("anthropic")) return "anthropic";
  if (name.includes("amp")) return "amp";
  if (name.includes("forge")) return "forge";
  return "unknown";
}

export function detectCaptureMode(agent: any): AgentCaptureMode {
  const family = detectAgentFamily(agent);
  const mode = agent?.opts?.mode ?? agent?.mode;
  if (family === "pi") {
    if (mode === "rpc") return "rpc-events";
    if (mode === "json") return "cli-json-stream";
    return "cli-text";
  }
  const outputFormat = agent?.opts?.outputFormat ?? agent?.outputFormat;
  if (family === "openai" || family === "anthropic") return "sdk-events";
  if (outputFormat === "stream-json") return "cli-json-stream";
  if (outputFormat === "json" || agent?.opts?.json) return "cli-json";
  return "cli-text";
}

function normalizeAnnotations(
  annotations?: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const normalized: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(annotations ?? {})) {
    if (["string", "number", "boolean"].includes(typeof value)) {
      normalized[key] = value as string | number | boolean;
    }
  }
  return normalized;
}

function redactValue(value: unknown): {
  value: unknown;
  applied: boolean;
  ruleIds: string[];
} {
  const rules: Array<{ id: string; pattern: RegExp; replace: string }> = [
    {
      id: "api-key",
      pattern: /\b(?:sk|pk)_[A-Za-z0-9_-]{8,}\b/g,
      replace: "[REDACTED_API_KEY]",
    },
    {
      id: "bearer-token",
      pattern: /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
      replace: "Bearer [REDACTED_TOKEN]",
    },
    {
      id: "auth-header",
      pattern: /"authorization"\s*:\s*"[^"]+"/gi,
      replace: '"authorization":"[REDACTED]"',
    },
    {
      id: "cookie-header",
      pattern: /"cookie"\s*:\s*"[^"]+"/gi,
      replace: '"cookie":"[REDACTED]"',
    },
    {
      id: "secret-ish",
      pattern: /\b(?:api[_-]?key|token|secret|password)=([^\s"']+)/gi,
      replace: "$&" as unknown as string,
    },
  ];
  const input =
    typeof value === "string" ? value : JSON.stringify(value ?? null);
  let next = input;
  const applied = new Set<string>();
  for (const rule of rules) {
    const replaced = next.replace(rule.pattern, (match) => {
      applied.add(rule.id);
      if (rule.id === "secret-ish") {
        const idx = match.indexOf("=");
        return `${match.slice(0, idx + 1)}[REDACTED_SECRET]`;
      }
      return rule.replace;
    });
    next = replaced;
  }
  if (applied.size === 0) return { value, applied: false, ruleIds: [] };
  if (typeof value === "string")
    return { value: next, applied: true, ruleIds: [...applied] };
  try {
    return { value: JSON.parse(next), applied: true, ruleIds: [...applied] };
  } catch {
    return { value: next, applied: true, ruleIds: [...applied] };
  }
}

function kindPhase(
  kind: CanonicalAgentTraceEventKind,
): CanonicalAgentTraceEvent["event"]["phase"] {
  if (kind.startsWith("session.")) return "session";
  if (kind.startsWith("turn.")) return "turn";
  if (kind.startsWith("message.") || kind.startsWith("assistant."))
    return "message";
  if (kind.startsWith("tool.")) return "tool";
  if (kind.startsWith("artifact.")) return "artifact";
  return "capture";
}

type PayloadKind = "message" | "tool" | "pi" | "none";

type MappedStructuredEvent = {
  kind: CanonicalAgentTraceEventKind;
  payloadKind: PayloadKind;
  expect?: CanonicalAgentTraceEventKind;
};

const piSimpleEventMap: Record<string, MappedStructuredEvent> = {
  session: { kind: "session.start", payloadKind: "pi" },
  agent_start: { kind: "session.start", payloadKind: "pi" },
  agent_end: { kind: "session.end", payloadKind: "pi" },
  turn_start: {
    kind: "turn.start",
    payloadKind: "pi",
    expect: "turn.end",
  },
  message_start: { kind: "message.start", payloadKind: "pi" },
  tool_execution_start: {
    kind: "tool.execution.start",
    payloadKind: "tool",
    expect: "tool.execution.end",
  },
  tool_execution_update: {
    kind: "tool.execution.update",
    payloadKind: "tool",
    expect: "tool.execution.end",
  },
  tool_execution_end: { kind: "tool.execution.end", payloadKind: "tool" },
  auto_compaction_start: { kind: "compaction.start", payloadKind: "pi" },
  auto_compaction_end: { kind: "compaction.end", payloadKind: "pi" },
  auto_retry_start: { kind: "retry.start", payloadKind: "pi" },
  auto_retry_end: { kind: "retry.end", payloadKind: "pi" },
};

const genericStructuredEventMap: Record<string, MappedStructuredEvent> = {
  message_start: { kind: "message.start", payloadKind: "message" },
  assistant_message_start: { kind: "message.start", payloadKind: "message" },
  "response.started": { kind: "message.start", payloadKind: "message" },
  tool_call_start: {
    kind: "tool.execution.start",
    payloadKind: "tool",
    expect: "tool.execution.end",
  },
  tool_execution_start: {
    kind: "tool.execution.start",
    payloadKind: "tool",
    expect: "tool.execution.end",
  },
  "tool_call.started": {
    kind: "tool.execution.start",
    payloadKind: "tool",
    expect: "tool.execution.end",
  },
  tool_call_delta: {
    kind: "tool.execution.update",
    payloadKind: "tool",
    expect: "tool.execution.end",
  },
  tool_call_update: {
    kind: "tool.execution.update",
    payloadKind: "tool",
    expect: "tool.execution.end",
  },
  tool_execution_update: {
    kind: "tool.execution.update",
    payloadKind: "tool",
    expect: "tool.execution.end",
  },
  "tool_call.delta": {
    kind: "tool.execution.update",
    payloadKind: "tool",
    expect: "tool.execution.end",
  },
  tool_call_end: { kind: "tool.execution.end", payloadKind: "tool" },
  tool_execution_end: { kind: "tool.execution.end", payloadKind: "tool" },
  "tool_call.completed": { kind: "tool.execution.end", payloadKind: "tool" },
  tool_result: { kind: "tool.result", payloadKind: "tool" },
  "tool_result.completed": { kind: "tool.result", payloadKind: "tool" },
};

export function canonicalTraceEventToOtelLogRecord(
  event: CanonicalAgentTraceEvent,
  context?: { agentId?: string; model?: string },
): {
  body: string;
  attributes: Record<string, unknown>;
  severity: "INFO" | "WARN" | "ERROR";
} {
  const attributes: Record<string, unknown> = {
    "smithers.trace.version": event.traceVersion,
    "run.id": event.runId,
    "workflow.path": event.workflowPath,
    "workflow.hash": event.workflowHash,
    "node.id": event.nodeId,
    "node.iteration": event.iteration,
    "node.attempt": event.attempt,
    "agent.family": event.source.agentFamily,
    "agent.id": context?.agentId,
    "agent.model": context?.model,
    "agent.capture_mode": event.source.captureMode,
    "trace.completeness": event.traceCompleteness,
    "event.kind": event.event.kind,
    "event.phase": event.event.phase,
    "event.sequence": event.event.sequence,
    "source.raw_type": event.source.rawType,
    "source.observed": event.source.observed,
  };
  for (const [key, value] of Object.entries(event.annotations)) {
    attributes[key.startsWith("custom.") ? key : `custom.${key}`] = value;
  }

  const severity =
    event.event.kind === "capture.error"
      ? "ERROR"
      : event.event.kind === "capture.warning" || event.event.kind === "stderr"
        ? "WARN"
        : "INFO";

  return {
    body: JSON.stringify({
      payload: event.payload,
      raw: event.raw,
      redaction: event.redaction,
      annotations: event.annotations,
    }),
    attributes,
    severity,
  };
}

type TraceCollectorOptions = {
  eventBus: EventBus;
  runId: string;
  workflowPath?: string | null;
  workflowHash?: string | null;
  nodeId: string;
  iteration: number;
  attempt: number;
  agent: any;
  agentId?: string;
  model?: string;
  logDir?: string;
  annotations?: Record<string, string | number | boolean>;
};

export class AgentTraceCollector {
  private readonly eventBus: EventBus;
  private readonly runId: string;
  private readonly workflowPath?: string;
  private readonly workflowHash?: string;
  private readonly nodeId: string;
  private readonly iteration: number;
  private readonly attempt: number;
  private readonly agentFamily: AgentFamily;
  private readonly captureMode: AgentCaptureMode;
  private readonly agentId?: string;
  private readonly model?: string;
  private readonly annotations: Record<string, string | number | boolean>;
  private readonly logDir?: string;
  private readonly capabilities: AgentTraceCapabilityProfile;
  private readonly startedAtMs = nowMs();
  private readonly events: CanonicalAgentTraceEvent[] = [];
  private readonly rawArtifactRefs: string[] = [];
  private readonly seenKinds = new Set<CanonicalAgentTraceEventKind>();
  private readonly directKinds = new Set<CanonicalAgentTraceEventKind>();
  private readonly expectedKinds = new Set<CanonicalAgentTraceEventKind>();
  private readonly failures: string[] = [];
  private readonly warnings: string[] = [];
  private sequence = 0;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private assistantTextBuffer = "";
  private finalText: string | null = null;
  private listener?: (event: SmithersEvent) => void;

  constructor(opts: TraceCollectorOptions) {
    this.eventBus = opts.eventBus;
    this.runId = opts.runId;
    this.workflowPath = opts.workflowPath ?? undefined;
    this.workflowHash = opts.workflowHash ?? undefined;
    this.nodeId = opts.nodeId;
    this.iteration = opts.iteration;
    this.attempt = opts.attempt;
    this.agentFamily = detectAgentFamily(opts.agent);
    this.captureMode = detectCaptureMode(opts.agent);
    this.capabilities = resolveAgentTraceCapabilities(
      this.agentFamily,
      this.captureMode,
    );
    this.agentId = opts.agentId;
    this.model = opts.model;
    this.annotations = normalizeAnnotations(opts.annotations);
    this.logDir = opts.logDir;

    const profile = this.capabilities;
    if (profile.sessionMetadata && this.agentFamily === "pi") {
      this.expectedKinds.add("session.start");
      this.expectedKinds.add("session.end");
      this.expectedKinds.add("turn.start");
      this.expectedKinds.add("turn.end");
    }
    if (profile.finalAssistantMessage)
      this.expectedKinds.add("assistant.message.final");
  }

  begin() {
    this.listener = (event) => this.observeSmithersEvent(event);
    this.eventBus.on("event", this.listener);
  }

  endListener() {
    if (this.listener) this.eventBus.off("event", this.listener);
    this.listener = undefined;
  }

  onStdout(text: string) {
    this.processChunk("stdout", text);
  }

  onStderr(text: string) {
    this.processChunk("stderr", text);
  }

  observeResult(result: any) {
    const text = String(result?.text ?? "").trim();
    if (
      text &&
      (!this.finalText ||
        (!this.seenKinds.has("assistant.text.delta") &&
          !this.seenKinds.has("assistant.message.final")))
    ) {
      this.finalText = text;
    }
    if (this.captureMode === "sdk-events" && text) {
      this.pushDerived(
        "assistant.message.final",
        { text },
        text,
      );
    }
    const usage = normalizeTokenUsage(result?.usage ?? result?.totalUsage);
    if (usage) {
      this.pushDerived(
        "usage",
        usage,
        usage,
        "usage",
      );
    }
  }

  observeError(error: unknown) {
    this.failures.push(error instanceof Error ? error.message : String(error));
    this.pushDerived(
      "capture.error",
      { error: this.failures.at(-1) },
      { error: this.failures.at(-1) },
      "error",
    );
  }

  async flush() {
    this.endListener();
    const finishedAtMs = nowMs();
    this.flushStructuredBuffers();
    if (
      this.captureMode !== "sdk-events" &&
      !this.seenKinds.has("assistant.message.final") &&
      this.finalText
    ) {
      this.pushDerived(
        "assistant.message.final",
        { text: this.finalText },
        this.finalText,
        undefined,
        false,
      );
    }
    if (
      (this.captureMode === "cli-json-stream" ||
        this.captureMode === "rpc-events") &&
      this.events.length > 0 &&
      !this.seenKinds.has("assistant.message.final") &&
      this.failures.length === 0
    ) {
      this.warnings.push(
        "structured stream ended without a terminal assistant message",
      );
      this.pushDerived(
        "capture.warning",
        { reason: "missing-terminal-event" },
        { reason: "missing-terminal-event" },
        "capture",
      );
    }

    let traceCompleteness = this.resolveCompleteness();
    let missingExpectedEventKinds = [...this.expectedKinds].filter(
      (kind) => !this.directKinds.has(kind),
    );
    this.applyTraceCompleteness(traceCompleteness);
    let summary: AgentTraceSummary = {
      traceVersion: "1",
      runId: this.runId,
      workflowPath: this.workflowPath,
      workflowHash: this.workflowHash,
      nodeId: this.nodeId,
      iteration: this.iteration,
      attempt: this.attempt,
      traceStartedAtMs: this.startedAtMs,
      traceFinishedAtMs: finishedAtMs,
      agentFamily: this.agentFamily,
      agentId: this.agentId,
      model: this.model,
      captureMode: this.captureMode,
      traceCompleteness,
      unsupportedEventKinds: unsupportedKindsForCapabilities(
        this.capabilities,
      ).filter((kind) => !this.seenKinds.has(kind)),
      missingExpectedEventKinds,
      rawArtifactRefs: this.rawArtifactRefs,
    };

    const persistedArtifact = await this.persistNdjson(summary);
    if (persistedArtifact.ok && persistedArtifact.file) {
      const artifactPath = persistedArtifact.file;
      this.rawArtifactRefs.push(artifactPath);
      this.pushDerived(
        "artifact.created",
        {
          artifactKind: "agent-trace.ndjson",
          artifactPath,
          contentType: "application/x-ndjson",
        },
        {
          artifactKind: "agent-trace.ndjson",
          artifactPath,
          contentType: "application/x-ndjson",
        },
        "artifact",
      );
      this.applyTraceCompleteness(traceCompleteness);
      summary = { ...summary, rawArtifactRefs: [...this.rawArtifactRefs] };
      await this.rewriteNdjson(artifactPath, summary);
    } else if (!persistedArtifact.ok) {
      this.warnings.push(persistedArtifact.error);
      this.pushDerived(
        "capture.warning",
        { reason: "artifact-write-failed", error: persistedArtifact.error },
        { reason: "artifact-write-failed", error: persistedArtifact.error },
        "artifact",
      );
      traceCompleteness = this.resolveCompleteness();
      missingExpectedEventKinds = [...this.expectedKinds].filter(
        (kind) => !this.directKinds.has(kind),
      );
      this.applyTraceCompleteness(traceCompleteness);
      summary = {
        ...summary,
        traceCompleteness,
        missingExpectedEventKinds,
        rawArtifactRefs: [...this.rawArtifactRefs],
      };
    }

    this.applyTraceCompleteness(traceCompleteness);
    for (const event of this.events) {
      const smithersEvent: AgentTraceSmithersEvent = {
        type: "AgentTraceEvent",
        runId: this.runId,
        nodeId: this.nodeId,
        iteration: this.iteration,
        attempt: this.attempt,
        trace: event,
        timestampMs: event.timestampMs,
      };
      await this.eventBus.emitEventQueued(
        smithersEvent as unknown as SmithersEvent,
      );
      const record = canonicalTraceEventToOtelLogRecord(event, {
        agentId: this.agentId,
        model: this.model,
      });
      if (record.severity === "ERROR") {
        await logErrorAwait(record.body, record.attributes, "agent-trace");
      } else if (record.severity === "WARN") {
        await logWarningAwait(record.body, record.attributes, "agent-trace");
      } else {
        await logInfoAwait(record.body, record.attributes, "agent-trace");
      }
    }

    await this.eventBus.emitEventQueued({
      type: "AgentTraceSummary",
      runId: this.runId,
      nodeId: this.nodeId,
      iteration: this.iteration,
      attempt: this.attempt,
      summary,
      timestampMs: finishedAtMs,
    } as unknown as SmithersEvent);
  }

  private processChunk(stream: "stdout" | "stderr", text: string) {
    if (stream === "stderr") {
      this.stderrBuffer += text;
      this.pushObserved("stderr", { text }, text, stream);
      return;
    }
    this.stdoutBuffer += text;
    if (this.captureMode === "cli-text" || this.captureMode === "sdk-events") {
      this.pushObserved("stdout", { text }, text, stream);
      return;
    }
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      this.processStructuredStdoutLine(line);
    }
  }

  private flushStructuredBuffers() {
    if (this.captureMode === "cli-text" || this.captureMode === "sdk-events") {
      this.stdoutBuffer = "";
      this.stderrBuffer = "";
      return;
    }

    const line = this.stdoutBuffer.trim();
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    if (!line) return;

    this.failures.push(`truncated structured stream: ${line.slice(0, 200)}`);
    this.pushObserved(
      "capture.error",
      { reason: "truncated-json-stream", linePreview: line.slice(0, 200) },
      line,
      "stdout",
    );
  }

  private processStructuredStdoutLine(line: string) {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.failures.push(`malformed upstream JSON: ${line.slice(0, 200)}`);
      this.pushObserved(
        "capture.error",
        { linePreview: line.slice(0, 200), reason: "malformed-json" },
        line,
        "stdout",
      );
      return;
    }
    if (this.agentFamily === "pi") {
      this.processPiEvent(parsed);
      return;
    }
    this.processGenericStructuredEvent(parsed);
  }

  private processGenericStructuredEvent(parsed: any) {
    const rawType =
      typeof parsed?.type === "string" ? parsed.type : "structured";

    if (this.agentFamily === "claude-code" && rawType === "assistant") {
      const text = this.extractGenericMessageText(parsed?.message ?? parsed);
      if (typeof text === "string" && text) {
        this.appendAssistantText(text);
        this.pushObserved(
          "assistant.text.delta",
          { text },
          parsed,
          rawType,
        );
      } else {
        this.pushObserved("stdout", { eventType: rawType }, parsed, rawType);
      }
      const usage = normalizeTokenUsage(parsed?.message?.usage);
      if (usage) {
        this.pushObserved("usage", usage, parsed, rawType);
      }
      return;
    }

    if (this.agentFamily === "claude-code" && rawType === "result") {
      const usage = normalizeTokenUsage(parsed?.usage);
      if (usage) {
        this.pushObserved("usage", usage, parsed, rawType);
      }
      const text = this.extractGenericMessageText(parsed);
      if (typeof text === "string" && text) {
        this.setFinalAssistantText(text);
        this.pushObserved(
          "assistant.message.final",
          { text },
          parsed,
          rawType,
        );
      }
      return;
    }

    if (this.agentFamily === "gemini" && rawType === "message") {
      const role = parsed?.role;
      const text = this.extractGenericMessageText(parsed);
      if (role === "assistant" && typeof text === "string" && text) {
        if (parsed?.delta) {
          this.appendAssistantText(text);
        } else {
          this.setFinalAssistantText(text);
        }
        this.pushObserved(
          parsed?.delta ? "assistant.text.delta" : "assistant.message.final",
          { text },
          parsed,
          rawType,
        );
        return;
      }
    }

    if (this.agentFamily === "gemini" && rawType === "result" && parsed?.stats) {
      const usage = normalizeTokenUsage(parsed.stats);
      if (usage) {
        this.pushObserved("usage", usage, parsed, rawType);
      }
      return;
    }

    if (this.agentFamily === "codex" && rawType === "thread.started") {
      this.pushObserved("stdout", { eventType: rawType }, parsed, rawType);
      return;
    }

    if (this.agentFamily === "codex" && rawType === "turn.started") {
      this.pushObserved("turn.start", {}, parsed, rawType);
      this.expectedKinds.add("turn.end");
      return;
    }

    if (
      this.agentFamily === "codex" &&
      rawType === "item.completed" &&
      parsed?.item?.type === "agent_message"
    ) {
      const text = this.extractGenericMessageText(parsed.item);
      if (typeof text === "string" && text) {
        this.setFinalAssistantText(text);
        this.pushObserved(
          "assistant.message.final",
          { text },
          parsed,
          rawType,
        );
        return;
      }
    }

    const mapped = genericStructuredEventMap[rawType];
    if (mapped) {
      this.pushObserved(
        mapped.kind,
        this.extractMappedPayload(parsed, mapped.payloadKind),
        parsed,
        rawType,
      );
      if (mapped.expect) this.expectedKinds.add(mapped.expect);
      return;
    }

    if (
      [
        "message_delta",
        "assistant_message.delta",
        "assistant_message_delta",
        "response.output_text.delta",
        "content_block_delta",
      ].includes(rawType)
    ) {
      const text = this.extractGenericDeltaText(parsed);
      if (typeof text === "string" && text) {
        this.appendAssistantText(text);
        this.pushObserved(
          "assistant.text.delta",
          { text },
          parsed,
          rawType,
        );
        return;
      }
    }

    if (
      [
        "thinking_delta",
        "reasoning_delta",
        "response.reasoning.delta",
      ].includes(rawType)
    ) {
      const text = this.extractGenericDeltaText(parsed);
      if (typeof text === "string" && text) {
        this.pushObserved(
          "assistant.thinking.delta",
          { text },
          parsed,
          rawType,
        );
        return;
      }
    }

    if (
      [
        "message_end",
        "assistant_message_end",
        "response.completed",
        "message_stop",
      ].includes(rawType)
    ) {
      this.pushObserved(
        "message.end",
        this.extractGenericMessagePayload(parsed),
        parsed,
        rawType,
      );
      const text = this.extractGenericMessageText(parsed);
      if (text) {
        this.setFinalAssistantText(text);
        this.pushObserved(
          "assistant.message.final",
          { text },
          parsed,
          rawType,
        );
      }
      const usage = normalizeTokenUsage(parsed?.usage);
      if (usage) {
        this.pushObserved("usage", usage, parsed, rawType);
      }
      return;
    }

    if (rawType === "turn.completed" && parsed?.usage) {
      const usage = normalizeTokenUsage(parsed.usage);
      if (usage) {
        this.pushObserved("usage", usage, parsed, rawType);
      }
      if (this.agentFamily === "codex") {
        this.pushObserved("turn.end", {}, parsed, rawType);
      }
      const text = this.extractGenericMessageText(parsed);
      if (text) {
        this.setFinalAssistantText(text);
        this.pushObserved(
          "assistant.message.final",
          { text },
          parsed,
          rawType,
        );
      }
      return;
    }

    this.pushObserved("stdout", { eventType: rawType }, parsed, rawType);
  }

  private processPiEvent(parsed: any) {
    const type = String(parsed?.type ?? "unknown");
    const simple = piSimpleEventMap[type];
    if (simple) {
      this.pushObserved(
        simple.kind,
        this.extractMappedPayload(parsed, simple.payloadKind),
        parsed,
        type,
      );
      if (simple.expect) this.expectedKinds.add(simple.expect);
      return;
    }

    if (type === "turn_end") {
      this.pushObserved("turn.end", this.extractPiPayload(parsed), parsed, type);
      const finalText = this.extractGenericMessageText(parsed?.message);
      if (finalText) {
        this.setFinalAssistantText(finalText);
        this.pushObserved(
          "assistant.message.final",
          { text: finalText },
          parsed?.message,
          type,
        );
      }
      const usage = normalizeTokenUsage(parsed?.message?.usage);
      if (usage) {
        this.pushObserved("usage", usage, parsed.message.usage, "usage");
      }
      return;
    }

    if (type === "message_end") {
      this.pushObserved("message.end", this.extractPiPayload(parsed), parsed, type);
      const finalText = this.extractGenericMessageText(parsed?.message);
      if (parsed?.message?.role === "assistant" && finalText) {
        this.setFinalAssistantText(finalText);
        this.pushObserved(
          "assistant.message.final",
          { text: finalText },
          parsed?.message,
          type,
        );
      }
      return;
    }

    if (type === "message_update") {
      const evt = parsed?.assistantMessageEvent;
      if (evt?.type === "text_delta" && typeof evt.delta === "string") {
        this.appendAssistantText(evt.delta);
        this.pushObserved(
          "assistant.text.delta",
          { text: evt.delta },
          parsed,
          evt.type,
        );
        return;
      }
      if (
        (evt?.type === "thinking_delta" || evt?.type === "reasoning_delta") &&
        typeof evt.delta === "string"
      ) {
        this.pushObserved(
          "assistant.thinking.delta",
          { text: evt.delta },
          parsed,
          evt.type,
        );
        return;
      }
      this.pushObserved("message.update", this.extractPiPayload(parsed), parsed, type);
      return;
    }

    this.pushObserved("stdout", { eventType: type }, parsed, type);
  }

  private extractGenericDeltaText(parsed: any): string | undefined {
    const candidates = [
      parsed?.delta?.text,
      parsed?.delta,
      parsed?.text,
      parsed?.content_block?.text,
      parsed?.contentBlock?.text,
      parsed?.message?.text,
      parsed?.message?.content,
      parsed?.output_text,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate) return candidate;
    }
    return undefined;
  }

  private extractGenericMessageText(parsed: any): string | undefined {
    return extractTextFromJsonValue(
      parsed?.message ?? parsed?.response ?? parsed?.item ?? parsed,
    );
  }

  private appendAssistantText(text: string) {
    this.assistantTextBuffer += text;
    this.finalText = this.assistantTextBuffer;
  }

  private setFinalAssistantText(text: string) {
    this.assistantTextBuffer = text;
    this.finalText = text;
  }

  private extractGenericMessagePayload(parsed: any): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    const role =
      parsed?.message?.role ?? parsed?.role ?? parsed?.response?.role;
    if (typeof role === "string") payload.role = role;
    const text = this.extractGenericMessageText(parsed);
    if (text) payload.text = text;
    if (parsed?.id) payload.id = parsed.id;
    return payload;
  }

  private extractGenericToolPayload(parsed: any): Record<string, unknown> {
    const tool =
      parsed?.tool ??
      parsed?.toolCall ??
      parsed?.tool_call ??
      parsed?.toolExecution ??
      parsed;
    return {
      toolCallId: tool?.id ?? tool?.toolCallId ?? parsed?.id,
      toolName: tool?.name ?? tool?.toolName ?? parsed?.toolName,
      argsPreview: tool?.args ?? tool?.arguments ?? parsed?.args,
      resultPreview: tool?.result ?? parsed?.result,
      isError: Boolean(tool?.isError ?? parsed?.isError ?? parsed?.error),
    };
  }

  private extractPiPayload(parsed: any): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    if (parsed?.message?.role) payload.role = parsed.message.role;
    const text = this.extractGenericMessageText(parsed?.message);
    if (text) payload.text = text;
    if (parsed?.id) payload.id = parsed.id;
    return payload;
  }

  private observeSmithersEvent(event: SmithersEvent) {
    const sameAttempt =
      (event as any).runId === this.runId &&
      (event as any).nodeId === this.nodeId &&
      (event as any).iteration === this.iteration &&
      (event as any).attempt === this.attempt;
    if (!sameAttempt) return;
    if (this.agentFamily === "pi") return;

    if (event.type === "ToolCallStarted") {
      this.pushDerived(
        "tool.execution.start",
        {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        },
        event,
        event.type,
      );
      this.expectedKinds.add("tool.execution.end");
    }
    if (event.type === "ToolCallFinished") {
      this.pushDerived(
        "tool.execution.end",
        {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.status === "error",
        },
        event,
        event.type,
      );
    }
    if (event.type === "TokenUsageReported") {
      this.pushDerived(
        "usage",
        {
          model: event.model,
          agent: event.agent,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheWriteTokens: event.cacheWriteTokens,
          reasoningTokens: event.reasoningTokens,
        },
        event,
        event.type,
      );
    }
  }

  private resolveCompleteness(): TraceCompleteness {
    if (this.failures.length > 0) return "capture-failed";

    const richKinds = new Set<CanonicalAgentTraceEventKind>([
      "session.start",
      "session.end",
      "turn.start",
      "turn.end",
      "message.start",
      "message.update",
      "message.end",
      "assistant.text.delta",
      "assistant.thinking.delta",
      "tool.execution.start",
      "tool.execution.update",
      "tool.execution.end",
      "tool.result",
      "retry.start",
      "retry.end",
      "compaction.start",
      "compaction.end",
    ]);
    const sawRichStructure = [...this.directKinds].some((kind) =>
      richKinds.has(kind),
    );

    const coarseCaptureMode =
      this.captureMode === "sdk-events" ||
      this.captureMode === "cli-text" ||
      this.captureMode === "cli-json";

    if (!sawRichStructure && this.warnings.length === 0 && coarseCaptureMode) {
      return "final-only";
    }

    const missing = [...this.expectedKinds].filter(
      (kind) => !this.directKinds.has(kind),
    );
    if (missing.length > 0 || this.warnings.length > 0)
      return "partial-observed";

    if (coarseCaptureMode) {
      return sawRichStructure ? "partial-observed" : "final-only";
    }

    if (!sawRichStructure) return "final-only";
    return "full-observed";
  }

  private extractMappedPayload(
    parsed: any,
    payloadKind: PayloadKind,
  ): Record<string, unknown> | null {
    if (payloadKind === "message") return this.extractGenericMessagePayload(parsed);
    if (payloadKind === "tool") return this.extractGenericToolPayload(parsed);
    if (payloadKind === "pi") return this.extractPiPayload(parsed);
    return {};
  }

  private push(
    kind: CanonicalAgentTraceEventKind,
    payload: Record<string, unknown> | null,
    raw: unknown,
    observed: boolean,
    rawType?: string,
    direct = true,
  ) {
    const redactedPayload = redactValue(payload);
    const redactedRaw = redactValue(raw);
    const event: CanonicalAgentTraceEvent = {
      traceVersion: "1",
      runId: this.runId,
      workflowPath: this.workflowPath,
      workflowHash: this.workflowHash,
      nodeId: this.nodeId,
      iteration: this.iteration,
      attempt: this.attempt,
      timestampMs: nowMs(),
      event: {
        sequence: this.sequence++,
        kind,
        phase: kindPhase(kind),
      },
      source: {
        agentFamily: this.agentFamily,
        captureMode: this.captureMode,
        rawType,
        observed,
      },
      traceCompleteness: "partial-observed",
      payload: redactedPayload.value as Record<string, unknown> | null,
      raw: redactedRaw.value,
      redaction: {
        applied: redactedPayload.applied || redactedRaw.applied,
        ruleIds: [
          ...new Set([...redactedPayload.ruleIds, ...redactedRaw.ruleIds]),
        ],
      },
      annotations: this.annotations,
    };
    this.events.push(event);
    this.seenKinds.add(kind);
    if (direct) this.directKinds.add(kind);
  }

  private pushObserved(
    kind: CanonicalAgentTraceEventKind,
    payload: Record<string, unknown> | null,
    raw: unknown,
    rawType?: string,
  ) {
    this.push(kind, payload, raw, true, rawType);
  }

  private pushDerived(
    kind: CanonicalAgentTraceEventKind,
    payload: Record<string, unknown> | null,
    raw: unknown,
    rawType?: string,
    direct = true,
  ) {
    this.push(kind, payload, raw, false, rawType, direct);
  }

  private applyTraceCompleteness(traceCompleteness: TraceCompleteness) {
    for (const event of this.events) {
      event.traceCompleteness = traceCompleteness;
    }
  }

  private async persistNdjson(
    summary: AgentTraceSummary,
  ): Promise<{ ok: true; file?: string } | { ok: false; error: string }> {
    if (!this.logDir) return { ok: true };
    const dir = join(this.logDir, "agent-trace");
    const file = join(
      dir,
      `${this.nodeId}-${this.iteration}-${this.attempt}.ndjson`,
    );
    const lines = this.events
      .map((event) => JSON.stringify(event))
      .concat(JSON.stringify({ summary }));
    try {
      await mkdir(dir, { recursive: true });
      await appendFile(file, `${lines.join("\n")}\n`, "utf8");
      return { ok: true, file };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async rewriteNdjson(file: string, summary: AgentTraceSummary) {
    const lines = this.events
      .map((event) => JSON.stringify(event))
      .concat(JSON.stringify({ summary }));
    await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  }
}
