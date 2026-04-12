// @smithers-type-exports-begin
/** @typedef {import("./index.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./index.ts").AgentLike} AgentLike */
/** @typedef {import("./index.ts").AgentToolDescriptor} AgentToolDescriptor */
/** @typedef {import("./index.ts").AggregateOptions} AggregateOptions */
/** @typedef {import("./index.ts").AggregateScore} AggregateScore */
/**
 * @template CALL_OPTIONS
 * @template TOOLS
 * @typedef {import("./index.ts").AnthropicAgentOptions<CALL_OPTIONS, TOOLS>} AnthropicAgentOptions
 */
/** @typedef {import("./index.ts").ApprovalAutoApprove} ApprovalAutoApprove */
/** @typedef {import("./index.ts").ApprovalDecision} ApprovalDecision */
/** @typedef {import("./index.ts").ApprovalMode} ApprovalMode */
/** @typedef {import("./index.ts").ApprovalOption} ApprovalOption */
/** @typedef {import("./index.ts").ApprovalProps} ApprovalProps */
/** @typedef {import("./index.ts").ApprovalRanking} ApprovalRanking */
/** @typedef {import("./index.ts").ApprovalRequest} ApprovalRequest */
/** @typedef {import("./index.ts").ApprovalSelection} ApprovalSelection */
/** @typedef {import("./index.ts").ColumnDef} ColumnDef */
/** @typedef {import("./index.ts").ConnectRequest} ConnectRequest */
/** @typedef {import("./index.ts").ContinueAsNewProps} ContinueAsNewProps */
/** @typedef {import("./index.ts").CreateScorerConfig} CreateScorerConfig */
/**
 * @template Schema
 * @typedef {import("./index.ts").CreateSmithersApi<Schema>} CreateSmithersApi
 */
/** @typedef {import("./index.ts").DepsSpec} DepsSpec */
/** @typedef {import("./index.ts").EventFrame} EventFrame */
/**
 * @template S
 * @typedef {import("./index.ts").ExternalSmithersConfig<S>} ExternalSmithersConfig
 */
/** @typedef {import("./index.ts").GatewayAuthConfig} GatewayAuthConfig */
/** @typedef {import("./index.ts").GatewayDefaults} GatewayDefaults */
/** @typedef {import("./index.ts").GatewayOptions} GatewayOptions */
/** @typedef {import("./index.ts").GatewayTokenGrant} GatewayTokenGrant */
/** @typedef {import("./index.ts").GraphSnapshot} GraphSnapshot */
/** @typedef {import("./index.ts").HelloResponse} HelloResponse */
/** @typedef {import("./index.ts").HostContainer} HostContainer */
/** @typedef {import("./index.ts").HostNodeJson} HostNodeJson */
/** @typedef {import("./index.ts").InferDeps} InferDeps */
/**
 * @template T
 * @typedef {import("./index.ts").InferOutputEntry<T>} InferOutputEntry
 */
/**
 * @template TTable
 * @typedef {import("./index.ts").InferRow<TTable>} InferRow
 */
/** @typedef {import("./index.ts").JjRevertResult} JjRevertResult */
/** @typedef {import("./index.ts").KanbanProps} KanbanProps */
/** @typedef {import("./index.ts").KnownSmithersErrorCode} KnownSmithersErrorCode */
/** @typedef {import("./index.ts").LlmJudgeConfig} LlmJudgeConfig */
/** @typedef {import("./index.ts").MemoryFact} MemoryFact */
/** @typedef {import("./index.ts").MemoryLayerConfig} MemoryLayerConfig */
/** @typedef {import("./index.ts").MemoryMessage} MemoryMessage */
/** @typedef {import("./index.ts").MemoryNamespace} MemoryNamespace */
/** @typedef {import("./index.ts").MemoryNamespaceKind} MemoryNamespaceKind */
/** @typedef {import("./index.ts").MemoryProcessor} MemoryProcessor */
/** @typedef {import("./index.ts").MemoryProcessorConfig} MemoryProcessorConfig */
/** @typedef {import("./index.ts").MemoryServiceApi} MemoryServiceApi */
/** @typedef {import("./index.ts").MemoryStore} MemoryStore */
/** @typedef {import("./index.ts").MemoryThread} MemoryThread */
/** @typedef {import("./index.ts").MessageHistoryConfig} MessageHistoryConfig */
/**
 * @template CALL_OPTIONS
 * @template TOOLS
 * @typedef {import("./index.ts").OpenAIAgentOptions<CALL_OPTIONS, TOOLS>} OpenAIAgentOptions
 */
