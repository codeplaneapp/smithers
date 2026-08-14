import { Effect, Metric } from 'effect';

type SmithersMetricUnit$2 = "count" | "milliseconds" | "seconds" | "bytes" | "tokens" | "ratio" | "depth";

type SmithersMetricType$2 = "counter" | "gauge" | "histogram";

type MetricLabels = Readonly<Record<string, string | number | boolean>>;

type SmithersMetricDefinition$2 = {
    readonly key: string;
    readonly name: string;
    readonly prometheusName: string;
    readonly type: SmithersMetricType$2;
    readonly label: string;
    readonly unit?: SmithersMetricUnit$2;
    readonly labels?: readonly string[];
    readonly defaultLabels?: readonly MetricLabels[];
    readonly boundaries?: readonly number[];
};

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
 * @param {"approval" | "event"} kind
 * @param {number} delta
 * @returns {Effect.Effect<void>}
 */
declare function updateAsyncExternalWaitPending(kind: "approval" | "event", delta: number): Effect.Effect<void>;

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
type SmithersEvent$1 = SmithersEvent$2;

/**
 * @param {SmithersEvent} event
 * @returns {Effect.Effect<void>}
 */
declare function trackEvent(event: SmithersEvent): Effect.Effect<void>;
type SmithersEvent = SmithersEvent$1;

type SmithersMetricType$1 = "counter" | "gauge" | "histogram";

type SmithersMetricUnit$1 = "count" | "milliseconds" | "seconds" | "bytes" | "tokens" | "ratio" | "depth";

type SmithersMetricDefinition$1 = {
    readonly key: string;
    readonly metric: Metric.Metric<any, any>;
    readonly name: string;
    readonly prometheusName: string;
    readonly type: SmithersMetricType$1;
    readonly label: string;
    readonly unit?: SmithersMetricUnit$1;
    readonly description?: string;
    readonly labels?: readonly string[];
    readonly boundaries?: readonly number[];
    readonly defaultLabels?: readonly Readonly<Record<string, string>>[];
};

declare const smithersMetricCatalog: SmithersMetricDefinition$1[];

declare const smithersMetricCatalogByKey: Map<string, SmithersMetricDefinition$1>;

declare const smithersMetricCatalogByName: Map<string, SmithersMetricDefinition$1>;

declare const smithersMetricCatalogByPrometheusName: Map<string, SmithersMetricDefinition$1>;

type MetricName = string;

type SmithersMetricEvent = {
    readonly type: string;
    readonly [key: string]: unknown;
};
type CounterEntry = {
    readonly type: "counter";
    value: number;
    readonly labels: MetricLabels;
};
type GaugeEntry = {
    readonly type: "gauge";
    value: number;
    readonly labels: MetricLabels;
};
type HistogramEntry = {
    readonly type: "histogram";
    sum: number;
    count: number;
    readonly labels: MetricLabels;
    readonly buckets: Map<number, number>;
};
type MetricEntry = CounterEntry | GaugeEntry | HistogramEntry;
type MetricsSnapshot = ReadonlyMap<string, MetricEntry>;
type MetricsServiceShape$1 = {
    readonly increment: (name: MetricName, labels?: MetricLabels) => Effect.Effect<void>;
    readonly incrementBy: (name: MetricName, value: number, labels?: MetricLabels) => Effect.Effect<void>;
    readonly gauge: (name: MetricName, value: number, labels?: MetricLabels) => Effect.Effect<void>;
    readonly histogram: (name: MetricName, value: number, labels?: MetricLabels) => Effect.Effect<void>;
    readonly recordEvent: (event: SmithersMetricEvent) => Effect.Effect<void>;
    readonly updateProcessMetrics: () => Effect.Effect<void>;
    readonly updateAsyncExternalWaitPending: (kind: "approval" | "event", delta: number) => Effect.Effect<void>;
    readonly renderPrometheus: () => Effect.Effect<string>;
    readonly snapshot: () => Effect.Effect<MetricsSnapshot>;
};

/** @type {MetricsServiceShape} */
declare const metricsServiceAdapter: MetricsServiceShape;
type MetricsServiceShape = MetricsServiceShape$1;

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

