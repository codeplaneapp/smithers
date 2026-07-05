import { Effect, Metric } from 'effect';
import * as effect_MetricState from 'effect/MetricState';
import * as effect_MetricKeyType from 'effect/MetricKeyType';

type MetricLabels = Readonly<Record<string, string | number | boolean>>;

type SmithersMetricType$1 = "counter" | "gauge" | "histogram";

type SmithersMetricUnit$1 = "count" | "milliseconds" | "seconds" | "bytes" | "tokens" | "ratio" | "depth";

type SmithersMetricDefinition$1 = {
    readonly key: string;
    readonly name: string;
    readonly prometheusName: string;
    readonly type: SmithersMetricType$1;
    readonly label: string;
    readonly unit?: SmithersMetricUnit$1;
    readonly labels?: readonly string[];
    readonly defaultLabels?: readonly MetricLabels[];
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

type RunStatus = "running" | "waiting-approval" | "waiting-event" | "waiting-timer" | "finished" | "continued" | "failed" | "cancelled";
type RunState = "running" | "waiting-approval" | "waiting-event" | "waiting-timer" | "recovering" | "stale" | "orphaned" | "failed" | "cancelled" | "succeeded" | "unknown";
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
type SmithersEvent$1 = {
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
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
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
declare function trackEvent(event: SmithersEvent): Effect.Effect<void>;
type SmithersEvent = SmithersEvent$1;

type SmithersMetricType = "counter" | "gauge" | "histogram";

type SmithersMetricUnit = "count" | "milliseconds" | "seconds" | "bytes" | "tokens" | "ratio" | "depth";

type SmithersMetricDefinition = {
    readonly key: string;
    readonly metric: Metric.Metric<any, any, any>;
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

declare const smithersMetricCatalog: SmithersMetricDefinition[];

/** @type {MetricsServiceShape} */
declare const metricsServiceAdapter: MetricsServiceShape;
type MetricsServiceShape = MetricsServiceShape$1;

declare const runsTotal: Metric.Metric.Counter<number>;

declare const nodesStarted: Metric.Metric.Counter<number>;

declare const nodesFinished: Metric.Metric.Counter<number>;

declare const nodesFailed: Metric.Metric.Counter<number>;

declare const toolCallsTotal: Metric.Metric.Counter<number>;

declare const cacheHits: Metric.Metric.Counter<number>;

declare const cacheMisses: Metric.Metric.Counter<number>;

declare const dbRetries: Metric.Metric.Counter<number>;

declare const dbTransactionRollbacks: Metric.Metric.Counter<number>;

declare const dbTransactionRetries: Metric.Metric.Counter<number>;

declare const hotReloads: Metric.Metric.Counter<number>;

declare const hotReloadFailures: Metric.Metric.Counter<number>;

declare const httpRequests: Metric.Metric.Counter<number>;

declare const approvalsRequested: Metric.Metric.Counter<number>;

declare const approvalsGranted: Metric.Metric.Counter<number>;

declare const approvalsDenied: Metric.Metric.Counter<number>;

declare const timersCreated: Metric.Metric.Counter<number>;

declare const timersFired: Metric.Metric.Counter<number>;

declare const timersCancelled: Metric.Metric.Counter<number>;

declare const sandboxCreatedTotal: Metric.Metric.Counter<number>;

declare const sandboxCompletedTotal: Metric.Metric.Counter<number>;

declare const scorerEventsStarted: Metric.Metric.Counter<number>;

declare const scorerEventsFinished: Metric.Metric.Counter<number>;

declare const scorerEventsFailed: Metric.Metric.Counter<number>;

declare const tokensInputTotal: Metric.Metric.Counter<number>;

declare const tokensOutputTotal: Metric.Metric.Counter<number>;

declare const tokensCacheReadTotal: Metric.Metric.Counter<number>;

declare const tokensCacheWriteTotal: Metric.Metric.Counter<number>;

declare const tokensReasoningTotal: Metric.Metric.Counter<number>;

declare const tokensContextWindowBucketTotal: Metric.Metric.Counter<number>;

declare const runsFinishedTotal: Metric.Metric.Counter<number>;

declare const runsFailedTotal: Metric.Metric.Counter<number>;

declare const runsCancelledTotal: Metric.Metric.Counter<number>;

declare const runsResumedTotal: Metric.Metric.Counter<number>;

declare const runsContinuedTotal: Metric.Metric.Counter<number>;

declare const errorsTotal: Metric.Metric.Counter<number>;

declare const nodeRetriesTotal: Metric.Metric.Counter<number>;

declare const toolCallErrorsTotal: Metric.Metric.Counter<number>;

declare const toolOutputTruncatedTotal: Metric.Metric.Counter<number>;

declare const eventsEmittedTotal: Metric.Metric.Counter<number>;

declare const snapshotsCaptured: Metric.Metric.Counter<number>;

declare const runForksCreated: Metric.Metric.Counter<number>;

declare const replaysStarted: Metric.Metric.Counter<number>;

declare const activeRuns: Metric.Metric.Gauge<number>;

declare const activeNodes: Metric.Metric.Gauge<number>;

declare const schedulerQueueDepth: Metric.Metric.Gauge<number>;

declare const sandboxActive: Metric.Metric.Gauge<number>;

declare const approvalPending: Metric.Metric.Gauge<number>;

declare const externalWaitAsyncPending: Metric.Metric.Gauge<number>;

declare const timersPending: Metric.Metric.Gauge<number>;

declare const schedulerConcurrencyUtilization: Metric.Metric.Gauge<number>;

declare const processUptimeSeconds: Metric.Metric.Gauge<number>;

declare const processMemoryRssBytes: Metric.Metric.Gauge<number>;

declare const processHeapUsedBytes: Metric.Metric.Gauge<number>;

declare const nodeDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const attemptDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const toolDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const dbQueryDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const dbTransactionDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const httpRequestDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const hotReloadDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const vcsDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const tokensInputPerCall: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const tokensOutputPerCall: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const tokensContextWindowPerCall: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const runDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const promptSizeBytes: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const responseSizeBytes: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const approvalWaitDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const timerDelayDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const schedulerWaitDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const runsAncestryDepth: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const runsCarriedStateBytes: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const sandboxDurationMs: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const sandboxBundleSizeBytes: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const sandboxTransportDurationMs: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const sandboxPatchCount: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const snapshotDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const rewindTotal: Metric.Metric.Counter<number>;

declare const rewindRollbackTotal: Metric.Metric.Counter<number>;

declare const rewindDurationMs: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const rewindFramesDeleted: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const rewindSandboxesReverted: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

export { runsResumedTotal as $, metricsServiceAdapter as A, nodeDuration as B, nodeRetriesTotal as C, nodesFailed as D, nodesFinished as E, nodesStarted as F, processHeapUsedBytes as G, processMemoryRssBytes as H, processUptimeSeconds as I, promptSizeBytes as J, replaysStarted as K, responseSizeBytes as L, type MetricsServiceShape$1 as M, rewindDurationMs as N, rewindFramesDeleted as O, rewindRollbackTotal as P, rewindSandboxesReverted as Q, rewindTotal as R, type SmithersEvent$1 as S, runDuration as T, runForksCreated as U, runsAncestryDepth as V, runsCancelledTotal as W, runsCarriedStateBytes as X, runsContinuedTotal as Y, runsFailedTotal as Z, runsFinishedTotal as _, type MetricLabels as a, runsTotal as a0, sandboxActive as a1, sandboxBundleSizeBytes as a2, sandboxCompletedTotal as a3, sandboxCreatedTotal as a4, sandboxDurationMs as a5, sandboxPatchCount as a6, sandboxTransportDurationMs as a7, schedulerConcurrencyUtilization as a8, schedulerQueueDepth as a9, trackEvent as aA, updateProcessMetrics as aB, vcsDuration as aC, type SmithersMetricDefinition as aD, type SmithersMetricType$1 as aE, type SmithersMetricUnit$1 as aF, schedulerWaitDuration as aa, scorerEventsFailed as ab, scorerEventsFinished as ac, scorerEventsStarted as ad, smithersMetricCatalog as ae, snapshotDuration as af, snapshotsCaptured as ag, timerDelayDuration as ah, timersCancelled as ai, timersCreated as aj, timersFired as ak, timersPending as al, toPrometheusMetricName as am, tokensCacheReadTotal as an, tokensCacheWriteTotal as ao, tokensContextWindowBucketTotal as ap, tokensContextWindowPerCall as aq, tokensInputPerCall as ar, tokensInputTotal as as, tokensOutputPerCall as at, tokensOutputTotal as au, tokensReasoningTotal as av, toolCallErrorsTotal as aw, toolCallsTotal as ax, toolDuration as ay, toolOutputTruncatedTotal as az, type MetricsSnapshot as b, type SmithersMetricDefinition$1 as c, activeNodes as d, activeRuns as e, approvalPending as f, approvalWaitDuration as g, approvalsDenied as h, approvalsGranted as i, approvalsRequested as j, attemptDuration as k, cacheHits as l, cacheMisses as m, dbQueryDuration as n, dbRetries as o, dbTransactionDuration as p, dbTransactionRetries as q, dbTransactionRollbacks as r, errorsTotal as s, eventsEmittedTotal as t, externalWaitAsyncPending as u, hotReloadDuration as v, hotReloadFailures as w, hotReloads as x, httpRequestDuration as y, httpRequests as z };