/** @typedef {import("./index.ts").OpenApiAuth} OpenApiAuth */
/** @typedef {import("./index.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("./index.ts").OpenApiToolsOptions} OpenApiToolsOptions */
/**
 * @template Schema
 * @typedef {import("./index.ts").OutputAccessor<Schema>} OutputAccessor
 */
/** @typedef {import("./index.ts").OutputKey} OutputKey */
/** @typedef {import("./index.ts").OutputTarget} OutputTarget */
/** @typedef {import("./index.ts").PiAgentOptions} PiAgentOptions */
/** @typedef {import("./index.ts").PiExtensionUiRequest} PiExtensionUiRequest */
/** @typedef {import("./index.ts").PiExtensionUiResponse} PiExtensionUiResponse */
/** @typedef {import("./index.ts").PollerProps} PollerProps */
/** @typedef {import("./index.ts").RequestFrame} RequestFrame */
/** @typedef {import("./index.ts").ResolvedSmithersObservabilityOptions} ResolvedSmithersObservabilityOptions */
/** @typedef {import("./index.ts").ResponseFrame} ResponseFrame */
/** @typedef {import("./index.ts").RevertOptions} RevertOptions */
/** @typedef {import("./index.ts").RevertResult} RevertResult */
/** @typedef {import("./index.ts").RunJjOptions} RunJjOptions */
/** @typedef {import("./index.ts").RunJjResult} RunJjResult */
/** @typedef {import("./index.ts").RunOptions} RunOptions */
/** @typedef {import("./index.ts").RunResult} RunResult */
/** @typedef {import("./index.ts").RunStatus} RunStatus */
/** @typedef {import("./index.ts").SagaProps} SagaProps */
/** @typedef {import("./index.ts").SagaStepDef} SagaStepDef */
/** @typedef {import("./index.ts").SagaStepProps} SagaStepProps */
/** @typedef {import("./index.ts").SamplingConfig} SamplingConfig */
/** @typedef {import("./index.ts").SandboxProps} SandboxProps */
/** @typedef {import("./index.ts").SandboxRuntime} SandboxRuntime */
/** @typedef {import("./index.ts").SandboxVolumeMount} SandboxVolumeMount */
/** @typedef {import("./index.ts").SandboxWorkspaceSpec} SandboxWorkspaceSpec */
/** @typedef {import("./index.ts").SchemaRegistryEntry} SchemaRegistryEntry */
/** @typedef {import("./index.ts").Scorer} Scorer */
/** @typedef {import("./index.ts").ScorerBinding} ScorerBinding */
/** @typedef {import("./index.ts").ScorerContext} ScorerContext */
/** @typedef {import("./index.ts").ScoreResult} ScoreResult */
/** @typedef {import("./index.ts").ScorerFn} ScorerFn */
/** @typedef {import("./index.ts").ScorerInput} ScorerInput */
/** @typedef {import("./index.ts").ScoreRow} ScoreRow */
/** @typedef {import("./index.ts").ScorersMap} ScorersMap */
/** @typedef {import("./index.ts").SemanticRecallConfig} SemanticRecallConfig */
/** @typedef {import("./index.ts").SerializedCtx} SerializedCtx */
/** @typedef {import("./index.ts").ServeOptions} ServeOptions */
/** @typedef {import("./index.ts").ServerOptions} ServerOptions */
/** @typedef {import("./index.ts").SignalProps} SignalProps */
/** @typedef {import("./index.ts").SmithersAlertLabels} SmithersAlertLabels */
/** @typedef {import("./index.ts").SmithersAlertPolicy} SmithersAlertPolicy */
/** @typedef {import("./index.ts").SmithersAlertPolicyDefaults} SmithersAlertPolicyDefaults */
/** @typedef {import("./index.ts").SmithersAlertPolicyRule} SmithersAlertPolicyRule */
/** @typedef {import("./index.ts").SmithersAlertReaction} SmithersAlertReaction */
/** @typedef {import("./index.ts").SmithersAlertReactionKind} SmithersAlertReactionKind */
/** @typedef {import("./index.ts").SmithersAlertReactionRef} SmithersAlertReactionRef */
/** @typedef {import("./index.ts").SmithersAlertSeverity} SmithersAlertSeverity */
/** @typedef {import("./index.ts").SmithersCtx} SmithersCtx */
/** @typedef {import("./index.ts").SmithersError} SmithersError */
/** @typedef {import("./index.ts").SmithersErrorCode} SmithersErrorCode */
/** @typedef {import("./index.ts").SmithersEvent} SmithersEvent */
/** @typedef {import("./index.ts").SmithersLogFormat} SmithersLogFormat */
/** @typedef {import("./index.ts").SmithersObservabilityOptions} SmithersObservabilityOptions */
/** @typedef {import("./index.ts").SmithersObservabilityService} SmithersObservabilityService */
/**
 * @template Schema
 * @typedef {import("./index.ts").SmithersWorkflow<Schema>} SmithersWorkflow
 */
