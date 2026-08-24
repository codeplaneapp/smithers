// @smithers-type-exports-begin
/** @typedef {import("@smthrs/agents/capability-registry").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("@smthrs/agents").AgentCheckpoint} AgentCheckpoint */
/** @typedef {import("@smthrs/agents").AgentCheckpointCapability} AgentCheckpointCapability */
/** @typedef {import("@smthrs/agents").AgentCheckpointContinuationOptions} AgentCheckpointContinuationOptions */
/** @typedef {import("@smthrs/agents").AgentCheckpointFormat} AgentCheckpointFormat */
/** @typedef {import("@smthrs/agents").AgentCheckpointJsonArray} AgentCheckpointJsonArray */
/** @typedef {import("@smthrs/agents").AgentCheckpointJsonObject} AgentCheckpointJsonObject */
/** @typedef {import("@smthrs/agents").AgentCheckpointJsonPrimitive} AgentCheckpointJsonPrimitive */
/** @typedef {import("@smthrs/agents").AgentCheckpointJsonValue} AgentCheckpointJsonValue */
/** @typedef {import("@smthrs/agents").AgentCheckpointMode} AgentCheckpointMode */
/** @typedef {import("@smthrs/agents").AgentCheckpointPublisher} AgentCheckpointPublisher */
/** @typedef {import("@smthrs/agents").AgentCheckpointResult} AgentCheckpointResult */
/** @typedef {import("@smthrs/agents").AgentFileChange} AgentFileChange */
/** @typedef {import("@smthrs/agents").AgentFileChangeKind} AgentFileChangeKind */
/** @typedef {import("@smthrs/agents").AgentGenerateOptions} AgentGenerateOptions */
/** @typedef {import("@smthrs/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("@smthrs/agents/capability-registry").AgentToolDescriptor} AgentToolDescriptor */
/** @typedef {import("@smthrs/scorers").AggregateOptions} AggregateOptions */
/** @typedef {import("@smthrs/scorers").AggregateScore} AggregateScore */
/**
 * @template CALL_OPTIONS
 * @template TOOLS
 * @typedef {import("@smthrs/agents").AnthropicAgentOptions<CALL_OPTIONS, TOOLS>} AnthropicAgentOptions
 */
/** @typedef {import("@smthrs/components").ApprovalAutoApprove} ApprovalAutoApprove */
/** @typedef {import("@smthrs/components").ApprovalDecision} ApprovalDecision */
/** @typedef {import("@smthrs/components").ApprovalMode} ApprovalMode */
/** @typedef {import("@smthrs/components").ApprovalOption} ApprovalOption */
/** @typedef {import("@smthrs/components").ApprovalProps} ApprovalProps */
/** @typedef {import("@smthrs/components").ApprovalRanking} ApprovalRanking */
/** @typedef {import("@smthrs/components").ApprovalRequest} ApprovalRequest */
/** @typedef {import("@smthrs/components").ApprovalSelection} ApprovalSelection */
/** @typedef {import("@smthrs/components").ColumnDef} ColumnDef */
/** @typedef {import("@smthrs/server/gateway").ConnectRequest} ConnectRequest */
/** @typedef {import("@smthrs/components").ContinueAsNewProps} ContinueAsNewProps */
/** @typedef {import("@smthrs/scorers").CreateScorerConfig} CreateScorerConfig */
/**
 * @template Schema
 * @typedef {import("./CreateSmithersApi.ts").CreateSmithersApi<Schema>} CreateSmithersApi
 */
