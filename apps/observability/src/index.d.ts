import { LogLevel, Effect, Context, Metric, Layer } from 'effect';
import * as effect_Tracer from 'effect/Tracer';
import * as effect_Metric from 'effect/Metric';
import * as BunContext from '@effect/platform-bun/BunServices';

type SmithersLogFormat$1 = "json" | "pretty" | "string" | "logfmt";

type ResolvedSmithersObservabilityOptions$2 = {
    readonly enabled: boolean;
    readonly endpoint: string;
    readonly headers: Record<string, string> | undefined;
    readonly serviceName: string;
    readonly logFormat: SmithersLogFormat$1;
    readonly logLevel: LogLevel.LogLevel;
    readonly installLogger: boolean;
};

type SmithersObservabilityService$2 = {
    readonly options: ResolvedSmithersObservabilityOptions$2;
    readonly annotate: (attributes: Readonly<Record<string, unknown>>) => Effect.Effect<void>;
    readonly withSpan: <A, E, R>(name: string, effect: Effect.Effect<A, E, R>, attributes?: Readonly<Record<string, unknown>>) => Effect.Effect<A, E, Exclude<R, effect_Tracer.ParentSpan>>;
};

type SmithersObservabilityOptions$4 = {
    readonly enabled?: boolean;
    readonly endpoint?: string;
    readonly headers?: Record<string, string>;
    readonly serviceName?: string;
    readonly logFormat?: SmithersLogFormat$1;
    readonly logLevel?: LogLevel.LogLevel | string;
    readonly installLogger?: boolean;
};

type MetricLabels$1 = Readonly<Record<string, string | number | boolean>>;

type SmithersMetricType$1 = "counter" | "gauge" | "histogram";

type SmithersMetricUnit$1 = "count" | "milliseconds" | "seconds" | "bytes" | "tokens" | "ratio" | "depth";

type SmithersMetricDefinition$2 = {
    readonly key: string;
    readonly name: string;
    readonly prometheusName: string;
    readonly type: SmithersMetricType$1;
    readonly label: string;
    readonly unit?: SmithersMetricUnit$1;
    readonly labels?: readonly string[];
    readonly defaultLabels?: readonly MetricLabels$1[];
    readonly boundaries?: readonly number[];
};