/** @typedef {import("./index.ts").SmithersWorkflowOptions} SmithersWorkflowOptions */
/** @typedef {import("./index.ts").TaskDescriptor} TaskDescriptor */
/** @typedef {import("./index.ts").TaskMemoryConfig} TaskMemoryConfig */
/** @typedef {import("./index.ts").TaskProps} TaskProps */
/** @typedef {import("./index.ts").TimerProps} TimerProps */
/** @typedef {import("./index.ts").TimeTravelOptions} TimeTravelOptions */
/** @typedef {import("./index.ts").TimeTravelResult} TimeTravelResult */
/** @typedef {import("./index.ts").TryCatchFinallyProps} TryCatchFinallyProps */
/** @typedef {import("./index.ts").WaitForEventProps} WaitForEventProps */
/**
 * @template T
 * @typedef {import("./index.ts").WorkingMemoryConfig<T>} WorkingMemoryConfig
 */
/** @typedef {import("./index.ts").WorkspaceAddOptions} WorkspaceAddOptions */
/** @typedef {import("./index.ts").WorkspaceInfo} WorkspaceInfo */
/** @typedef {import("./index.ts").WorkspaceResult} WorkspaceResult */
/** @typedef {import("./index.ts").XmlElement} XmlElement */
/** @typedef {import("./index.ts").XmlNode} XmlNode */
/** @typedef {import("./index.ts").XmlText} XmlText */
// @smithers-type-exports-end