/** @typedef {import("./CreateSmithersOptions.ts").CreateSmithersOptions} CreateSmithersOptions */
/** @typedef {import("./OpenSmithersBackendOptions.ts").OpenSmithersBackendOptions} OpenSmithersBackendOptions */
/** @typedef {import("./MigrateSmithersStoreOptions.ts").MigrateSmithersStoreOptions} MigrateSmithersStoreOptions */
/** @typedef {import("./SmithersMigrationResult.ts").SmithersMigrationResult} SmithersMigrationResult */
/** @typedef {import("@smthrs/components").DepsSpec} DepsSpec */
/** @typedef {import("@smthrs/server/gateway").EventFrame} EventFrame */
/**
 * @template S
 * @typedef {import("./external/ExternalSmithersConfig.ts").ExternalSmithersConfig<S>} ExternalSmithersConfig
 */
/**
 * @template S
 * @typedef {import("./external/ExternalSmithersEngine.ts").ExternalSmithersEngine<S>} ExternalSmithersEngine
 */
/**
 * @template S
 * @typedef {import("./external/ExternalSmithersEngineConfig.ts").ExternalSmithersEngineConfig<S>} ExternalSmithersEngineConfig
 */
/** @typedef {import("@smthrs/server/gateway").GatewayAuthConfig} GatewayAuthConfig */
/** @typedef {import("@smthrs/server/gateway").GatewayDefaults} GatewayDefaults */
/** @typedef {import("@smthrs/server").GatewayExtensionDefinition} GatewayExtensionDefinition */
/** @typedef {import("@smthrs/server/gateway").GatewayOperatorUiConfig} GatewayOperatorUiConfig */
/** @typedef {import("@smthrs/server/gateway").GatewayOptions} GatewayOptions */
/** @typedef {import("@smthrs/server/gateway").GatewayRegisterOptions} GatewayRegisterOptions */
/** @typedef {import("@smthrs/server/gateway").GatewayTokenGrant} GatewayTokenGrant */
/** @typedef {import("@smthrs/server/gateway").GatewayUiConfig} GatewayUiConfig */
/** @typedef {import("@smthrs/server/gateway").GatewayWebhookConfig} GatewayWebhookConfig */
/** @typedef {import("@smthrs/server/gateway").GatewayWebhookRunConfig} GatewayWebhookRunConfig */
/** @typedef {import("@smthrs/server/gateway").GatewayWebhookSignalConfig} GatewayWebhookSignalConfig */
/** @typedef {import("@smthrs/graph/GraphSnapshot").GraphSnapshot} GraphSnapshot */
/** @typedef {import("@smthrs/server/gateway").HelloResponse} HelloResponse */
/** @typedef {import("@smthrs/react-reconciler/dom/renderer").HostContainer} HostContainer */
/** @typedef {import("./external/HostNodeJson.ts").HostNodeJson} HostNodeJson */
/** @typedef {import("./external/ExternalSmithersEngineConfig.ts").SmithersEngineLogger} SmithersEngineLogger */
/** @typedef {import("./external/ExternalSmithersEngineConfig.ts").SmithersEngineLogLevel} SmithersEngineLogLevel */
/** @typedef {import("./external/ExternalSmithersEngineConfig.ts").SmithersEngineLogRecord} SmithersEngineLogRecord */
/** @typedef {import("@smthrs/components").InferDeps} InferDeps */
/**
 * @template T
 * @typedef {import("@smthrs/driver/OutputAccessor").InferOutputEntry<T>} InferOutputEntry
 */
/**
 * @template TTable
 * @typedef {import("@smthrs/driver/OutputAccessor").InferRow<TTable>} InferRow
 */