type AgentFamily = "pi" | "codex" | "claude-code" | "antigravity" | "gemini" | "kimi" | "openai" | "anthropic" | "amp" | "forge" | "unknown";
type AgentCaptureMode = "sdk-events" | "rpc-events" | "cli-json-stream" | "cli-json" | "cli-text" | "artifact-import";
type TraceCompleteness = "full-observed" | "partial-observed" | "final-only" | "capture-failed";
type CanonicalAgentTraceEventKind = "session.start" | "session.end" | "turn.start" | "turn.end" | "message.start" | "message.update" | "message.end" | "assistant.text.delta" | "assistant.thinking.delta" | "assistant.message.final" | "tool.execution.start" | "tool.execution.update" | "tool.execution.end" | "tool.result" | "retry.start" | "retry.end" | "compaction.start" | "compaction.end" | "stderr" | "stdout" | "usage" | "capture.warning" | "capture.error" | "artifact.created";
type CanonicalAgentTraceEventPhase = "agent" | "turn" | "message" | "tool" | "session" | "capture" | "artifact";
type CanonicalAgentTraceEvent = {
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
type AgentTraceSummary = {
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
type AgentSessionTranscriptEvent = {
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

type RunStatus = "running" | "waiting-approval" | "waiting-event" | "waiting-timer" | "waiting-quota" | "paused" | "finished" | "continued" | "failed" | "cancelled";
type RunState = "running" | "waiting-approval" | "waiting-event" | "waiting-timer" | "waiting-quota" | "paused" | "recovering" | "stale" | "orphaned" | "failed" | "cancelled" | "succeeded" | "unknown";
type AgentCliActionKind = "turn" | "command" | "tool" | "file_change" | "web_search" | "todo_list" | "reasoning" | "warning" | "note";
type AgentCliActionPhase = "started" | "updated" | "completed";
type AgentCliEventLevel = "debug" | "info" | "warning" | "error";
type AgentCliStartedEvent = {
    type: "started";
    engine: string;
    title: string;
    resume?: string;
    detail?: Record<string, unknown>;
};
type AgentCliActionEvent = {
    type: "action";
    engine: string;
    phase: AgentCliActionPhase;
    entryType?: "thought" | "message";
    action: {
        id: string;
        kind: AgentCliActionKind;
        title: string;
        detail?: Record<string, unknown>;
    };
    message?: string;
    ok?: boolean;
    level?: AgentCliEventLevel;
};
type AgentCliCompletedEvent = {
    type: "completed";
    engine: string;
    ok: boolean;
    answer?: string;
    error?: string;
    resume?: string;
    usage?: Record<string, unknown>;
};
type AgentCliEvent = AgentCliStartedEvent | AgentCliActionEvent | AgentCliCompletedEvent;
type RunCancellationSource$1 = {
    kind: "signal" | "rpc" | "cli" | "engine";
    detail?: string;
    signal?: string;
    clientPid?: number;
    requestId?: string;
    clientIdentity?: string;
};
type SmithersEvent$2 = {
    type: "SupervisorStarted";
    runId: string;
    pollIntervalMs: number;
    staleThresholdMs: number;
    timestampMs: number;
} | {
    type: "SupervisorPollCompleted";
    runId: string;
    staleCount: number;
    resumedCount: number;
    skippedCount: number;
    durationMs: number;
    timestampMs: number;
} | {
    type: "RunAutoResumed";
    runId: string;
    lastHeartbeatAtMs: number | null;
    staleDurationMs: number;
    timestampMs: number;
} | {
    type: "RunAutoResumeSkipped";
    runId: string;
    reason: "pid-alive" | "missing-workflow" | "rate-limited";
    timestampMs: number;
} | {
    type: "RunStarted";
    runId: string;
    timestampMs: number;
} | {
    type: "RunStatusChanged";
    runId: string;
    status: RunStatus;
    timestampMs: number;
} | {
    type: "RunStateChanged";
    runId: string;
    before: RunState;
    after: RunState;
    timestampMs: number;
} | {
    type: "RunConcurrencySaturated";
    runId: string;
    requestedDemand: number;
    effectiveCap: number;
    remediationCommand: string;
    timestampMs: number;
} | {
    type: "RunFinished";
    runId: string;
    timestampMs: number;
    /**
     * Tasks that ended `failed` but were tolerated (continueOnFail / transient
     * agent failures) so the run still finished. Present only when `> 0` — the
     * run "succeeded" while these children failed. See `docs/runtime/run-state.mdx`.
     */
    failedChildren?: number;
    /** Task state keys (`nodeId::iteration`) counted by `failedChildren`. */
    failedChildKeys?: readonly string[];
} | {
    type: "RunFailed";
    runId: string;
    error: unknown;
    timestampMs: number;
} | {
    type: "RunCancelled";
    runId: string;
    timestampMs: number;
    /** Missing only on historical or unattributed cancellation events. */
    source?: RunCancellationSource$1;
} | {
    type: "RunContinuedAsNew";
    runId: string;
    newRunId: string;
    iteration: number;
    carriedStateSize: number;
    ancestryDepth?: number;
    timestampMs: number;
} | {
    type: "RunHijackRequested";
    runId: string;
    target?: string;
    timestampMs: number;
} | {
    type: "RunHijacked";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    engine: string;
    mode: "native-cli" | "conversation";
    resume?: string | null;
    cwd: string;
    timestampMs: number;
} | {
    type: "OneshotSteerQueued";
    runId: string;
    nodeId: "steer";
    messageId: string;
    message: string;
    engine: string;
    delivery: "queued";
    timestampMs: number;
} | {
    type: "OneshotSteerDelivered";
    runId: string;
    nodeId: "steer";
    messageId: string;
    engine: string;
    delivery: "delivered";
    timestampMs: number;
} | {
    type: "OneshotSteerAcknowledged";
    runId: string;
    nodeId: "steer";
    messageId: string;
    engine: string;
    delivery: "agent-acked";
    timestampMs: number;
} | {
    type: "OneshotSteerFailed";
    runId: string;
    nodeId: "steer";
    messageId: string;
    message?: string;
    engine?: string;
    delivery: "failed";
    error: string;
    resumed?: boolean;
    recoveryError?: string;
    timestampMs: number;
} | {
    type: "OneshotRestartRequested";
    runId: string;
    restartedAsRunId: string;
    priorStatus: string;
    timestampMs: number;
} | {
    type: "OneshotRestartLaunched";
    runId: string;
    restartedAsRunId: string;
    pid: number | null;
    timestampMs: number;
} | {
    type: "OneshotRestartFailed";
    runId: string;
    restartedAsRunId: string;
    error: string;
    timestampMs: number;
} | {
    type: "SandboxCreated";
    runId: string;
    sandboxId: string;
    runtime: "bubblewrap" | "docker" | "codeplane";
    configJson: string;
    timestampMs: number;
} | {
    type: "SandboxShipped";
    runId: string;
    sandboxId: string;
    runtime: "bubblewrap" | "docker" | "codeplane";
    bundleSizeBytes: number;
    timestampMs: number;
} | {
    type: "SandboxHeartbeat";
    runId: string;
    sandboxId: string;
    remoteRunId?: string;
    progress?: number;
    timestampMs: number;
} | {
    type: "SandboxBundleReceived";
    runId: string;
    sandboxId: string;
    bundleSizeBytes: number;
    patchCount: number;
    hasOutputs: boolean;
    timestampMs: number;
} | {
    type: "SandboxCompleted";
    runId: string;
    sandboxId: string;
    remoteRunId?: string;
    runtime: "bubblewrap" | "docker" | "codeplane";
    status: "finished" | "failed" | "cancelled";
    durationMs: number;
    timestampMs: number;
} | {
    type: "SandboxFailed";
    runId: string;
    sandboxId: string;
    runtime: "bubblewrap" | "docker" | "codeplane";
    error: unknown;
    timestampMs: number;
} | {
    type: "SandboxDiffReviewRequested";
    runId: string;
    sandboxId: string;
    patchCount: number;
    totalDiffLines: number;
    timestampMs: number;
} | {
    type: "SandboxDiffAccepted";
    runId: string;
    sandboxId: string;
    patchCount: number;
    timestampMs: number;
} | {
    type: "SandboxDiffRejected";
    runId: string;
    sandboxId: string;
    reason?: string;
    timestampMs: number;
} | {
    type: "FrameCommitted";
    runId: string;
    frameNo: number;
    xmlHash: string;
    trigger?: {
        reason: string;
        nodeId?: string;
        iteration?: number;
    };
    timestampMs: number;
} | {
    type: "NodePending";
    runId: string;
    nodeId: string;
    iteration: number;
    timestampMs: number;
} | {
    type: "NodeStarted";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    /** Deterministic child run launched by a childRun subflow node. */
    childRunId?: string;
    timestampMs: number;
} | {
    type: "TaskHeartbeat";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    hasData: boolean;
    dataSizeBytes: number;
    intervalMs?: number;
    timestampMs: number;
} | {
    type: "TaskHeartbeatTimeout";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    lastHeartbeatAtMs: number;
    timeoutMs: number;
    timestampMs: number;
} | {
    type: "NodeFinished";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    timestampMs: number;
} | {
    type: "NodeFailed";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    error: unknown;
    timestampMs: number;
} | {
    type: "NodeStalled";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    identicalFailures: number;
    signature: string;
    error: unknown;
    timestampMs: number;
} | {
    type: "NodeCancelled";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt?: number;
    reason?: string;
    timestampMs: number;
} | {
    type: "NodeSkipped";
    runId: string;
    nodeId: string;
    iteration: number;
    timestampMs: number;
} | {
    type: "NodeRetrying";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    timestampMs: number;
} | {
    type: "NodeWaitingApproval";
    runId: string;
    nodeId: string;
    iteration: number;
    timestampMs: number;
} | {
    type: "NodeWaitingTimer";
    runId: string;
    nodeId: string;
    iteration: number;
    firesAtMs: number;
    timestampMs: number;
} | {
    type: "ApprovalRequested";
    runId: string;
    nodeId: string;
    iteration: number;
    timestampMs: number;
} | {
    type: "ApprovalGranted";
    runId: string;
    nodeId: string;
    iteration: number;
    timestampMs: number;
} | {
    type: "ApprovalAutoApproved";
    runId: string;
    nodeId: string;
    iteration: number;
    timestampMs: number;
} | {
    type: "ApprovalDenied";
    runId: string;
    nodeId: string;
    iteration: number;
    timestampMs: number;
} | {
    type: "SteerQueued";
    runId: string;
    nodeId: string;
    steerId: string;
    message: string;
    author?: string;
    timestampMs: number;
} | {
    type: "SteerConsumed";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    steerId: string;
    timestampMs: number;
} | {
    type: "SteerExpired";
    runId: string;
    nodeId: string;
    steerId: string;
    timestampMs: number;
} | {
    type: "ToolCallStarted";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    toolCallId: string;
    toolName: string;
    seq: number;
    timestampMs: number;
} | {
    type: "ToolCallFinished";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    toolCallId: string;
    toolName: string;
    seq: number;
    status: "success" | "error";
    timestampMs: number;
} | {
    type: "NodeOutput";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    text: string;
    stream: "stdout" | "stderr";
    timestampMs: number;
} | {
    type: "AgentEvent";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    engine: string;
    event: AgentCliEvent;
    timestampMs: number;
} | {
    type: "RetryTaskStarted";
    runId: string;
    nodeId: string;
    iteration: number;
    resetDependents: boolean;
    resetNodes: string[];
    timestampMs: number;
} | {
    type: "RetryTaskFinished";
    runId: string;
    nodeId: string;
    iteration: number;
    resetNodes: string[];
    success: boolean;
    error?: string;
    timestampMs: number;
} | {
    type: "RevertStarted";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    jjPointer: string;
    timestampMs: number;
} | {
    type: "RevertFinished";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    jjPointer: string;
    success: boolean;
    error?: string;
    timestampMs: number;
} | {
    type: "TimeTravelStarted";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    jjPointer?: string;
    timestampMs: number;
} | {
    type: "TimeTravelFinished";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    jjPointer?: string;
    success: boolean;
    vcsRestored: boolean;
    resetNodes: string[];
    error?: string;
    timestampMs: number;
} | {
    type: "TimeTravelJumped";
    runId: string;
    fromFrameNo: number;
    toFrameNo: number;
    timestampMs: number;
    caller?: string;
} | {
    type: "EffectRevertStarted";
    runId: string;
    operation: string;
    kind: "tool" | "task";
    toolName: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    seq: number;
    effectStatus: "succeeded" | "unknown";
    timestampMs: number;
} | {
    type: "EffectRevertFinished";
    runId: string;
    operation: string;
    kind: "tool" | "task";
    toolName: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    seq: number;
    timestampMs: number;
} | {
    type: "EffectRevertFailed";
    runId: string;
    operation: string;
    kind: "tool" | "task";
    toolName: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    seq: number;
    error: string;
    timestampMs: number;
} | {
    type: "SideEffectBoundaryCrossed";
    runId: string;
    opId: string;
    operation: string;
    report: {
        blocking: unknown[];
        revertible: unknown[];
        warnings: unknown[];
    };
    parentRunId?: string;
    warningOnly?: boolean;
    lateCompletion?: boolean;
    archivedByOp?: string;
    timestampMs: number;
} | {
    type: "WorkflowReloadDetected";
    runId: string;
    changedFiles: string[];
    timestampMs: number;
} | {
    type: "WorkflowReloaded";
    runId: string;
    generation: number;
    changedFiles: string[];
    timestampMs: number;
} | {
    type: "WorkflowReloadFailed";
    runId: string;
    error: unknown;
    changedFiles: string[];
    timestampMs: number;
} | {
    type: "WorkflowReloadUnsafe";
    runId: string;
    reason: string;
    changedFiles: string[];
    timestampMs: number;
} | {
    type: "ScorerStarted";
    runId: string;
    nodeId: string;
    scorerId: string;
    scorerName: string;
    timestampMs: number;
} | {
    type: "ScorerFinished";
    runId: string;
    nodeId: string;
    scorerId: string;
    scorerName: string;
    score: number;
    timestampMs: number;
} | {
    type: "ScorerFailed";
    runId: string;
    nodeId: string;
    scorerId: string;
    scorerName: string;
    error: unknown;
    timestampMs: number;
} | {
    type: "TokenUsageReported";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    model: string;
    agent: string;
    inputTokens: number;
    /** Non-cached input tokens. Falls back to inputTokens when the provider omits the breakdown. */
    freshInputTokens?: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    /** Estimated USD cost from Smithers' built-in model price table. */
    costUsd?: number;
    timestampMs: number;
} | {
    type: "SnapshotCaptured";
    runId: string;
    frameNo: number;
    contentHash: string;
    timestampMs: number;
} | {
    type: "RunForked";
    runId: string;
    parentRunId: string;
    parentFrameNo: number;
    branchLabel?: string;
    timestampMs: number;
} | {
    type: "ReplayStarted";
    runId: string;
    parentRunId: string;
    parentFrameNo: number;
    restoreVcs: boolean;
    timestampMs: number;
} | {
    type: "MemoryFactSet";
    runId: string;
    namespace: string;
    key: string;
    timestampMs: number;
} | {
    type: "MemoryRecalled";
    runId: string;
    namespace: string;
    query: string;
    resultCount: number;
    timestampMs: number;
} | {
    type: "MemoryMessageSaved";
    runId: string;
    threadId: string;
    role: string;
    timestampMs: number;
} | {
    type: "OpenApiToolCalled";
    runId: string;
    operationId: string;
    method: string;
    path: string;
    durationMs: number;
    status: "success" | "error";
    timestampMs: number;
} | {
    type: "TimerCreated";
    runId: string;
    timerId: string;
    firesAtMs: number;
    timerType: "duration" | "absolute";
    timestampMs: number;
} | {
    type: "TimerFired";
    runId: string;
    timerId: string;
    firesAtMs: number;
    firedAtMs: number;
    delayMs: number;
    timestampMs: number;
} | {
    type: "TimerCancelled";
    runId: string;
    timerId: string;
    timestampMs: number;
} | {
    type: "AgentTraceEvent";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    trace: CanonicalAgentTraceEvent;
    timestampMs: number;
} | {
    type: "AgentTraceSummary";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    summary: AgentTraceSummary;
    timestampMs: number;
} | {
    type: "AgentSessionEvent";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    transcript: AgentSessionTranscriptEvent;
    timestampMs: number;
};

type MetricName = string;

type SmithersMetricEvent = {
    readonly type: string;
    readonly [key: string]: unknown;
};
type CounterEntry = {
    readonly type: "counter";
    value: number;
    readonly labels: MetricLabels$1;
};
type GaugeEntry = {
    readonly type: "gauge";
    value: number;
    readonly labels: MetricLabels$1;
};
type HistogramEntry = {
    readonly type: "histogram";
    sum: number;
    count: number;
    readonly labels: MetricLabels$1;
    readonly buckets: Map<number, number>;
};
type MetricEntry = CounterEntry | GaugeEntry | HistogramEntry;
type MetricsSnapshot$1 = ReadonlyMap<string, MetricEntry>;
type MetricsServiceShape$3 = {
    readonly increment: (name: MetricName, labels?: MetricLabels$1) => Effect.Effect<void>;
    readonly incrementBy: (name: MetricName, value: number, labels?: MetricLabels$1) => Effect.Effect<void>;
    readonly gauge: (name: MetricName, value: number, labels?: MetricLabels$1) => Effect.Effect<void>;
    readonly histogram: (name: MetricName, value: number, labels?: MetricLabels$1) => Effect.Effect<void>;
    readonly recordEvent: (event: SmithersMetricEvent) => Effect.Effect<void>;
    readonly updateProcessMetrics: () => Effect.Effect<void>;
    readonly updateAsyncExternalWaitPending: (kind: "approval" | "event", delta: number) => Effect.Effect<void>;
    readonly renderPrometheus: () => Effect.Effect<string>;
    readonly snapshot: () => Effect.Effect<MetricsSnapshot$1>;
};

type CorrelationContext$5 = {
    runId: string;
    nodeId?: string;
    iteration?: number;
    attempt?: number;
    workflowName?: string;
    parentRunId?: string;
    traceId?: string;
    spanId?: string;
};

type CorrelationPatch$5 = Partial<CorrelationContext$5> | undefined | null;

type MetricsService = Context.ServiceClass.Shape<"MetricsService", MetricsServiceShape$2>;
declare const MetricsService: Context.ServiceClass<MetricsService, "MetricsService", MetricsServiceShape$2>;
type MetricsServiceShape$2 = MetricsServiceShape$3;

type SmithersObservability = Context.ServiceClass.Shape<"SmithersObservability", SmithersObservabilityService$1>;
declare const SmithersObservability: Context.ServiceClass<SmithersObservability, "SmithersObservability", SmithersObservabilityService$1>;
type SmithersObservabilityService$1 = SmithersObservabilityService$2;

declare const prometheusContentType: "text/plain; version=0.0.4; charset=utf-8";

declare namespace smithersSpanNames {
    let run: string;
    let task: string;
    let agent: string;
    let tool: string;
}

/**
 * @returns {import("effect/Tracer").AnySpan | undefined}
 */
declare function getCurrentSmithersTraceSpan(): effect_Tracer.AnySpan | undefined;

/**
 * @returns {| Readonly<Record<string, string>> | undefined}
 */
declare function getCurrentSmithersTraceAnnotations(): Readonly<Record<string, string>> | undefined;

/**
 * @typedef {Readonly<Record<string, unknown>>} SmithersSpanAttributesInput
 */
/**
 * @param {SmithersSpanAttributesInput} [attributes]
 * @returns {Record<string, unknown>}
 */
declare function makeSmithersSpanAttributes(attributes?: SmithersSpanAttributesInput): Record<string, unknown>;
type SmithersSpanAttributesInput = Readonly<Record<string, unknown>>;

/**
 * @param {Readonly<Record<string, unknown>>} [attributes]
 * @returns {Effect.Effect<void>}
 */
declare function annotateSmithersTrace(attributes?: Readonly<Record<string, unknown>>): Effect.Effect<void>;

/**
 * @template A, E, R
 * @param {string} name
 * @param {Effect.Effect<A, E, R>} effect
 * @param {Readonly<Record<string, unknown>>} [attributes]
 * @param {Omit<import("effect/Tracer").SpanOptions, "attributes" | "kind"> & { readonly kind?: import("effect/Tracer").SpanKind; }} [_options]
 * @returns {Effect.Effect<A, E, Exclude<R, import("effect/Tracer").ParentSpan>>}
 */
declare function withSmithersSpan<A, E, R>(name: string, effect: Effect.Effect<A, E, R>, attributes?: Readonly<Record<string, unknown>>, _options?: Omit<effect_Tracer.SpanOptions, "attributes" | "kind"> & {
    readonly kind?: effect_Tracer.SpanKind;
}): Effect.Effect<A, E, Exclude<R, effect_Tracer.ParentSpan>>;

type SmithersMetricType = "counter" | "gauge" | "histogram";

type SmithersMetricUnit = "count" | "milliseconds" | "seconds" | "bytes" | "tokens" | "ratio" | "depth";

type SmithersMetricDefinition$1 = {
    readonly key: string;
    readonly metric: Metric.Metric<any, any>;
    readonly name: string;
    readonly prometheusName: string;
    readonly type: SmithersMetricType;
    readonly label: string;
    readonly unit?: SmithersMetricUnit;
    readonly description?: string;
    readonly labels?: readonly string[];
    readonly boundaries?: readonly number[];
    readonly defaultLabels?: readonly Readonly<Record<string, string>>[];
};

/**
 * @returns {string}
 */
declare function renderPrometheusMetrics(): string;

/**
 * @param {SmithersObservabilityOptions} [options]
 * @returns {ResolvedSmithersObservabilityOptions}
 */
declare function resolveSmithersObservabilityOptions(options?: SmithersObservabilityOptions$3): ResolvedSmithersObservabilityOptions$1;
type ResolvedSmithersObservabilityOptions$1 = ResolvedSmithersObservabilityOptions$2;
type SmithersObservabilityOptions$3 = SmithersObservabilityOptions$4;

declare const smithersMetrics: {
    [k: string]: effect_Metric.Metric<any, any>;
};

/** @type {Layer.Layer<MetricsService, never, never>} */
declare const MetricsServiceLive: Layer.Layer<MetricsService, never, never>;

/** @typedef {import("./SmithersObservabilityOptions.ts").SmithersObservabilityOptions} SmithersObservabilityOptions */
/**
 * @param {SmithersObservabilityOptions} [options]
 */
declare function createSmithersOtelLayer(options?: SmithersObservabilityOptions$2): Layer.Layer<never, never, never>;
type SmithersObservabilityOptions$2 = SmithersObservabilityOptions$4;

type TracingServiceShape$1 = {
    readonly withSpan: <A, E, R>(name: string, effect: Effect.Effect<A, E, R>, attributes?: Record<string, unknown>) => Effect.Effect<A, E, R>;
    readonly annotate: (attributes: Record<string, unknown>) => Effect.Effect<void>;
    readonly withCorrelation: <A, E, R>(context: CorrelationPatch$5, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
};

type TracingService = Context.ServiceClass.Shape<"TracingService", TracingServiceShape>;
declare const TracingService: Context.ServiceClass<TracingService, "TracingService", TracingServiceShape>;
/** @type {Layer.Layer<TracingService, never, never>} */
declare const TracingServiceLive: Layer.Layer<TracingService, never, never>;
type TracingServiceShape = TracingServiceShape$1;

/**
 * @param {SmithersObservabilityOptions} [options]
 */
declare function createSmithersObservabilityLayer(options?: SmithersObservabilityOptions$1): Layer.Layer<MetricsService | TracingService | SmithersObservability | BunContext.BunServices, never, never>;
type SmithersObservabilityOptions$1 = SmithersObservabilityOptions$4;

declare const createSmithersRuntimeLayer: typeof createSmithersObservabilityLayer;

/**
 * @param {string} name
 * @returns {string}
 */
declare function toPrometheusMetricName(name: string): string;

/**
 * @returns {Effect.Effect<void>}
 */
declare function updateProcessMetrics(): Effect.Effect<void>;

/**
 * @param {SmithersEvent} event
 * @returns {Effect.Effect<void>}
 */
declare function trackEvent(event: SmithersEvent$1): Effect.Effect<void>;
type SmithersEvent$1 = SmithersEvent$2;

declare const smithersMetricCatalog: SmithersMetricDefinition$1[];

/** @type {MetricsServiceShape} */
declare const metricsServiceAdapter: MetricsServiceShape$1;
type MetricsServiceShape$1 = MetricsServiceShape$3;

declare const runsTotal: Metric.Counter<number>;

declare const nodesStarted: Metric.Counter<number>;

declare const nodesFinished: Metric.Counter<number>;

declare const nodesFailed: Metric.Counter<number>;

declare const toolCallsTotal: Metric.Counter<number>;

declare const cacheHits: Metric.Counter<number>;

declare const cacheMisses: Metric.Counter<number>;

declare const dbRetries: Metric.Counter<number>;

declare const dbTransactionRollbacks: Metric.Counter<number>;

declare const dbTransactionRetries: Metric.Counter<number>;

declare const hotReloads: Metric.Counter<number>;

declare const hotReloadFailures: Metric.Counter<number>;

declare const httpRequests: Metric.Counter<number>;

declare const approvalsRequested: Metric.Counter<number>;

declare const approvalsGranted: Metric.Counter<number>;

declare const approvalsDenied: Metric.Counter<number>;

declare const timersCreated: Metric.Counter<number>;

declare const timersFired: Metric.Counter<number>;

declare const timersCancelled: Metric.Counter<number>;

declare const sandboxCreatedTotal: Metric.Counter<number>;

declare const sandboxCompletedTotal: Metric.Counter<number>;

declare const scorerEventsStarted: Metric.Counter<number>;

declare const scorerEventsFinished: Metric.Counter<number>;

declare const scorerEventsFailed: Metric.Counter<number>;

declare const tokensInputTotal: Metric.Counter<number>;

declare const tokensOutputTotal: Metric.Counter<number>;

declare const tokensCacheReadTotal: Metric.Counter<number>;

declare const tokensCacheWriteTotal: Metric.Counter<number>;

declare const tokensReasoningTotal: Metric.Counter<number>;

declare const tokensContextWindowBucketTotal: Metric.Counter<number>;

declare const runsFinishedTotal: Metric.Counter<number>;

declare const runsFailedTotal: Metric.Counter<number>;

declare const runsCancelledTotal: Metric.Counter<number>;

declare const runsResumedTotal: Metric.Counter<number>;

declare const runsContinuedTotal: Metric.Counter<number>;

declare const errorsTotal: Metric.Counter<number>;

declare const nodeRetriesTotal: Metric.Counter<number>;

declare const toolCallErrorsTotal: Metric.Counter<number>;

declare const toolOutputTruncatedTotal: Metric.Counter<number>;

declare const eventsEmittedTotal: Metric.Counter<number>;

declare const snapshotsCaptured: Metric.Counter<number>;

declare const runForksCreated: Metric.Counter<number>;

declare const replaysStarted: Metric.Counter<number>;

declare const activeRuns: Metric.Gauge<number>;

declare const activeNodes: Metric.Gauge<number>;

declare const schedulerQueueDepth: Metric.Gauge<number>;

declare const sandboxActive: Metric.Gauge<number>;

declare const approvalPending: Metric.Gauge<number>;

declare const externalWaitAsyncPending: Metric.Gauge<number>;

declare const timersPending: Metric.Gauge<number>;

declare const schedulerConcurrencyUtilization: Metric.Gauge<number>;

declare const processUptimeSeconds: Metric.Gauge<number>;

declare const processMemoryRssBytes: Metric.Gauge<number>;

declare const processHeapUsedBytes: Metric.Gauge<number>;

declare const nodeDuration: Metric.Histogram<number>;

declare const attemptDuration: Metric.Histogram<number>;

declare const toolDuration: Metric.Histogram<number>;

declare const dbQueryDuration: Metric.Histogram<number>;

declare const dbTransactionDuration: Metric.Histogram<number>;

declare const httpRequestDuration: Metric.Histogram<number>;

declare const hotReloadDuration: Metric.Histogram<number>;

declare const vcsDuration: Metric.Histogram<number>;

declare const tokensInputPerCall: Metric.Histogram<number>;

declare const tokensOutputPerCall: Metric.Histogram<number>;

declare const tokensContextWindowPerCall: Metric.Histogram<number>;

declare const runDuration: Metric.Histogram<number>;

declare const promptSizeBytes: Metric.Histogram<number>;

declare const responseSizeBytes: Metric.Histogram<number>;

declare const approvalWaitDuration: Metric.Histogram<number>;

declare const timerDelayDuration: Metric.Histogram<number>;

declare const schedulerWaitDuration: Metric.Histogram<number>;

declare const runsAncestryDepth: Metric.Histogram<number>;

declare const runsCarriedStateBytes: Metric.Histogram<number>;

declare const sandboxDurationMs: Metric.Histogram<number>;

declare const sandboxBundleSizeBytes: Metric.Histogram<number>;

declare const sandboxTransportDurationMs: Metric.Histogram<number>;

declare const sandboxPatchCount: Metric.Histogram<number>;

declare const snapshotDuration: Metric.Histogram<number>;

declare const rewindTotal: Metric.Counter<number>;

declare const rewindRollbackTotal: Metric.Counter<number>;

declare const rewindDurationMs: Metric.Histogram<number>;

declare const rewindFramesDeleted: Metric.Histogram<number>;

declare const rewindSandboxesReverted: Metric.Histogram<number>;

declare const correlationContextFiberRef: Context.Reference<undefined>;

type CorrelationContextServiceShape$1 = {
    readonly current: () => Effect.Effect<CorrelationContext$5 | undefined>;
    readonly withCorrelation: <A, E, R>(patch: CorrelationPatch$5, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly toLogAnnotations: (context?: CorrelationContext$5 | null) => Record<string, unknown> | undefined;
};

type CorrelationContextService = Context.ServiceClass.Shape<"CorrelationContextService", CorrelationContextServiceShape>;
declare const CorrelationContextService: Context.ServiceClass<CorrelationContextService, "CorrelationContextService", CorrelationContextServiceShape>;
type CorrelationContextServiceShape = CorrelationContextServiceShape$1;

/** @type {Layer.Layer<CorrelationContextService, never, never>} */
declare const CorrelationContextLive: Layer.Layer<CorrelationContextService, never, never>;

/**
 * @param {CorrelationContext | null} [base]
 * @param {CorrelationPatch} [patch]
 * @returns {CorrelationContext | undefined}
 */
declare function mergeCorrelationContext(base?: CorrelationContext$4 | null, patch?: CorrelationPatch$4): CorrelationContext$4 | undefined;
type CorrelationContext$4 = CorrelationContext$5;
type CorrelationPatch$4 = CorrelationPatch$5;

/** @typedef {import("./CorrelationContext.ts").CorrelationContext} CorrelationContext */
/**
 * @returns {CorrelationContext | undefined}
 */
declare function getCurrentCorrelationContext(): CorrelationContext$3 | undefined;
type CorrelationContext$3 = CorrelationContext$5;

/** @typedef {import("./CorrelationContext.ts").CorrelationContext} CorrelationContext */
/**
 * @returns {Effect.Effect< CorrelationContext | undefined >}
 */
declare function getCurrentCorrelationContextEffect(): Effect.Effect<CorrelationContext$2 | undefined>;
type CorrelationContext$2 = CorrelationContext$5;

/** @typedef {import("./CorrelationPatch.ts").CorrelationPatch} CorrelationPatch */
/**
 * @template T
 * @param {CorrelationPatch} patch
 * @param {() => T} fn
 * @returns {T}
 */
declare function runWithCorrelationContext<T>(patch: CorrelationPatch$3, fn: () => T): T;
type CorrelationPatch$3 = CorrelationPatch$5;

/** @typedef {import("./CorrelationPatch.ts").CorrelationPatch} CorrelationPatch */
/**
 * Bridge the Effect-tracked correlation context onto the imperative
 * AsyncLocalStorage store so plain (non-Effect) `getCurrentCorrelationContext()`
 * reads — e.g. from the imperative logger — see the active run/node correlation
 * while the effect executes.
 *
 * IMPORTANT: run the resulting effect with `Effect.runPromise`/`runFork`, never
 * `Effect.runSync`. The acquire step calls `AsyncLocalStorage.enterWith()`, which
 * mutates the *caller's* async context. Under `runSync` the caller is whatever
 * synchronous context invoked it (e.g. a test-runner's root context); enabling
 * ALS async-hooks there leaks into every subsequent timer/promise on that
 * context. `runPromise`/`runFork` execute on an ephemeral fiber context, keeping
 * the enterWith scoped to that fiber.
 *
 * @template A, E, R
 * @param {Effect.Effect<A, E, R>} effect
 * @param {CorrelationPatch} patch
 */
declare function withCorrelationContext<A, E, R>(effect: Effect.Effect<A, E, R>, patch: CorrelationPatch$2): Effect.Effect<A, E, R>;
type CorrelationPatch$2 = CorrelationPatch$5;

/**
 * @template A, E, R
 * @param {Effect.Effect<A, E, R>} effect
 */
declare function withCurrentCorrelationContext<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;

/** @typedef {import("./CorrelationContext.ts").CorrelationContext} CorrelationContext */
/**
 * @param {CorrelationContext | null} [context]
 * @returns {Record<string, unknown> | undefined}
 */
declare function correlationContextToLogAnnotations(context?: CorrelationContext$1 | null): Record<string, unknown> | undefined;
type CorrelationContext$1 = CorrelationContext$5;

/**
 * Temporary compatibility shim for legacy, non-Effect callers.
 *
 * Unlike the FiberRef-based core implementation
 * ({@link import("./_coreCorrelation/updateCurrentCorrelationContext.js").updateCurrentCorrelationContext}),
 * which returns an Effect and sets a fresh merged context on the
 * `correlationContextFiberRef`, this shim runs synchronously and applies the
 * patch by **mutating the current context object in place** via
 * `Object.assign(current, next)`. Any references already holding the current
 * context object will observe the mutation. This in-place semantics is
 * intentional and exists only to preserve behavior for callers that captured a
 * context reference before the Effect-based API existed.
 *
 * If there is no current context, the patch is a no-op (nothing is created).
 *
 * @deprecated Prefer the Effect-returning
 * `updateCurrentCorrelationContext` from
 * `@smthrs/observability` (the `_coreCorrelation` version),
 * which does not mutate shared state. This shim will be removed once legacy
 * callers migrate.
 *
 * @param {CorrelationPatch} patch
 * @returns {void}
 */
declare function updateCurrentCorrelationContext(patch: CorrelationPatch$1): void;
type CorrelationPatch$1 = CorrelationPatch$5;

/**
 * Install the Effect runtime used by fire-and-forget observability logs.
 * Returns a restore function so tests and embedded hosts can scope overrides.
 *
 * @param {SmithersLogRunner | null} runner
 * @returns {() => void}
 */
declare function setSmithersLogRunner(runner: SmithersLogRunner | null): () => void;
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
declare function logDebug(message: string, annotations?: LogAnnotations, span?: string): void;
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
declare function logInfo(message: string, annotations?: LogAnnotations, span?: string): void;
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
declare function logWarning(message: string, annotations?: LogAnnotations, span?: string): void;
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
declare function logError(message: string, annotations?: LogAnnotations, span?: string): void;
type SmithersLogRunner = {
    runFork: (effect: Effect.Effect<void, never, never>) => unknown;
    runPromise: (effect: Effect.Effect<void, never, never>) => Promise<void>;
};
type LogAnnotations = Record<string, unknown> | undefined;

type CorrelationContext = CorrelationContext$5;
type CorrelationPatch = CorrelationPatch$5;
type CorrelationContextPatch = CorrelationPatch;
type MetricLabels = MetricLabels$1;
type MetricsServiceShape = MetricsServiceShape$3;
type MetricsSnapshot = MetricsSnapshot$1;
type ResolvedSmithersObservabilityOptions = ResolvedSmithersObservabilityOptions$2;
type RunCancellationSource = RunCancellationSource$1;
type SmithersEvent = SmithersEvent$2;
type SmithersLogFormat = SmithersLogFormat$1;
type SmithersMetricDefinition = SmithersMetricDefinition$2;
type SmithersObservabilityOptions = SmithersObservabilityOptions$4;
type SmithersObservabilityService = SmithersObservabilityService$2;

export { type CorrelationContext, CorrelationContextLive, type CorrelationContextPatch, CorrelationContextService, type CorrelationPatch, type MetricLabels, MetricsService, MetricsServiceLive, type MetricsServiceShape, type MetricsSnapshot, type ResolvedSmithersObservabilityOptions, type RunCancellationSource, type SmithersEvent, type SmithersLogFormat, type SmithersMetricDefinition, SmithersObservability, type SmithersObservabilityOptions, type SmithersObservabilityService, TracingService, TracingServiceLive, activeNodes, activeRuns, annotateSmithersTrace, approvalPending, approvalWaitDuration, approvalsDenied, approvalsGranted, approvalsRequested, attemptDuration, cacheHits, cacheMisses, correlationContextFiberRef, correlationContextToLogAnnotations, createSmithersObservabilityLayer, createSmithersOtelLayer, createSmithersRuntimeLayer, dbQueryDuration, dbRetries, dbTransactionDuration, dbTransactionRetries, dbTransactionRollbacks, errorsTotal, eventsEmittedTotal, externalWaitAsyncPending, getCurrentCorrelationContext, getCurrentCorrelationContextEffect, getCurrentSmithersTraceAnnotations, getCurrentSmithersTraceSpan, hotReloadDuration, hotReloadFailures, hotReloads, httpRequestDuration, httpRequests, logDebug, logError, logInfo, logWarning, makeSmithersSpanAttributes, mergeCorrelationContext, metricsServiceAdapter, nodeDuration, nodeRetriesTotal, nodesFailed, nodesFinished, nodesStarted, processHeapUsedBytes, processMemoryRssBytes, processUptimeSeconds, prometheusContentType, promptSizeBytes, renderPrometheusMetrics, replaysStarted, resolveSmithersObservabilityOptions, responseSizeBytes, rewindDurationMs, rewindFramesDeleted, rewindRollbackTotal, rewindSandboxesReverted, rewindTotal, runDuration, runForksCreated, runWithCorrelationContext, runsAncestryDepth, runsCancelledTotal, runsCarriedStateBytes, runsContinuedTotal, runsFailedTotal, runsFinishedTotal, runsResumedTotal, runsTotal, sandboxActive, sandboxBundleSizeBytes, sandboxCompletedTotal, sandboxCreatedTotal, sandboxDurationMs, sandboxPatchCount, sandboxTransportDurationMs, schedulerConcurrencyUtilization, schedulerQueueDepth, schedulerWaitDuration, scorerEventsFailed, scorerEventsFinished, scorerEventsStarted, setSmithersLogRunner, smithersMetricCatalog, smithersMetrics, smithersSpanNames, snapshotDuration, snapshotsCaptured, timerDelayDuration, timersCancelled, timersCreated, timersFired, timersPending, toPrometheusMetricName, tokensCacheReadTotal, tokensCacheWriteTotal, tokensContextWindowBucketTotal, tokensContextWindowPerCall, tokensInputPerCall, tokensInputTotal, tokensOutputPerCall, tokensOutputTotal, tokensReasoningTotal, toolCallErrorsTotal, toolCallsTotal, toolDuration, toolOutputTruncatedTotal, trackEvent as trackSmithersEvent, updateCurrentCorrelationContext, updateProcessMetrics, vcsDuration, withCorrelationContext, withCurrentCorrelationContext, withSmithersSpan };