declare const alertsFiredTotal: Metric.Counter<number>;

declare const alertsAcknowledgedTotal: Metric.Counter<number>;

declare const alertsResolvedTotal: Metric.Counter<number>;

declare const alertsSilencedTotal: Metric.Counter<number>;

declare const alertsReopenedTotal: Metric.Counter<number>;

declare const alertsEscalatedTotal: Metric.Counter<number>;

declare const alertDeliveriesAttempted: Metric.Counter<number>;

declare const alertDeliveriesSuppressed: Metric.Counter<number>;

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

declare const supervisorPollsTotal: Metric.Counter<number>;

declare const supervisorStaleDetected: Metric.Counter<number>;

declare const supervisorResumedTotal: Metric.Counter<number>;

declare const supervisorSkippedTotal: Metric.Counter<number>;

declare const errorsTotal: Metric.Counter<number>;

declare const nodeRetriesTotal: Metric.Counter<number>;

declare const toolCallErrorsTotal: Metric.Counter<number>;

declare const toolOutputTruncatedTotal: Metric.Counter<number>;

declare const agentInvocationsTotal: Metric.Counter<number>;

declare const agentTokensTotal: Metric.Counter<number>;

declare const agentErrorsTotal: Metric.Counter<number>;

declare const agentRetriesTotal: Metric.Counter<number>;

declare const agentEventsTotal: Metric.Counter<number>;

declare const agentSessionsTotal: Metric.Counter<number>;

declare const agentActionsTotal: Metric.Counter<number>;

declare const gatewayConnectionsTotal: Metric.Counter<number>;

declare const gatewayConnectionsClosedTotal: Metric.Counter<number>;

declare const gatewayMessagesReceivedTotal: Metric.Counter<number>;

declare const gatewayMessagesSentTotal: Metric.Counter<number>;

declare const gatewayRpcCallsTotal: Metric.Counter<number>;

declare const gatewayErrorsTotal: Metric.Counter<number>;

declare const gatewayRunsStartedTotal: Metric.Counter<number>;

declare const gatewayRunsCompletedTotal: Metric.Counter<number>;

declare const gatewayApprovalDecisionsTotal: Metric.Counter<number>;

declare const gatewaySignalsTotal: Metric.Counter<number>;

declare const gatewayAuthEventsTotal: Metric.Counter<number>;

declare const gatewayHeartbeatTicksTotal: Metric.Counter<number>;

declare const gatewayCronTriggersTotal: Metric.Counter<number>;

declare const gatewayWebhooksReceivedTotal: Metric.Counter<number>;

declare const gatewayWebhooksVerifiedTotal: Metric.Counter<number>;

declare const gatewayWebhooksRejectedTotal: Metric.Counter<number>;

declare const devtoolsSubscribeTotal: Metric.Counter<number>;

declare const devtoolsEventTotal: Metric.Counter<number>;

declare const devtoolsBackpressureDisconnectTotal: Metric.Counter<number>;

declare const gatewayRunEventBackpressureDisconnectTotal: Metric.Counter<number>;

declare const eventsEmittedTotal: Metric.Counter<number>;

declare const taskHeartbeatsTotal: Metric.Counter<number>;

declare const taskHeartbeatTimeoutTotal: Metric.Counter<number>;

declare const memoryFactReads: Metric.Counter<number>;

declare const memoryFactWrites: Metric.Counter<number>;

declare const memoryRecallQueries: Metric.Counter<number>;

declare const memoryMessageSaves: Metric.Counter<number>;

declare const openApiToolCallsTotal: Metric.Counter<number>;

declare const openApiToolCallErrorsTotal: Metric.Counter<number>;

declare const scorersStarted: Metric.Counter<number>;

declare const scorersFinished: Metric.Counter<number>;

declare const scorersFailed: Metric.Counter<number>;

declare const snapshotsCaptured: Metric.Counter<number>;

declare const runForksCreated: Metric.Counter<number>;

declare const replaysStarted: Metric.Counter<number>;