/** @typedef {import("@smthrs/vcs/jj").JjRevertResult} JjRevertResult */
/** @typedef {import("@smthrs/components").KanbanProps} KanbanProps */
/** @typedef {import("@smthrs/errors/KnownSmithersErrorCode").KnownSmithersErrorCode} KnownSmithersErrorCode */
/** @typedef {import("@smthrs/scorers").LlmJudgeConfig} LlmJudgeConfig */
/** @typedef {import("@smthrs/memory").MemoryFact} MemoryFact */
/** @typedef {import("@smthrs/memory").MemoryLayerConfig} MemoryLayerConfig */
/** @typedef {import("@smthrs/memory").HindsightMemoryStoreOptions} HindsightMemoryStoreOptions */
/** @typedef {import("@smthrs/memory").MemoryMessage} MemoryMessage */
/** @typedef {import("@smthrs/components").MemoryProps} MemoryProps */
/** @typedef {import("@smthrs/components").MemoryTrellisProps} MemoryTrellisProps */
/** @typedef {import("@smthrs/memory").MemoryNamespace} MemoryNamespace */
/** @typedef {import("@smthrs/memory").MemoryNamespaceKind} MemoryNamespaceKind */
/** @typedef {import("@smthrs/memory").MemoryProcessor} MemoryProcessor */
/** @typedef {import("@smthrs/memory").MemoryProcessorConfig} MemoryProcessorConfig */
/** @typedef {import("@smthrs/memory").MemoryServiceApi} MemoryServiceApi */
/** @typedef {import("@smthrs/memory").MemoryStore} MemoryStore */
/** @typedef {import("@smthrs/memory").MemoryThread} MemoryThread */
/** @typedef {import("@smthrs/memory").MessageHistoryConfig} MessageHistoryConfig */
/**
 * @template [CALL_OPTIONS=never]
 * @template [TOOLS=import("ai").ToolSet]
 * @typedef {import("@smthrs/agents").OpenAIAgentOptions<CALL_OPTIONS, TOOLS>} OpenAIAgentOptions
 */
/**
 * @template [CALL_OPTIONS=never]
 * @template [TOOLS=import("ai").ToolSet]
 * @typedef {import("@smthrs/agents").HermesAgentOptions<CALL_OPTIONS, TOOLS>} HermesAgentOptions
 */
/** @typedef {import("@smthrs/agents").HermesCliAgentOptions} HermesCliAgentOptions */
/** @typedef {import("@smthrs/agents").GrokAgentOptions} GrokAgentOptions */
/** @typedef {import("@smthrs/agents").OpenClawAgentOptions} OpenClawAgentOptions */
/** @typedef {import("@smthrs/agents").NanocodexAgentOptions} NanocodexAgentOptions */
/** @typedef {import("@smthrs/agents").NanocodexGenerateOptions} NanocodexGenerateOptions */
/** @typedef {import("@smthrs/agents").NanocodexAuth} NanocodexAuth */
/** @typedef {import("@smthrs/agents").NanocodexThinking} NanocodexThinking */
/** @typedef {import("@smthrs/agents").NanocodexReasoningMode} NanocodexReasoningMode */
/** @typedef {import("@smthrs/openapi").OpenApiAuth} OpenApiAuth */
/** @typedef {import("@smthrs/openapi").OpenApiSpec} OpenApiSpec */
/** @typedef {import("@smthrs/openapi").OpenApiToolsOptions} OpenApiToolsOptions */
/**
 * @template Schema
 * @typedef {import("@smthrs/driver/OutputAccessor").OutputAccessor<Schema>} OutputAccessor
 */