export { hashCapabilityRegistry } from "@smithers/agents/capability-registry";
export { ERROR_REFERENCE_URL, } from "@smithers/errors/ERROR_REFERENCE_URL";
export { SmithersError as SmithersErrorInstance, } from "@smithers/errors/SmithersError";
export { errorToJson } from "@smithers/errors/errorToJson";
export { getSmithersErrorDefinition } from "@smithers/errors/getSmithersErrorDefinition";
export { getSmithersErrorDocsUrl } from "@smithers/errors/getSmithersErrorDocsUrl";
export { isKnownSmithersErrorCode } from "@smithers/errors/isKnownSmithersErrorCode";
export { isSmithersError } from "@smithers/errors/isSmithersError";
export { knownSmithersErrorCodes } from "@smithers/errors/knownSmithersErrorCodes";
// Components
export { Approval, approvalDecisionSchema, approvalRankingSchema, approvalSelectionSchema, Workflow, Task, Sequence, Parallel, MergeQueue, Branch, Loop, Ralph, ContinueAsNew, continueAsNew, Worktree, Sandbox, Kanban, Poller, Saga, TryCatchFinally, Signal, Timer, WaitForEvent, } from "@smithers/components";
// Agents
export { AnthropicAgent, OpenAIAgent, AmpAgent, ClaudeCodeAgent, CodexAgent, GeminiAgent, PiAgent, KimiAgent, ForgeAgent, } from "@smithers/agents";
// VCS
export { runJj, getJjPointer, revertToJjPointer, isJjRepo, workspaceAdd, workspaceList, workspaceClose, } from "@smithers/vcs/jj";
// Core API
export { createSmithers } from "./create.js";
export { runWorkflow, renderFrame } from "@smithers/engine";
export { signalRun } from "@smithers/engine/signals";
export { usePatched } from "@smithers/engine/effect/versioning";
// Tools
export { getDefinedToolMetadata } from "@smithers/engine/getDefinedToolMetadata";
// Server
export { startServer } from "@smithers/server";
export { Gateway } from "@smithers/server/gateway";
// Serve (Hono-based single-workflow HTTP server)
export { createServeApp } from "@smithers/server/serve";
// Observability
export { SmithersObservability, createSmithersObservabilityLayer, createSmithersOtelLayer, createSmithersRuntimeLayer, smithersMetrics, trackSmithersEvent, activeNodes, activeRuns, externalWaitAsyncPending, approvalsDenied, approvalsGranted, approvalsRequested, timerDelayDuration, timersCancelled, timersCreated, timersFired, timersPending, attemptDuration, cacheHits, cacheMisses, dbQueryDuration, dbRetries, dbTransactionDuration, dbTransactionRetries, dbTransactionRollbacks, hotReloadDuration, hotReloadFailures, hotReloads, httpRequestDuration, httpRequests, nodeDuration, nodesFailed, nodesFinished, nodesStarted, prometheusContentType, renderPrometheusMetrics, resolveSmithersObservabilityOptions, runsTotal, sandboxActive, sandboxBundleSizeBytes, sandboxCompletedTotal, sandboxCreatedTotal, sandboxDurationMs, sandboxPatchCount, sandboxTransportDurationMs, schedulerQueueDepth, toolCallsTotal, toolDuration, vcsDuration, } from "@smithers/observability";
// DB
export { SmithersDb } from "@smithers/db/adapter";
export { ensureSmithersTables } from "@smithers/db/ensure";
// Renderer
export { SmithersRenderer } from "@smithers/react-reconciler/dom/renderer";
// External / multi-language
export { createExternalSmithers } from "./external/index.js";
// Revert
export { revertToAttempt } from "@smithers/time-travel/revert";
export { timeTravel } from "@smithers/time-travel/timetravel";
// Scorers
export { createScorer, llmJudge, relevancyScorer, toxicityScorer, faithfulnessScorer, schemaAdherenceScorer, latencyScorer, runScorersAsync, runScorersBatch, aggregateScores, smithersScorers, } from "@smithers/scorers";
// Memory
export { createMemoryStore, createMemoryLayer, MemoryService, TtlGarbageCollector, TokenLimiter, Summarizer, namespaceToString, parseNamespace, memoryFactReads, memoryFactWrites, memoryRecallQueries, memoryMessageSaves, memoryRecallDuration, } from "@smithers/memory";
// OpenAPI Tools
export { createOpenApiTools, createOpenApiToolsSync, createOpenApiTool, createOpenApiToolSync, listOperations, openApiToolCallsTotal, openApiToolCallErrorsTotal, openApiToolDuration, } from "@smithers/openapi";
// Utilities
export { mdxPlugin } from "./mdx-plugin.js";
export { markdownComponents } from "@smithers/components/markdownComponents";
export { renderMdx } from "@smithers/components/renderMdx";
export { zodToTable } from "@smithers/db/zodToTable";
export { zodToCreateTableSQL } from "@smithers/db/zodToCreateTableSQL";
export { camelToSnake } from "@smithers/db/utils/camelToSnake";
export { unwrapZodType } from "@smithers/db/unwrapZodType";
export { zodSchemaToJsonExample } from "@smithers/components/zod-to-example";