declare const activeRuns: Metric.Gauge<number>;

declare const activeNodes: Metric.Gauge<number>;

declare const schedulerQueueDepth: Metric.Gauge<number>;

declare const sandboxActive: Metric.Gauge<number>;

declare const alertsActive: Metric.Gauge<number>;

declare const attentionBacklog: Metric.Gauge<number>;

declare const gatewayConnectionsActive: Metric.Gauge<number>;

declare const approvalPending: Metric.Gauge<number>;

declare const externalWaitAsyncPending: Metric.Gauge<number>;

declare const timersPending: Metric.Gauge<number>;

declare const schedulerConcurrencyUtilization: Metric.Gauge<number>;

declare const processUptimeSeconds: Metric.Gauge<number>;

declare const processMemoryRssBytes: Metric.Gauge<number>;

declare const processHeapUsedBytes: Metric.Gauge<number>;

declare const devtoolsActiveSubscribers: Metric.Gauge<number>;

declare const nodeDuration: Metric.Histogram<number>;

declare const attemptDuration: Metric.Histogram<number>;

declare const toolDuration: Metric.Histogram<number>;

declare const dbQueryDuration: Metric.Histogram<number>;

declare const dbTransactionDuration: Metric.Histogram<number>;

declare const httpRequestDuration: Metric.Histogram<number>;

declare const hotReloadDuration: Metric.Histogram<number>;

declare const vcsDuration: Metric.Histogram<number>;

declare const agentDurationMs: Metric.Histogram<number>;

declare const tokensInputPerCall: Metric.Histogram<number>;

declare const tokensOutputPerCall: Metric.Histogram<number>;

declare const tokensContextWindowPerCall: Metric.Histogram<number>;

declare const runDuration: Metric.Histogram<number>;

declare const promptSizeBytes: Metric.Histogram<number>;

declare const responseSizeBytes: Metric.Histogram<number>;

declare const approvalWaitDuration: Metric.Histogram<number>;

declare const timerDelayDuration: Metric.Histogram<number>;

declare const gatewayRpcDuration: Metric.Histogram<number>;

declare const schedulerWaitDuration: Metric.Histogram<number>;

declare const supervisorPollDuration: Metric.Histogram<number>;

declare const supervisorResumeLag: Metric.Histogram<number>;

declare const runsAncestryDepth: Metric.Histogram<number>;

declare const runsCarriedStateBytes: Metric.Histogram<number>;

declare const sandboxDurationMs: Metric.Histogram<number>;

declare const sandboxBundleSizeBytes: Metric.Histogram<number>;

declare const sandboxTransportDurationMs: Metric.Histogram<number>;

declare const sandboxPatchCount: Metric.Histogram<number>;

declare const heartbeatDataSizeBytes: Metric.Histogram<number>;

declare const heartbeatIntervalMs: Metric.Histogram<number>;

declare const memoryRecallDuration: Metric.Histogram<number>;

declare const openApiToolDuration: Metric.Histogram<number>;

declare const scorerDuration: Metric.Histogram<number>;

declare const snapshotDuration: Metric.Histogram<number>;

declare const devtoolsSnapshotBuildMs: Metric.Histogram<number>;

declare const devtoolsDeltaBuildMs: Metric.Histogram<number>;

declare const devtoolsEventBytes: Metric.Histogram<number>;

declare const rewindTotal: Metric.Counter<number>;

declare const rewindRollbackTotal: Metric.Counter<number>;

declare const rewindDurationMs: Metric.Histogram<number>;

declare const rewindFramesDeleted: Metric.Histogram<number>;

declare const rewindSandboxesReverted: Metric.Histogram<number>;

type SmithersMetricDefinition = SmithersMetricDefinition$2;
type SmithersMetricType = SmithersMetricType$2;
type SmithersMetricUnit = SmithersMetricUnit$2;