/** @typedef {import("@smthrs/driver/OutputKey").OutputKey} OutputKey */
/** @typedef {import("@smthrs/components").OutputTarget} OutputTarget */
/** @typedef {import("@smthrs/agents").PiAgentOptions} PiAgentOptions */
/** @typedef {import("@smthrs/agents").OmpAgentOptions} OmpAgentOptions */
/** @typedef {import("@smthrs/agents").CursorAgentOptions} CursorAgentOptions */
/** @typedef {import("@smthrs/agents").PiExtensionUiRequest} PiExtensionUiRequest */
/** @typedef {import("@smthrs/agents").PiExtensionUiResponse} PiExtensionUiResponse */
/** @typedef {import("@smthrs/agents").OpenCodeAgentOptions} OpenCodeAgentOptions */
/** @typedef {import("@smthrs/agents").PoolAgentOptions} PoolAgentOptions */
/** @typedef {import("@smthrs/agents").VibeAgentOptions} VibeAgentOptions */
/** @typedef {import("@smthrs/components").MonitorCondition} MonitorCondition */
/** @typedef {import("@smthrs/components").MonitorProps} MonitorProps */
/** @typedef {import("@smthrs/components").PollerProps} PollerProps */
/** @typedef {import("@smthrs/graph/ProofBinding").ProofBinding} ProofBinding */
/** @typedef {import("@smthrs/server/gateway").RequestFrame} RequestFrame */
/** @typedef {import("@smthrs/observability").ResolvedSmithersObservabilityOptions} ResolvedSmithersObservabilityOptions */
/** @typedef {import("@smthrs/server/gateway").ResponseFrame} ResponseFrame */
/** @typedef {import("@smthrs/time-travel/revert").RevertOptions} RevertOptions */
/** @typedef {import("@smthrs/time-travel/revert").RevertResult} RevertResult */
/** @typedef {import("@smthrs/vcs/jj").RunJjOptions} RunJjOptions */
/** @typedef {import("@smthrs/vcs/jj").RunJjResult} RunJjResult */
/** @typedef {import("@smthrs/driver/RunOptions").RunOptions} RunOptions */
/** @typedef {import("@smthrs/driver/RunStartedBy").RunStartedBy} RunStartedBy */
/** @typedef {import("@smthrs/driver/SmithersErrorReport").SmithersErrorReport} SmithersErrorReport */
/** @typedef {import("@smthrs/driver/RunResult").RunResult} RunResult */
/** @typedef {import("@smthrs/driver/RunStatus").RunStatus} RunStatus */
/** @typedef {import("@smthrs/components").SagaProps} SagaProps */
/** @typedef {import("@smthrs/components").SagaStepDef} SagaStepDef */
/** @typedef {import("@smthrs/components").SagaStepProps} SagaStepProps */
/** @typedef {import("@smthrs/scorers").SamplingConfig} SamplingConfig */
/** @typedef {import("@smthrs/components").SandboxProps} SandboxProps */
/** @typedef {import("@smthrs/components").SandboxRuntime} SandboxRuntime */
/** @typedef {import("@smthrs/components").SandboxVolumeMount} SandboxVolumeMount */
/** @typedef {import("@smthrs/components").SandboxWorkspaceSpec} SandboxWorkspaceSpec */
/** @typedef {import("@smthrs/db/SchemaRegistryEntry").SchemaRegistryEntry} SchemaRegistryEntry */
/** @typedef {import("@smthrs/scorers").Scorer} Scorer */
/** @typedef {import("@smthrs/scorers").ScorerBinding} ScorerBinding */
/** @typedef {import("@smthrs/scorers").ScorerContext} ScorerContext */
/** @typedef {import("@smthrs/scorers").ScoreResult} ScoreResult */
/** @typedef {import("@smthrs/scorers").ScorerFn} ScorerFn */
/** @typedef {import("@smthrs/scorers").ScorerInput} ScorerInput */
/** @typedef {import("@smthrs/scorers").ScoreRow} ScoreRow */
/** @typedef {import("@smthrs/scorers").ScorersMap} ScorersMap */
/** @typedef {import("@smthrs/memory").SemanticRecallConfig} SemanticRecallConfig */
/** @typedef {import("./external/SerializedCtx.ts").SerializedCtx} SerializedCtx */
/** @typedef {import("@smthrs/server/serve").ServeOptions} ServeOptions */
/** @typedef {import("@smthrs/server").ServerOptions} ServerOptions */
/** @typedef {import("@smthrs/components").SignalProps} SignalProps */
/** @typedef {import("@smthrs/scheduler/SmithersWorkflowOptions").SmithersAlertLabels} SmithersAlertLabels */
/** @typedef {import("@smthrs/scheduler/SmithersWorkflowOptions").SmithersAlertPolicy} SmithersAlertPolicy */
/** @typedef {import("@smthrs/scheduler/SmithersWorkflowOptions").SmithersAlertPolicyDefaults} SmithersAlertPolicyDefaults */
/** @typedef {import("@smthrs/scheduler/SmithersWorkflowOptions").SmithersAlertPolicyRule} SmithersAlertPolicyRule */
/** @typedef {import("@smthrs/scheduler/SmithersWorkflowOptions").SmithersAlertReaction} SmithersAlertReaction */
/** @typedef {import("@smthrs/scheduler/SmithersWorkflowOptions").SmithersAlertReactionKind} SmithersAlertReactionKind */
/** @typedef {import("@smthrs/scheduler/SmithersWorkflowOptions").SmithersAlertReactionRef} SmithersAlertReactionRef */
/** @typedef {import("@smthrs/scheduler/SmithersWorkflowOptions").SmithersAlertSeverity} SmithersAlertSeverity */
/** @typedef {import("@smthrs/driver/SmithersCtx").SmithersCtx} SmithersCtx */
/** @typedef {import("@smthrs/errors/SmithersError").SmithersError} SmithersError */
/** @typedef {import("@smthrs/errors/SmithersErrorCode").SmithersErrorCode} SmithersErrorCode */
/** @typedef {import("@smthrs/observability/SmithersEvent").SmithersEvent} SmithersEvent */
/** @typedef {import("@smthrs/observability").SmithersLogFormat} SmithersLogFormat */
/** @typedef {import("@smthrs/observability").SmithersObservabilityOptions} SmithersObservabilityOptions */
/** @typedef {import("@smthrs/observability").SmithersObservabilityService} SmithersObservabilityService */
/**
 * @template Schema
 * @typedef {import("@smthrs/components/SmithersWorkflow").SmithersWorkflow<Schema>} SmithersWorkflow
 */