export { type SmithersMetricDefinition, type SmithersMetricType, type SmithersMetricUnit, activeNodes, activeRuns, agentActionsTotal, agentDurationMs, agentErrorsTotal, agentEventsTotal, agentInvocationsTotal, agentRetriesTotal, agentSessionsTotal, agentTokensTotal, alertDeliveriesAttempted, alertDeliveriesSuppressed, alertsAcknowledgedTotal, alertsActive, alertsEscalatedTotal, alertsFiredTotal, alertsReopenedTotal, alertsResolvedTotal, alertsSilencedTotal, approvalPending, approvalWaitDuration, approvalsDenied, approvalsGranted, approvalsRequested, attemptDuration, attentionBacklog, cacheHits, cacheMisses, dbQueryDuration, dbRetries, dbTransactionDuration, dbTransactionRetries, dbTransactionRollbacks, devtoolsActiveSubscribers, devtoolsBackpressureDisconnectTotal, devtoolsDeltaBuildMs, devtoolsEventBytes, devtoolsEventTotal, devtoolsSnapshotBuildMs, devtoolsSubscribeTotal, errorsTotal, eventsEmittedTotal, externalWaitAsyncPending, gatewayApprovalDecisionsTotal, gatewayAuthEventsTotal, gatewayConnectionsActive, gatewayConnectionsClosedTotal, gatewayConnectionsTotal, gatewayCronTriggersTotal, gatewayErrorsTotal, gatewayHeartbeatTicksTotal, gatewayMessagesReceivedTotal, gatewayMessagesSentTotal, gatewayRpcCallsTotal, gatewayRpcDuration, gatewayRunEventBackpressureDisconnectTotal, gatewayRunsCompletedTotal, gatewayRunsStartedTotal, gatewaySignalsTotal, gatewayWebhooksReceivedTotal, gatewayWebhooksRejectedTotal, gatewayWebhooksVerifiedTotal, heartbeatDataSizeBytes, heartbeatIntervalMs, hotReloadDuration, hotReloadFailures, hotReloads, httpRequestDuration, httpRequests, memoryFactReads, memoryFactWrites, memoryMessageSaves, memoryRecallDuration, memoryRecallQueries, metricsServiceAdapter, nodeDuration, nodeRetriesTotal, nodesFailed, nodesFinished, nodesStarted, openApiToolCallErrorsTotal, openApiToolCallsTotal, openApiToolDuration, processHeapUsedBytes, processMemoryRssBytes, processUptimeSeconds, promptSizeBytes, replaysStarted, responseSizeBytes, rewindDurationMs, rewindFramesDeleted, rewindRollbackTotal, rewindSandboxesReverted, rewindTotal, runDuration, runForksCreated, runsAncestryDepth, runsCancelledTotal, runsCarriedStateBytes, runsContinuedTotal, runsFailedTotal, runsFinishedTotal, runsResumedTotal, runsTotal, sandboxActive, sandboxBundleSizeBytes, sandboxCompletedTotal, sandboxCreatedTotal, sandboxDurationMs, sandboxPatchCount, sandboxTransportDurationMs, schedulerConcurrencyUtilization, schedulerQueueDepth, schedulerWaitDuration, scorerDuration, scorerEventsFailed, scorerEventsFinished, scorerEventsStarted, scorersFailed, scorersFinished, scorersStarted, smithersMetricCatalog, smithersMetricCatalogByKey, smithersMetricCatalogByName, smithersMetricCatalogByPrometheusName, snapshotDuration, snapshotsCaptured, supervisorPollDuration, supervisorPollsTotal, supervisorResumeLag, supervisorResumedTotal, supervisorSkippedTotal, supervisorStaleDetected, taskHeartbeatTimeoutTotal, taskHeartbeatsTotal, timerDelayDuration, timersCancelled, timersCreated, timersFired, timersPending, toPrometheusMetricName, tokensCacheReadTotal, tokensCacheWriteTotal, tokensContextWindowBucketTotal, tokensContextWindowPerCall, tokensInputPerCall, tokensInputTotal, tokensOutputPerCall, tokensOutputTotal, tokensReasoningTotal, toolCallErrorsTotal, toolCallsTotal, toolDuration, toolOutputTruncatedTotal, trackEvent, updateAsyncExternalWaitPending, updateProcessMetrics, vcsDuration };