/** @typedef {import("@smthrs/scheduler/SmithersWorkflowOptions").SmithersWorkflowOptions} SmithersWorkflowOptions */
/** @typedef {import("@smthrs/graph/TaskDescriptor").TaskDescriptor} TaskDescriptor */
/** @typedef {import("@smthrs/memory").TaskMemoryConfig} TaskMemoryConfig */
/** @typedef {import("@smthrs/components").TaskProps} TaskProps */
/** @typedef {import("@smthrs/components").TaskRepair} TaskRepair */
/** @typedef {import("@smthrs/components").TimerProps} TimerProps */
/** @typedef {import("@smthrs/time-travel/timetravel").TimeTravelOptions} TimeTravelOptions */
/** @typedef {import("@smthrs/time-travel/timetravel").TimeTravelResult} TimeTravelResult */
/** @typedef {import("@smthrs/components").TryCatchFinallyProps} TryCatchFinallyProps */
/** @typedef {import("@smthrs/components").TrellisProps} TrellisProps */
/** @typedef {import("@smthrs/components").TUIProps} TUIProps */
/** @typedef {import("@smthrs/components").UIProps} UIProps */
/** @typedef {import("@smthrs/components").WaitForEventProps} WaitForEventProps */
/** @typedef {import("@smthrs/components").WorkflowViewBootProps} WorkflowViewBootProps */
/** @typedef {import("@smthrs/components").WorkflowViewProps} WorkflowViewProps */
/** @typedef {import("@smthrs/engine").WorkflowTool} WorkflowTool */
/** @typedef {import("@smthrs/engine").WorkflowToolOptions} WorkflowToolOptions */
/**
 * @template T
 * @typedef {import("@smthrs/memory").WorkingMemoryConfig<T>} WorkingMemoryConfig
 */
/** @typedef {import("@smthrs/vcs/jj").WorkspaceAddOptions} WorkspaceAddOptions */
/** @typedef {import("@smthrs/vcs/jj").WorkspaceInfo} WorkspaceInfo */
/** @typedef {import("@smthrs/vcs/jj").WorkspaceResult} WorkspaceResult */
/** @typedef {import("@smthrs/graph/XmlNode").XmlElement} XmlElement */
/** @typedef {import("@smthrs/graph/XmlNode").XmlNode} XmlNode */
/** @typedef {import("@smthrs/graph/XmlNode").XmlText} XmlText */
// @smithers-type-exports-end

export { hashCapabilityRegistry } from "@smthrs/agents/capability-registry";
export { ERROR_REFERENCE_URL } from "@smthrs/errors/ERROR_REFERENCE_URL";
export { SmithersError as SmithersErrorInstance } from "@smthrs/errors/SmithersError";
export { errorToJson } from "@smthrs/errors/errorToJson";
export { getSmithersErrorDefinition } from "@smthrs/errors/getSmithersErrorDefinition";
export { getSmithersErrorDocsUrl } from "@smthrs/errors/getSmithersErrorDocsUrl";
export { isKnownSmithersErrorCode } from "@smthrs/errors/isKnownSmithersErrorCode";
export { isSmithersError } from "@smthrs/errors/isSmithersError";
export { knownSmithersErrorCodes } from "@smthrs/errors/knownSmithersErrorCodes";
export { createIsolatedClone, gitDirtyPaths, isolatedCloneEnvironment, listGitRefs } from "@smthrs/vcs";
// Components
export {
  Approval,
  ApprovalGate,
  Aspects,
  Branch,
  CheckSuite,
  ClassifyAndRoute,
  ContentPipeline,
  ContinueAsNew,
  Debate,
  DecisionTable,
  DriftDetector,
  EscalationChain,
  ForkFanOut,
  GatherAndSynthesize,
  HumanTask,
  Kanban,
  Loop,
  Memory,
  MemoryTrellis,
  MergeQueue,
  Monitor,
  Optimizer,
  Panel,
  Parallel,
  Poller,
  Ralph,
  ReviewLoop,
  Runbook,
  Saga,
  SagaStep,
  Sandbox,
  ScanFixVerify,
  Sequence,
  Sidecar,
  Signal,
  Subflow,
  SuperSmithers,
  Supervisor,
  TUI,
  Task,
  Timer,
  TryCatchFinally,
  UI,
  WaitForEvent,
  Workflow,
  Worktree,
  MONITOR_CONDITIONS,
  MONITOR_DEFAULT_AUTO_HEAL,
  MONITOR_TERMINAL_STATUSES,
  approvalDecisionSchema,
  approvalRankingSchema,
  approvalSelectionSchema,
  computeSidecarDelta,
  continueAsNew,
  monitorAuthorityRules,
  monitorEvidenceRules,
  monitorHealthSignals,
  monitorPrompt,
  monitorReadPathRules,
} from "@smthrs/components";
// Delegation chain
export {
  BackpressurePlanning,
  DelegationChain,
  DelegationEditListener,
  DelegationExecution,
  DelegationPlanning,
  DelegationPreview,
  DelegationScoring,
  DeriskLoop,
  GoalRefinement,
  DC_EDIT_SIGNAL,
  DC_SKIP_PREVIEW_SIGNAL,
  DEFAULT_TIER_ORDER,
  captureWorkingCopyCommit,
  dcApprovalSchema,
  dcBudgetSchema,
  dcDevPreviewSchema,
  dcEditSchema,
  dcExecSchema,
  dcForecastSchema,
  dcGatesSchema,
  dcGoalApprovalSchema,
  dcGoalSchema,
  dcPlanSchema,
  dcPollSchema,
  dcPreviewSchema,
  dcProbeSchema,
  dcQuestionSchema,
  dcReplanSchema,
  dcReviewSchema,
  dcScoreSchema,
  dcSkipSchema,
  delegationPrompts,
  delegationSchemas,
  devPreviewKindSchema,
  estimateSchema,
  gateSchema,
  tierSchema,
  withCommitRange,
} from "@smthrs/components";
// Trellis dynamic delegation
export {
  Trellis,
  delegationV2Schemas,
  validateWorkflowProgram,
  delegationV2ProgramDigest,
  compileDelegationV2Program,
  partitionDelegationV2AuthorFuel,
  enforceDelegationV2AuthorFuel,
  delegationV2AssignmentDigest,
  settleDelegationV2Envelope,
  DEFAULT_DELEGATION_V2_LIMITS,
  DELEGATION_V2_COMPILER_VERSION,
  DELEGATION_V2_PROGRAM_VERSION,
  DELEGATION_V2_PROTOCOL_VERSION,
  DELEGATION_V2_REGISTRY_VERSION,
  DELEGATION_V2_RUNTIME_VERSION,
  DELEGATION_V2_SETTLEMENT_VERSION,
  trellisPrompts,
} from "@smthrs/components";
// Agents
export {
  AnthropicAgent,
  OpenAIAgent,
  HermesAgent,
  HermesCliAgent,
  OpenClawAgent,
  AmpAgent,
  AntigravityAgent,
  ClaudeCodeAgent,
  createDeepSeekUsageNormalizer,
  CodexAgent,
  CursorAgent,
  GeminiAgent,
  NanocodexAgent,
  PiAgent,
  OmpAgent,
  createOmpCapabilityRegistry,
  KimiAgent,
  GrokAgent,
  createGrokCapabilityRegistry,
  ForgeAgent,
  VibeAgent,
  OpenCodeAgent,
  PoolAgent,
  fallbackAgents,
  createHttpTool,
  agentProducesCheckpoint,
  agentSupportsCheckpoint,
  cloneAgentCheckpoint,
  DEFAULT_AGENT_CHECKPOINT_MAX_BYTES,
  hashAgentCheckpointCapabilities,
} from "@smthrs/agents";
// VCS
export {
  runJj,
  getJjPointer,
  revertToJjPointer,
  isJjRepo,
  workspaceAdd,
  workspaceList,
  workspaceClose,
} from "@smthrs/vcs/jj";
// Core API
export { createSmithers, createSmithersCloudflare, createSmithersPostgres } from "./create.js";
export { openSmithersBackend } from "./openSmithersBackend.js";
export { openSmithersStore } from "./openSmithersStore.js";
export { resolveSmithersBackendChoice, resolveSmithersBackendPreference } from "./resolveSmithersBackendChoice.js";
export { migrateSmithersStore } from "./migrateSmithersStore.js";
export {
  approveNode,
  // Process-local SingleRunner lifecycle. Nothing calls these by default; a
  // finite program awaits its runs, then closes so the cluster daemon fibers
  // stop pinning the event loop and the process can exit without
  // process.exit(). See https://smithers.sh/runtime/shutdown (#1378).
  closeSingleRunnerRuntime,
  denyNode,
  fragment,
  getRun,
  listRuns,
  renderFrame,
  reopenSingleRunnerRuntime,
  runWorkflow,
  Smithers,
  workflow,
  workflowTool,
} from "@smthrs/engine";
export { resolveWorktreePath } from "@smthrs/graph";
export { signalRun } from "@smthrs/engine/signals";
// Run an arbitrary workflow as a real, separately-addressable child run with
// an explicit runId (prefer-resume/attach/idempotent-by-runId) and get back
// `{ runId, status, output }` WITHOUT throwing on a non-finished status —
// unlike `<Subflow>`, which throws and hides the child runId. This is the
// seam a data-driven fan-out (e.g. `eval-suite-run`) uses to launch and
// score each item's run individually.
export { executeChildWorkflow } from "@smthrs/engine/child-workflow";
export { usePatched } from "@smthrs/engine/effect/versioning";
// Tools
export { bash, defineTool, edit, getDefinedToolMetadata, grep, read, tools, write } from "./tools.js";
// Server
export { startServer } from "@smthrs/server";
export { Gateway } from "@smthrs/server/gateway";
// Serve (Hono-based single-workflow HTTP server)
export { createServeApp } from "@smthrs/server/serve";
// Observability
export {
  SmithersObservability,
  createSmithersObservabilityLayer,
  createSmithersOtelLayer,
  createSmithersRuntimeLayer,
  smithersMetrics,
  trackSmithersEvent,
  activeNodes,
  activeRuns,
  externalWaitAsyncPending,
  approvalsDenied,
  approvalsGranted,
  approvalsRequested,
  timerDelayDuration,
  timersCancelled,
  timersCreated,
  timersFired,
  timersPending,
  attemptDuration,
  cacheHits,
  cacheMisses,
  dbQueryDuration,
  dbRetries,
  dbTransactionDuration,
  dbTransactionRetries,
  dbTransactionRollbacks,
  hotReloadDuration,
  hotReloadFailures,
  hotReloads,
  httpRequestDuration,
  httpRequests,
  nodeDuration,
  nodesFailed,
  nodesFinished,
  nodesStarted,
  prometheusContentType,
  renderPrometheusMetrics,
  resolveSmithersObservabilityOptions,
  runsTotal,
  sandboxActive,
  sandboxBundleSizeBytes,
  sandboxCompletedTotal,
  sandboxCreatedTotal,
  sandboxDurationMs,
  sandboxPatchCount,
  sandboxTransportDurationMs,
  schedulerQueueDepth,
  toolCallsTotal,
  toolDuration,
  vcsDuration,
} from "@smthrs/observability";
// DB
export { SmithersDb } from "@smthrs/db";
export { loadOutputs, loadOutputsEffect } from "@smthrs/db";
export { ensureSmithersTables } from "@smthrs/db/ensure";
// Renderer
export { SmithersRenderer } from "@smthrs/react-reconciler/dom/renderer";
// External / multi-language
export { createExternalSmithers, createExternalSmithersEngine } from "./external/index.js";
// Revert
export { revertToAttempt } from "@smthrs/time-travel/revert";
export { timeTravel } from "@smthrs/time-travel/timetravel";
// Scorers
export {
  createScorer,
  llmJudge,
  relevancyScorer,
  toxicityScorer,
  faithfulnessScorer,
  schemaAdherenceScorer,
  latencyScorer,
  runScorersAsync,
  runScorersBatch,
  aggregateScores,
  smithersScorers,
  modelTokenPrices,
  estimateCostUsd,
} from "@smthrs/scorers";
// Memory
export {
  createMemoryStore,
  createHindsightMemoryStore,
  HindsightMemoryStore,
  createLocalMemoryRuntime,
  LocalMemoryRuntime,
  createMemoryLayer,
  MemoryService,
  TtlGarbageCollector,
  TokenLimiter,
  Summarizer,
  namespaceToString,
  parseNamespace,
  memoryFactReads,
  memoryFactWrites,
  memoryRecallQueries,
  memoryMessageSaves,
  memoryRecallDuration,
} from "@smthrs/memory";
// OpenAPI Tools
export {
  createOpenApiTools,
  createOpenApiToolsSync,
  createOpenApiTool,
  createOpenApiToolSync,
  listOperations,
  openApiToolCallsTotal,
  openApiToolCallErrorsTotal,
  openApiToolDuration,
} from "@smthrs/openapi";
// Utilities
export { mdxPlugin } from "./mdx-plugin.js";
export { markdownComponents } from "@smthrs/components/markdownComponents";
export { renderMdx } from "@smthrs/components/renderMdx";
export { zodToTable } from "@smthrs/db/zodToTable";
export { syncZodTableSchema, zodSchemaColumns, zodToCreateTableSQL } from "@smthrs/db/zodToCreateTableSQL";
export { camelToSnake } from "@smthrs/db/utils/camelToSnake";
export { unwrapZodType } from "@smthrs/db/unwrapZodType";
export { zodSchemaToJsonExample } from "@smthrs/components/zod-to-example";
