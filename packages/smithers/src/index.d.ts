import * as _smithers_orchestrator_components from '@smthrs/components';
import { Sequence, Parallel, MergeQueue, Branch, Loop, Ralph, ContinueAsNew, continueAsNew, Worktree, Timer, UI, TUI, ApprovalDecision as ApprovalDecision$1, OutputTarget as OutputTarget$1, ApprovalProps as ApprovalProps$2, DepsSpec as DepsSpec$2, InferDeps as InferDeps$1, SignalProps as SignalProps$2, TaskProps as TaskProps$2 } from '@smthrs/components';
export { Approval, ApprovalGate, Aspects, BackpressurePlanning, Branch, CheckSuite, ClassifyAndRoute, ContentPipeline, ContinueAsNew, DC_EDIT_SIGNAL, DC_SKIP_PREVIEW_SIGNAL, DEFAULT_DELEGATION_V2_LIMITS, DEFAULT_TIER_ORDER, DELEGATION_V2_COMPILER_VERSION, DELEGATION_V2_PROGRAM_VERSION, DELEGATION_V2_PROTOCOL_VERSION, DELEGATION_V2_REGISTRY_VERSION, DELEGATION_V2_RUNTIME_VERSION, DELEGATION_V2_SETTLEMENT_VERSION, Debate, DecisionTable, DelegationChain, DelegationEditListener, DelegationExecution, DelegationPlanning, DelegationPreview, DelegationScoring, DeriskLoop, DriftDetector, EscalationChain, GatherAndSynthesize, GoalRefinement, HumanTask, Kanban, Loop, MONITOR_CONDITIONS, MONITOR_DEFAULT_AUTO_HEAL, MONITOR_TERMINAL_STATUSES, Memory, MergeQueue, Monitor, Optimizer, Panel, Parallel, Poller, Ralph, ReviewLoop, Runbook, Saga, SagaStep, Sandbox, ScanFixVerify, Sequence, Sidecar, Signal, Subflow, SuperSmithers, Supervisor, TUI, Task, Timer, Trellis, TryCatchFinally, UI, WaitForEvent, Workflow, Worktree, approvalDecisionSchema, approvalRankingSchema, approvalSelectionSchema, captureWorkingCopyCommit, compileDelegationV2Program, computeSidecarDelta, continueAsNew, dcApprovalSchema, dcBudgetSchema, dcDevPreviewSchema, dcEditSchema, dcExecSchema, dcForecastSchema, dcGatesSchema, dcGoalApprovalSchema, dcGoalSchema, dcPlanSchema, dcPollSchema, dcPreviewSchema, dcProbeSchema, dcQuestionSchema, dcReplanSchema, dcReviewSchema, dcScoreSchema, dcSkipSchema, delegationPrompts, delegationSchemas, delegationV2AssignmentDigest, delegationV2ProgramDigest, delegationV2Schemas, devPreviewKindSchema, enforceDelegationV2AuthorFuel, estimateSchema, gateSchema, monitorAuthorityRules, monitorEvidenceRules, monitorHealthSignals, monitorPrompt, monitorReadPathRules, partitionDelegationV2AuthorFuel, settleDelegationV2Envelope, tierSchema, trellisPrompts, validateWorkflowProgram, withCommitRange } from '@smthrs/components';
import * as zod from 'zod';
import { z } from 'zod';
import * as _smithers_orchestrator_graph_XmlNode from '@smthrs/graph/XmlNode';
import * as _smithers_orchestrator_time_travel_timetravel from '@smthrs/time-travel/timetravel';
export { timeTravel } from '@smthrs/time-travel/timetravel';
import * as _smithers_orchestrator_graph_TaskDescriptor from '@smthrs/graph/TaskDescriptor';
import * as _smithers_orchestrator_components_SmithersWorkflow from '@smthrs/components/SmithersWorkflow';
import { SmithersWorkflow as SmithersWorkflow$1 } from '@smthrs/components/SmithersWorkflow';
import * as _smithers_orchestrator_observability_SmithersEvent from '@smthrs/observability/SmithersEvent';
import { SmithersEvent as SmithersEvent$1 } from '@smthrs/observability/SmithersEvent';
import * as _smithers_orchestrator_errors_SmithersErrorCode from '@smthrs/errors/SmithersErrorCode';
import * as _smithers_orchestrator_errors_SmithersError from '@smthrs/errors/SmithersError';
export { SmithersError as SmithersErrorInstance } from '@smthrs/errors/SmithersError';
import * as _smithers_orchestrator_driver_SmithersCtx from '@smthrs/driver/SmithersCtx';
import { SmithersCtx as SmithersCtx$1 } from '@smthrs/driver/SmithersCtx';
import * as _smithers_orchestrator_scheduler_SmithersWorkflowOptions from '@smthrs/scheduler/SmithersWorkflowOptions';
import { SmithersAlertPolicy as SmithersAlertPolicy$1, SmithersWorkflowOptions as SmithersWorkflowOptions$1 } from '@smthrs/scheduler/SmithersWorkflowOptions';
import * as _smithers_orchestrator_server from '@smthrs/server';
export { startServer } from '@smthrs/server';
import * as _smithers_orchestrator_server_serve from '@smthrs/server/serve';
export { createServeApp } from '@smthrs/server/serve';
import { OutputSnapshot } from '@smthrs/driver/OutputSnapshot';
import * as _smithers_orchestrator_db_SchemaRegistryEntry from '@smthrs/db/SchemaRegistryEntry';
import * as _smithers_orchestrator_driver_RunStatus from '@smthrs/driver/RunStatus';
import * as _smithers_orchestrator_driver_RunResult from '@smthrs/driver/RunResult';
import * as _smithers_orchestrator_driver_SmithersErrorReport from '@smthrs/driver/SmithersErrorReport';
import * as _smithers_orchestrator_driver_RunStartedBy from '@smthrs/driver/RunStartedBy';
import * as _smithers_orchestrator_driver_RunOptions from '@smthrs/driver/RunOptions';
import * as _smithers_orchestrator_time_travel_revert from '@smthrs/time-travel/revert';
export { revertToAttempt } from '@smthrs/time-travel/revert';
import * as _smithers_orchestrator_observability from '@smthrs/observability';
export { SmithersObservability, activeNodes, activeRuns, approvalsDenied, approvalsGranted, approvalsRequested, attemptDuration, cacheHits, cacheMisses, createSmithersObservabilityLayer, createSmithersOtelLayer, createSmithersRuntimeLayer, dbQueryDuration, dbRetries, dbTransactionDuration, dbTransactionRetries, dbTransactionRollbacks, externalWaitAsyncPending, hotReloadDuration, hotReloadFailures, hotReloads, httpRequestDuration, httpRequests, nodeDuration, nodesFailed, nodesFinished, nodesStarted, prometheusContentType, renderPrometheusMetrics, resolveSmithersObservabilityOptions, runsTotal, sandboxActive, sandboxBundleSizeBytes, sandboxCompletedTotal, sandboxCreatedTotal, sandboxDurationMs, sandboxPatchCount, sandboxTransportDurationMs, schedulerQueueDepth, smithersMetrics, timerDelayDuration, timersCancelled, timersCreated, timersFired, timersPending, toolCallsTotal, toolDuration, trackSmithersEvent, vcsDuration } from '@smthrs/observability';
import * as _smithers_orchestrator_graph_ProofBinding from '@smthrs/graph/ProofBinding';
import * as _smithers_orchestrator_driver_OutputKey from '@smthrs/driver/OutputKey';
import * as _smithers_orchestrator_openapi from '@smthrs/openapi';
export { createOpenApiTool, createOpenApiToolSync, createOpenApiTools, createOpenApiToolsSync, listOperations, openApiToolCallErrorsTotal, openApiToolCallsTotal, openApiToolDuration } from '@smthrs/openapi';
import * as ai from 'ai';
import { Tool } from 'ai';
import * as _smithers_orchestrator_memory from '@smthrs/memory';
export { HindsightMemoryStore, LocalMemoryRuntime, MemoryService, Summarizer, TokenLimiter, TtlGarbageCollector, createHindsightMemoryStore, createLocalMemoryRuntime, createMemoryLayer, createMemoryStore, memoryFactReads, memoryFactWrites, memoryMessageSaves, memoryRecallDuration, memoryRecallQueries, namespaceToString, parseNamespace } from '@smthrs/memory';
import * as _smithers_orchestrator_errors_KnownSmithersErrorCode from '@smthrs/errors/KnownSmithersErrorCode';
import * as _smithers_orchestrator_vcs_jj from '@smthrs/vcs/jj';
export { getJjPointer, isJjRepo, revertToJjPointer, runJj, workspaceAdd, workspaceClose, workspaceList } from '@smthrs/vcs/jj';
import * as _smithers_orchestrator_driver_OutputAccessor from '@smthrs/driver/OutputAccessor';
import * as _smithers_orchestrator_react_reconciler_dom_renderer from '@smthrs/react-reconciler/dom/renderer';
export { SmithersRenderer } from '@smthrs/react-reconciler/dom/renderer';
import * as _smithers_orchestrator_graph_GraphSnapshot from '@smthrs/graph/GraphSnapshot';
import * as _smithers_orchestrator_agents_AgentLike from '@smthrs/agents/AgentLike';
import { AgentLike as AgentLike$1 } from '@smthrs/agents/AgentLike';
import React from 'react';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { ApprovalProps as ApprovalProps$1 } from '@smthrs/components/components/ApprovalProps';
import { DepsSpec as DepsSpec$1 } from '@smthrs/components/components/DepsSpec';
import { SandboxProps as SandboxProps$1 } from '@smthrs/components/components/SandboxProps';
import { SignalProps as SignalProps$1 } from '@smthrs/components/components/SignalProps';
import { TaskProps as TaskProps$1 } from '@smthrs/components/components/TaskProps';
import { WorkflowProps } from '@smthrs/components/components/WorkflowProps';
import * as _smithers_orchestrator_server_gateway from '@smthrs/server/gateway';
export { Gateway } from '@smthrs/server/gateway';
import * as _smithers_orchestrator_scorers from '@smthrs/scorers';
export { aggregateScores, createScorer, estimateCostUsd, faithfulnessScorer, latencyScorer, llmJudge, modelTokenPrices, relevancyScorer, runScorersAsync, runScorersBatch, schemaAdherenceScorer, smithersScorers, toxicityScorer } from '@smthrs/scorers';
import * as _smithers_orchestrator_agents from '@smthrs/agents';
export { AmpAgent, AnthropicAgent, AntigravityAgent, ClaudeCodeAgent, CodexAgent, CursorAgent, DEFAULT_AGENT_CHECKPOINT_MAX_BYTES, ForgeAgent, GeminiAgent, HermesAgent, HermesCliAgent, KimiAgent, OmpAgent, OpenAIAgent, OpenClawAgent, OpenCodeAgent, PiAgent, PoolAgent, VibeAgent, agentProducesCheckpoint, agentSupportsCheckpoint, cloneAgentCheckpoint, createHttpTool, createOmpCapabilityRegistry, hashAgentCheckpointCapabilities } from '@smthrs/agents';
import * as _smithers_orchestrator_agents_capability_registry from '@smthrs/agents/capability-registry';
export { hashCapabilityRegistry } from '@smthrs/agents/capability-registry';
export { ERROR_REFERENCE_URL } from '@smthrs/errors/ERROR_REFERENCE_URL';
export { Smithers, approveNode, closeSingleRunnerRuntime, denyNode, fragment, getRun, listRuns, renderFrame, reopenSingleRunnerRuntime, runWorkflow, workflow } from '@smthrs/engine';
export { SmithersDb, loadOutputs, loadOutputsEffect } from '@smthrs/db';
import { SmithersDb } from '@smthrs/db/adapter';
export { camelToSnake } from '@smthrs/db/utils/camelToSnake';
export { ensureSmithersTables } from '@smthrs/db/ensure';
export { errorToJson } from '@smthrs/errors/errorToJson';
export { executeChildWorkflow } from '@smthrs/engine/child-workflow';
export { getSmithersErrorDefinition } from '@smthrs/errors/getSmithersErrorDefinition';
export { getSmithersErrorDocsUrl } from '@smthrs/errors/getSmithersErrorDocsUrl';
export { isKnownSmithersErrorCode } from '@smthrs/errors/isKnownSmithersErrorCode';
export { isSmithersError } from '@smthrs/errors/isSmithersError';
export { knownSmithersErrorCodes } from '@smthrs/errors/knownSmithersErrorCodes';
export { markdownComponents } from '@smthrs/components/markdownComponents';
import * as _smithers_orchestrator_driver_MemoryRuntimeService from '@smthrs/driver/MemoryRuntimeService';
export { renderMdx } from '@smthrs/components/renderMdx';
export { resolveWorktreePath } from '@smthrs/graph';
export { signalRun } from '@smthrs/engine/signals';
export { syncZodTableSchema, zodSchemaColumns, zodToCreateTableSQL } from '@smthrs/db/zodToCreateTableSQL';
export { unwrapZodType } from '@smthrs/db/unwrapZodType';
export { usePatched } from '@smthrs/engine/effect/versioning';
export { zodSchemaToJsonExample } from '@smthrs/components/zod-to-example';
export { zodToTable } from '@smthrs/db/zodToTable';

type SerializedCtx$1 = {
    runId: string;
    iteration: number;
    iterations: Record<string, number>;
    input: unknown;
    outputs: OutputSnapshot;
};

type HostNodeJson$1 = {
    kind: "element";
    tag: string;
    props: Record<string, string>;
    rawProps: Record<string, any>;
    children: HostNodeJson$1[];
} | {
    kind: "text";
    text: string;
};

type ExternalSmithersConfig$2<S extends Record<string, z.ZodObject<z.ZodRawShape>>> = {
    schemas: S;
    agents: Record<string, AgentLike$1>;
    /** Synchronous build function that returns a HostNode JSON tree. */
    buildFn: (ctx: SerializedCtx$1) => HostNodeJson$1;
    dbPath?: string;
};

type SmithersMigrationResult$1 = {
    backend: "sqlite" | "pglite" | "postgres";
    source: {
        backend: "sqlite" | "pglite" | "postgres";
        dbPath?: string;
        dataDir?: string;
        url?: string;
    };
    dbPath: string;
    markerPath: string;
    target: {
        backend: "sqlite" | "pglite" | "postgres";
        dbPath?: string;
        dataDir?: string;
        url?: string;
    };
    runCount: number;
    schemaVersion: string;
    durationMs: number;
    tables: Array<{
        table: string;
        sourceRows: number;
        targetRows: number;
        durationMs: number;
    }>;
    sqliteRemoved: boolean;
};

type MigrateSmithersStoreOptions$2 = {
    cwd?: string;
    dbPath?: string;
    from?: "sqlite" | "pglite" | "postgres";
    to?: "sqlite" | "pglite" | "postgres";
    url?: string;
    env?: Record<string, string | undefined>;
    pgliteDataDir?: string;
    keepSqlite?: boolean;
    batchSize?: number;
    onProgress?: (event: {
        type: "table-start";
        table?: string;
        sourceRows?: number;
    } | {
        type: "table-copied";
        table?: string;
        copiedRows?: number;
        sourceRows?: number;
        targetRows?: number;
        durationMs?: number;
    } | {
        type: "done";
        copiedRows?: number;
        tableCount?: number;
        durationMs?: number;
    }) => void | Promise<void>;
};

type CreateSmithersOptions$2 = {
    readableName?: string;
    description?: string;
    alertPolicy?: SmithersAlertPolicy$1;
    dbPath?: string;
    journalMode?: string;
    /**
     * Maximum connections in the process-local PostgreSQL pool for this URL.
     * Defaults to 16; all owners of one normalized URL must use one value.
     * Exceeding it fails an acquire with `PG_POOL_SATURATED` rather than queueing
     * forever.
     */
    postgresPoolMax?: number;
    /**
     * Backend the caller resolved this API to. The synchronous `createSmithers`
     * only serves `"sqlite"`; `"pglite"`/`"postgres"` require the async
     * `openSmithersBackend` factory and fail loud here rather than silently
     * opening bun:sqlite.
     */
    backend?: "sqlite" | "pglite" | "postgres";
};

type SmithersBackend = "sqlite" | "pglite" | "postgres";
type OpenSmithersBackendOptions$1 = CreateSmithersOptions$2 & {
    backend?: SmithersBackend;
    cwd?: string;
    configPath?: string;
    env?: Record<string, string | undefined>;
    connectionString?: string;
    connection?: object;
    pgliteDataDir?: string;
};

/** Union of all Zod schema values registered in the schema, constrained to ZodObject. */
type SchemaOutput<Schema> = Extract<Schema[keyof Schema], z.ZodObject<z.ZodRawShape>>;
type RuntimeSchema<Schema> = Schema extends {
    input: infer Input;
} ? Omit<Schema, "input"> & {
    input: Input extends z.ZodTypeAny ? z.infer<Input> : Input;
} : Schema;
type CreateSmithersApi$1<Schema = unknown> = {
    Workflow: (props: WorkflowProps) => React.ReactElement;
    Approval: <Row>(props: ApprovalProps$1<Row, SchemaOutput<Schema>>) => React.ReactElement;
    Task: <Row, D extends DepsSpec$1 = {}>(props: TaskProps$1<Row, SchemaOutput<Schema>, D>) => React.ReactElement;
    Sequence: typeof Sequence;
    Parallel: typeof Parallel;
    MergeQueue: typeof MergeQueue;
    Branch: typeof Branch;
    Loop: typeof Loop;
    Ralph: typeof Ralph;
    ContinueAsNew: typeof ContinueAsNew;
    continueAsNew: typeof continueAsNew;
    Worktree: typeof Worktree;
    Sandbox: (props: SandboxProps$1) => React.ReactElement;
    Signal: <SignalSchema extends z.ZodObject<z.ZodRawShape>>(props: SignalProps$1<SignalSchema>) => React.ReactElement;
    Timer: typeof Timer;
    UI: typeof UI;
    TUI: typeof TUI;
    useCtx: () => SmithersCtx$1<RuntimeSchema<Schema>>;
    smithers: (build: (ctx: SmithersCtx$1<RuntimeSchema<Schema>>) => React.ReactElement, opts?: SmithersWorkflowOptions$1) => SmithersWorkflow$1<RuntimeSchema<Schema>>;
    db: BunSQLiteDatabase<Record<string, unknown>>;
    tables: {
        [K in keyof Schema]: unknown;
    };
    outputs: {
        [K in keyof Schema]: Schema[K];
    };
};

/**
 * Resolve the storage backend and open the matching Smithers API. Delegates the
 * backend resolution and the fail-loud migration gate to
 * {@link resolveSmithersBackendChoice} so the gateway/server boot path and the
 * CLI read commands enforce the identical contract.
 *
 * @template {Record<string, import("zod").ZodObject<any>>} Schemas
 * @param {Schemas} schemas
 * @param {import("./OpenSmithersBackendOptions.ts").OpenSmithersBackendOptions} [opts]
 * @returns {Promise<import("./CreateSmithersApi.ts").CreateSmithersApi<Schemas> & {
 *   close?: () => Promise<void>;
 *   memoryStore: import("@smthrs/memory").MemoryStore;
 *   memoryService: import("@smthrs/driver/MemoryRuntimeService").MemoryRuntimeService;
 * }>}
 */
declare function openSmithersBackend<Schemas extends Record<string, zod.ZodObject<any>>>(schemas?: Schemas, opts?: OpenSmithersBackendOptions$1): Promise<CreateSmithersApi$1<Schemas> & {
    close?: () => Promise<void>;
    memoryStore: _smithers_orchestrator_memory.MemoryStore;
    memoryService: _smithers_orchestrator_driver_MemoryRuntimeService.MemoryRuntimeService;
}>;

type SmithersBackendChoice = {
    backend: "sqlite" | "pglite" | "postgres";
    source: "options" | "env" | "config" | "marker" | "default";
    dbPath: string;
    workspaceRoot: string;
    runCount: number;
    schemaVersion: string;
    sqlite: {
        dbPath: string;
        exists: boolean;
        runCount: number;
        schemaVersion: string;
    };
    pglite: {
        dataDir: string;
        exists: boolean;
        initialized: boolean;
        probed: boolean;
        hasRunsTable?: boolean;
        runCount?: number;
        schemaVersion?: string;
        error?: string;
    };
    postgres: {
        exists: boolean;
        initialized: boolean;
        hasRunsTable?: boolean;
        runCount: number;
        schemaVersion: string;
        connectionString?: "set";
        error?: string;
    };
    migratedMarker: boolean;
};

type OpenSmithersStoreResult = {
    choice: SmithersBackendChoice;
    adapter: SmithersDb;
    db: unknown;
    dbPath?: string;
    cleanup: () => Promise<void> | void;
};

type OpenSmithersStoreOptions = OpenSmithersBackendOptions$1 & {
    mode?: "read" | "write";
    wait?: {
        timeoutMs?: number;
        intervalMs?: number;
    };
};

/**
 * Resolve the Smithers backend once, open exactly that store, and return the
 * low-level SmithersDb adapter used by CLI/server read paths.
 *
 * @param {import("./OpenSmithersStoreOptions.ts").OpenSmithersStoreOptions} [opts]
 * @returns {Promise<import("./OpenSmithersStoreResult.ts").OpenSmithersStoreResult>}
 */
declare function openSmithersStore(opts?: OpenSmithersStoreOptions): Promise<OpenSmithersStoreResult>;

/**
 * One-shot copy from the legacy bun:sqlite Smithers store to PGlite/Postgres.
 *
 * @param {MigrateSmithersStoreOptions} [opts]
 * @returns {Promise<MigrateSmithersStoreResult>}
 */
declare function migrateSmithersStore(opts?: MigrateSmithersStoreOptions$1): Promise<MigrateSmithersStoreResult>;
type MigrateSmithersStoreOptions$1 = MigrateSmithersStoreOptions$2;
type MigrateSmithersStoreResult = SmithersMigrationResult$1;

/**
 * Create a SmithersWorkflow from an external build function.
 *
 * Schemas and agents are defined in TS. The build function produces a HostNode JSON tree
 * that maps 1:1 to what the JSX renderer would produce.
 *
 * @template {Record<string, import("zod").ZodObject<any>>} S
 * @param {ExternalSmithersConfig<S>} config
 * @returns {import("@smthrs/components/SmithersWorkflow").SmithersWorkflow<S> & { tables: Record<string, any>; cleanup: () => void }}
 */
declare function createExternalSmithers<S extends Record<string, zod.ZodObject<any>>>(config: ExternalSmithersConfig$1<S>): _smithers_orchestrator_components_SmithersWorkflow.SmithersWorkflow<S> & {
    tables: Record<string, any>;
    cleanup: () => void;
};
type ExternalSmithersConfig$1<S> = ExternalSmithersConfig$2<S>;

declare function mdxPlugin(): void;

/**
 * Schema-driven API — users define only Zod schemas, the framework owns the entire storage layer.
 *
 * @template {Record<string, import("zod").ZodObject<any>>} Schemas
 * @param {Schemas} schemas
 * @param {CreateSmithersOptions} [opts]
 * @returns {import("./CreateSmithersApi.ts").CreateSmithersApi<Schemas>}
 *
 * @example
 * ```ts
 * const { Workflow, Task, smithers, outputs } = createSmithers({
 *   discover: discoverOutputSchema,
 *   research: researchOutputSchema,
 * });
 *
 * export default smithers((ctx) => (
 *   <Workflow name="my-workflow">
 *     <Task id="discover" output={outputs.discover} agent={myAgent}>...</Task>
 *   </Workflow>
 * ));
 * ```
 */
declare function createSmithers<Schemas extends Record<string, zod.ZodObject<any>>>(schemas: Schemas, opts?: CreateSmithersOptions$1): CreateSmithersApi$1<Schemas>;
/**
 * Cloudflare-native SQLite backend for Workers/Durable Objects. Pass a descriptor
 * produced by `createCloudflareDurableObjectSqliteDescriptor()` or
 * `createCloudflareD1SqliteDescriptor()` from `smithers-orchestrator/cloudflare`.
 *
 * @template {Record<string, import("zod").ZodObject<any>>} Schemas
 * @param {Schemas} schemas
 * @param {CreateSmithersOptions & { db: unknown; close?: () => Promise<void> | void }} opts
 * @returns {Promise<import("./CreateSmithersApi.ts").CreateSmithersApi<Schemas> & { close?: () => Promise<void> }>}
 */
declare function createSmithersCloudflare<Schemas extends Record<string, zod.ZodObject<any>>>(schemas: Schemas, opts: CreateSmithersOptions$1 & {
    db: unknown;
    close?: () => Promise<void> | void;
}): Promise<CreateSmithersApi$1<Schemas> & {
    close?: () => Promise<void>;
}>;
/**
 * PostgreSQL/PGlite-backed equivalent of {@link createSmithers}. Asynchronous
 * because connecting and provisioning schema over the wire is async (unlike the
 * synchronous bun:sqlite path). Boots a node-postgres connection (`provider:
 * "postgres"`) or an embedded PGlite over a local socket (`provider: "pglite"`),
 * provisions the durable engine schema + the per-Zod-schema output tables with
 * Postgres-typed DDL, and returns the same createSmithers API surface plus a
 * `close()` teardown for the connection.
 *
 * @template {Record<string, import("zod").ZodObject<any>>} Schemas
 * @param {Schemas} schemas
 * @param {CreateSmithersOptions & { env?: Record<string, string | undefined> } & ({ provider: "postgres"; connectionString?: string; connection?: object } | { provider: "pglite"; dataDir?: string })} opts
 * @returns {Promise<import("./CreateSmithersApi.ts").CreateSmithersApi<Schemas> & { close: () => Promise<void> }>}
 */
declare function createSmithersPostgres<Schemas extends Record<string, zod.ZodObject<any>>>(schemas: Schemas, opts: CreateSmithersOptions$1 & {
    env?: Record<string, string | undefined>;
} & ({
    provider: "postgres";
    connectionString?: string;
    connection?: object;
} | {
    provider: "pglite";
    dataDir?: string;
})): Promise<CreateSmithersApi$1<Schemas> & {
    close: () => Promise<void>;
}>;
type CreateSmithersOptions$1 = CreateSmithersOptions$2;

/**
 * The backend a workspace selects and the precedence level that chose it,
 * resolved without booting or probing any store.
 */
type SmithersBackendPreference = {
    backend: "sqlite" | "pglite" | "postgres";
    source: "options" | "env" | "config" | "marker" | "default";
    workspaceRoot: string;
    /** Set when `options.backend` supplied the answer. */
    explicitBackend?: "sqlite" | "pglite" | "postgres";
    /** Set when `SMITHERS_BACKEND` supplied the answer. */
    envBackend?: "sqlite" | "pglite" | "postgres";
    /** Set when `.smithers/smithers.config.ts` supplied the answer. */
    configBackend?: "sqlite" | "pglite" | "postgres";
    migratedMarker: {
        exists: boolean;
        backend?: "sqlite" | "pglite" | "postgres";
    };
};

type ResolveSmithersBackendChoiceOptions = {
    backend?: "sqlite" | "pglite" | "postgres";
    cwd?: string;
    dbPath?: string;
    pgliteDataDir?: string;
    connectionString?: string;
    connection?: {
        query?: (...args: any[]) => Promise<any>;
    };
    configPath?: string;
    env?: Record<string, string | undefined>;
};

/**
 * Which backend this workspace selects, and why, without touching a single
 * store. `resolveSmithersBackendChoice` boots and probes the physical stores to
 * describe them; callers that only need to know "sqlite or not" must use this
 * instead, so an operator's `--backend` / `SMITHERS_BACKEND` / config pin is
 * honored everywhere rather than only on the paths that happen to call the full
 * resolver. Reading a marker file directly is what let a stale `migrated.json`
 * override an explicit pin and lock `smithers oneshot` out of a workspace.
 *
 * Precedence is the same as the full resolver: explicit → env → config →
 * `.smithers/backend.json` → `.smithers/migrated.json` → `sqlite`.
 *
 * @param {import("./ResolveSmithersBackendChoiceOptions.ts").ResolveSmithersBackendChoiceOptions} [opts]
 * @returns {Promise<import("./SmithersBackendPreference.ts").SmithersBackendPreference>}
 */
declare function resolveSmithersBackendPreference(opts?: ResolveSmithersBackendChoiceOptions): Promise<SmithersBackendPreference>;
/**
 * Resolve the storage backend (explicit → env → `.smithers/smithers.config.ts` →
 * default `sqlite`) and enforce the fail-loud migration gate shared by every
 * Smithers boot path (the async backend factory and the CLI read commands). A
 * legacy bun:sqlite store that still holds run data with no `migrated.json`
 * marker is never silently switched onto pglite/postgres: it throws
 * SMITHERS_MIGRATION_REQUIRED so the caller can migrate or pin `--backend sqlite`.
 *
 * @param {import("./ResolveSmithersBackendChoiceOptions.ts").ResolveSmithersBackendChoiceOptions} [opts]
 * @returns {Promise<import("./SmithersBackendChoice.ts").SmithersBackendChoice>}
 */
declare function resolveSmithersBackendChoice(opts?: ResolveSmithersBackendChoiceOptions): Promise<SmithersBackendChoice>;

type ToolContext = {
  db: SmithersDb;
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  idempotencyKey?: string | null;
  rootDir: string;
  allowNetwork: boolean;
  maxOutputBytes: number;
  timeoutMs: number;
  seq: number;
  emitEvent?: (event: SmithersEvent$1) => void | Promise<void>;
};

type DefinedToolContext = ToolContext & {
  idempotencyKey: string | null;
  toolName: string;
  sideEffect: boolean;
  idempotent: boolean;
};

type ToolRevertContext<Output = unknown> = {
  output: Output | null;
  effectStatus: "succeeded" | "unknown";
  idempotencyKey: string | null;
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  toolCallSeq: number;
};

type DefineToolOptions<Schema extends z.ZodTypeAny, Result> = {
  name: string;
  description?: string;
  schema: Schema;
  sideEffect?: boolean;
  idempotent?: boolean;
  execute: (
    args: z.infer<Schema>,
    ctx: DefinedToolContext,
  ) => Promise<Result> | Result;
  revert?: (
    args: z.infer<Schema>,
    ctx: ToolRevertContext<Awaited<Result>>,
  ) => Promise<void>;
};

type DefinedToolMetadata = {
  name: string;
  sideEffect: boolean;
  idempotent: boolean;
  acceptsIdempotencyKey: boolean;
  hasRevert: boolean;
  revert?: (args: unknown, ctx: ToolRevertContext) => Promise<void>;
};

/**
 * A tool produced by {@link defineTool} — an `ai` SDK {@link Tool} whose input
 * type has been narrowed from its Zod schema and whose output type is the
 * caller-declared `Result`.
 */
type DefinedTool<Schema extends z.ZodTypeAny, Result> = Tool<
  z.infer<Schema>,
  Result
>;
declare function getDefinedToolMetadata(
  value: unknown,
): DefinedToolMetadata | null;
declare function defineTool<
  Schema extends z.ZodTypeAny,
  Result,
>(options: DefineToolOptions<Schema, Result>): DefinedTool<Schema, Result>;

declare const read: DefinedTool<
  z.ZodObject<{ path: z.ZodString }>,
  string
>;
declare const write: DefinedTool<
  z.ZodObject<{ path: z.ZodString; content: z.ZodString }>,
  "ok"
>;
declare const edit: DefinedTool<
  z.ZodObject<{ path: z.ZodString; patch: z.ZodString }>,
  "ok"
>;
declare const grep: DefinedTool<
  z.ZodObject<{ pattern: z.ZodString; path: z.ZodOptional<z.ZodString> }>,
  string
>;
declare const bash: DefinedTool<
  z.ZodObject<{
    cmd: z.ZodString;
    args: z.ZodOptional<z.ZodArray<z.ZodString>>;
    opts: z.ZodOptional<z.ZodObject<{ cwd: z.ZodOptional<z.ZodString> }>>;
  }>,
  string
>;
declare const tools: {
  read: typeof read;
  write: typeof write;
  edit: typeof edit;
  grep: typeof grep;
  bash: typeof bash;
};

type AgentCapabilityRegistry = _smithers_orchestrator_agents_capability_registry.AgentCapabilityRegistry;
type AgentCheckpoint = _smithers_orchestrator_agents.AgentCheckpoint;
type AgentCheckpointCapability = _smithers_orchestrator_agents.AgentCheckpointCapability;
type AgentCheckpointContinuationOptions = _smithers_orchestrator_agents.AgentCheckpointContinuationOptions;
type AgentCheckpointFormat = _smithers_orchestrator_agents.AgentCheckpointFormat;
type AgentCheckpointJsonArray = _smithers_orchestrator_agents.AgentCheckpointJsonArray;
type AgentCheckpointJsonObject = _smithers_orchestrator_agents.AgentCheckpointJsonObject;
type AgentCheckpointJsonPrimitive = _smithers_orchestrator_agents.AgentCheckpointJsonPrimitive;
type AgentCheckpointJsonValue = _smithers_orchestrator_agents.AgentCheckpointJsonValue;
type AgentCheckpointMode = _smithers_orchestrator_agents.AgentCheckpointMode;
type AgentCheckpointPublisher = _smithers_orchestrator_agents.AgentCheckpointPublisher;
type AgentCheckpointResult = _smithers_orchestrator_agents.AgentCheckpointResult;
type AgentGenerateOptions = _smithers_orchestrator_agents.AgentGenerateOptions;
type AgentLike = _smithers_orchestrator_agents_AgentLike.AgentLike;
type AgentToolDescriptor = _smithers_orchestrator_agents_capability_registry.AgentToolDescriptor;
type AggregateOptions = _smithers_orchestrator_scorers.AggregateOptions;
type AggregateScore = _smithers_orchestrator_scorers.AggregateScore;
type AnthropicAgentOptions<CALL_OPTIONS, TOOLS> = _smithers_orchestrator_agents.AnthropicAgentOptions<CALL_OPTIONS, TOOLS>;
type ApprovalAutoApprove = _smithers_orchestrator_components.ApprovalAutoApprove;
type ApprovalDecision = _smithers_orchestrator_components.ApprovalDecision;
type ApprovalMode = _smithers_orchestrator_components.ApprovalMode;
type ApprovalOption = _smithers_orchestrator_components.ApprovalOption;
type ApprovalRanking = _smithers_orchestrator_components.ApprovalRanking;
type ApprovalRequest = _smithers_orchestrator_components.ApprovalRequest;
type ApprovalSelection = _smithers_orchestrator_components.ApprovalSelection;
type ColumnDef = _smithers_orchestrator_components.ColumnDef;
type ConnectRequest = _smithers_orchestrator_server_gateway.ConnectRequest;
type ContinueAsNewProps = _smithers_orchestrator_components.ContinueAsNewProps;
type CreateScorerConfig = _smithers_orchestrator_scorers.CreateScorerConfig;
type CreateSmithersApi<Schema> = CreateSmithersApi$1<Schema>;
type CreateSmithersOptions = CreateSmithersOptions$2;
type OpenSmithersBackendOptions = OpenSmithersBackendOptions$1;
type MigrateSmithersStoreOptions = MigrateSmithersStoreOptions$2;
type SmithersMigrationResult = SmithersMigrationResult$1;
type DepsSpec = _smithers_orchestrator_components.DepsSpec;
type EventFrame = _smithers_orchestrator_server_gateway.EventFrame;
type ExternalSmithersConfig<S> = ExternalSmithersConfig$2<S>;
type GatewayAuthConfig = _smithers_orchestrator_server_gateway.GatewayAuthConfig;
type GatewayDefaults = _smithers_orchestrator_server_gateway.GatewayDefaults;
type GatewayOperatorUiConfig = _smithers_orchestrator_server_gateway.GatewayOperatorUiConfig;
type GatewayOptions = _smithers_orchestrator_server_gateway.GatewayOptions;
type GatewayRegisterOptions = _smithers_orchestrator_server_gateway.GatewayRegisterOptions;
type GatewayTokenGrant = _smithers_orchestrator_server_gateway.GatewayTokenGrant;
type GatewayUiConfig = _smithers_orchestrator_server_gateway.GatewayUiConfig;
type GatewayWebhookConfig = _smithers_orchestrator_server_gateway.GatewayWebhookConfig;
type GatewayWebhookRunConfig = _smithers_orchestrator_server_gateway.GatewayWebhookRunConfig;
type GatewayWebhookSignalConfig = _smithers_orchestrator_server_gateway.GatewayWebhookSignalConfig;
type GraphSnapshot = _smithers_orchestrator_graph_GraphSnapshot.GraphSnapshot;
type HelloResponse = _smithers_orchestrator_server_gateway.HelloResponse;
type HostContainer = _smithers_orchestrator_react_reconciler_dom_renderer.HostContainer;
type HostNodeJson = HostNodeJson$1;
type InferOutputEntry<T> = _smithers_orchestrator_driver_OutputAccessor.InferOutputEntry<T>;
type InferRow<TTable> = _smithers_orchestrator_driver_OutputAccessor.InferRow<TTable>;
type JjRevertResult = _smithers_orchestrator_vcs_jj.JjRevertResult;
type KanbanProps = _smithers_orchestrator_components.KanbanProps;
type KnownSmithersErrorCode = _smithers_orchestrator_errors_KnownSmithersErrorCode.KnownSmithersErrorCode;
type LlmJudgeConfig = _smithers_orchestrator_scorers.LlmJudgeConfig;
type MemoryFact = _smithers_orchestrator_memory.MemoryFact;
type MemoryLayerConfig = _smithers_orchestrator_memory.MemoryLayerConfig;
type HindsightMemoryStoreOptions = _smithers_orchestrator_memory.HindsightMemoryStoreOptions;
type MemoryMessage = _smithers_orchestrator_memory.MemoryMessage;
type MemoryProps = _smithers_orchestrator_components.MemoryProps;
type MemoryNamespace = _smithers_orchestrator_memory.MemoryNamespace;
type MemoryNamespaceKind = _smithers_orchestrator_memory.MemoryNamespaceKind;
type MemoryProcessor = _smithers_orchestrator_memory.MemoryProcessor;
type MemoryProcessorConfig = _smithers_orchestrator_memory.MemoryProcessorConfig;
type MemoryServiceApi = _smithers_orchestrator_memory.MemoryServiceApi;
type MemoryStore = _smithers_orchestrator_memory.MemoryStore;
type MemoryThread = _smithers_orchestrator_memory.MemoryThread;
type MessageHistoryConfig = _smithers_orchestrator_memory.MessageHistoryConfig;
type OpenAIAgentOptions<CALL_OPTIONS = never, TOOLS = ai.ToolSet> = _smithers_orchestrator_agents.OpenAIAgentOptions<CALL_OPTIONS, TOOLS>;
type HermesAgentOptions<CALL_OPTIONS = never, TOOLS = ai.ToolSet> = _smithers_orchestrator_agents.HermesAgentOptions<CALL_OPTIONS, TOOLS>;
type HermesCliAgentOptions = _smithers_orchestrator_agents.HermesCliAgentOptions;
type OpenClawAgentOptions = _smithers_orchestrator_agents.OpenClawAgentOptions;
type OpenApiAuth = _smithers_orchestrator_openapi.OpenApiAuth;
type OpenApiSpec = _smithers_orchestrator_openapi.OpenApiSpec;
type OpenApiToolsOptions = _smithers_orchestrator_openapi.OpenApiToolsOptions;
type OutputAccessor<Schema> = _smithers_orchestrator_driver_OutputAccessor.OutputAccessor<Schema>;
type OutputKey = _smithers_orchestrator_driver_OutputKey.OutputKey;
type OutputTarget = _smithers_orchestrator_components.OutputTarget;
type PiAgentOptions = _smithers_orchestrator_agents.PiAgentOptions;
type OmpAgentOptions = _smithers_orchestrator_agents.OmpAgentOptions;
type CursorAgentOptions = _smithers_orchestrator_agents.CursorAgentOptions;
type PiExtensionUiRequest = _smithers_orchestrator_agents.PiExtensionUiRequest;
type PiExtensionUiResponse = _smithers_orchestrator_agents.PiExtensionUiResponse;
type OpenCodeAgentOptions = _smithers_orchestrator_agents.OpenCodeAgentOptions;
type PoolAgentOptions = _smithers_orchestrator_agents.PoolAgentOptions;
type VibeAgentOptions = _smithers_orchestrator_agents.VibeAgentOptions;
type MonitorCondition = _smithers_orchestrator_components.MonitorCondition;
type MonitorProps = _smithers_orchestrator_components.MonitorProps;
type PollerProps = _smithers_orchestrator_components.PollerProps;
type ProofBinding = _smithers_orchestrator_graph_ProofBinding.ProofBinding;
type RequestFrame = _smithers_orchestrator_server_gateway.RequestFrame;
type ResolvedSmithersObservabilityOptions = _smithers_orchestrator_observability.ResolvedSmithersObservabilityOptions;
type ResponseFrame = _smithers_orchestrator_server_gateway.ResponseFrame;
type RevertOptions = _smithers_orchestrator_time_travel_revert.RevertOptions;
type RevertResult = _smithers_orchestrator_time_travel_revert.RevertResult;
type RunJjOptions = _smithers_orchestrator_vcs_jj.RunJjOptions;
type RunJjResult = _smithers_orchestrator_vcs_jj.RunJjResult;
type RunOptions = _smithers_orchestrator_driver_RunOptions.RunOptions;
type RunStartedBy = _smithers_orchestrator_driver_RunStartedBy.RunStartedBy;
type SmithersErrorReport = _smithers_orchestrator_driver_SmithersErrorReport.SmithersErrorReport;
type RunResult = _smithers_orchestrator_driver_RunResult.RunResult;
type RunStatus = _smithers_orchestrator_driver_RunStatus.RunStatus;
type SagaProps = _smithers_orchestrator_components.SagaProps;
type SagaStepDef = _smithers_orchestrator_components.SagaStepDef;
type SagaStepProps = _smithers_orchestrator_components.SagaStepProps;
type SamplingConfig = _smithers_orchestrator_scorers.SamplingConfig;
type SandboxProps = _smithers_orchestrator_components.SandboxProps;
type SandboxRuntime = _smithers_orchestrator_components.SandboxRuntime;
type SandboxVolumeMount = _smithers_orchestrator_components.SandboxVolumeMount;
type SandboxWorkspaceSpec = _smithers_orchestrator_components.SandboxWorkspaceSpec;
type SchemaRegistryEntry = _smithers_orchestrator_db_SchemaRegistryEntry.SchemaRegistryEntry;
type Scorer = _smithers_orchestrator_scorers.Scorer;
type ScorerBinding = _smithers_orchestrator_scorers.ScorerBinding;
type ScorerContext = _smithers_orchestrator_scorers.ScorerContext;
type ScoreResult = _smithers_orchestrator_scorers.ScoreResult;
type ScorerFn = _smithers_orchestrator_scorers.ScorerFn;
type ScorerInput = _smithers_orchestrator_scorers.ScorerInput;
type ScoreRow = _smithers_orchestrator_scorers.ScoreRow;
type ScorersMap = _smithers_orchestrator_scorers.ScorersMap;
type SemanticRecallConfig = _smithers_orchestrator_memory.SemanticRecallConfig;
type SerializedCtx = SerializedCtx$1;
type ServeOptions = _smithers_orchestrator_server_serve.ServeOptions;
type ServerOptions = _smithers_orchestrator_server.ServerOptions;
type SmithersAlertLabels = _smithers_orchestrator_scheduler_SmithersWorkflowOptions.SmithersAlertLabels;
type SmithersAlertPolicy = _smithers_orchestrator_scheduler_SmithersWorkflowOptions.SmithersAlertPolicy;
type SmithersAlertPolicyDefaults = _smithers_orchestrator_scheduler_SmithersWorkflowOptions.SmithersAlertPolicyDefaults;
type SmithersAlertPolicyRule = _smithers_orchestrator_scheduler_SmithersWorkflowOptions.SmithersAlertPolicyRule;
type SmithersAlertReaction = _smithers_orchestrator_scheduler_SmithersWorkflowOptions.SmithersAlertReaction;
type SmithersAlertReactionKind = _smithers_orchestrator_scheduler_SmithersWorkflowOptions.SmithersAlertReactionKind;
type SmithersAlertReactionRef = _smithers_orchestrator_scheduler_SmithersWorkflowOptions.SmithersAlertReactionRef;
type SmithersAlertSeverity = _smithers_orchestrator_scheduler_SmithersWorkflowOptions.SmithersAlertSeverity;
type SmithersCtx = _smithers_orchestrator_driver_SmithersCtx.SmithersCtx;
type SmithersError = _smithers_orchestrator_errors_SmithersError.SmithersError;
type SmithersErrorCode = _smithers_orchestrator_errors_SmithersErrorCode.SmithersErrorCode;
type SmithersEvent = _smithers_orchestrator_observability_SmithersEvent.SmithersEvent;
type SmithersLogFormat = _smithers_orchestrator_observability.SmithersLogFormat;
type SmithersObservabilityOptions = _smithers_orchestrator_observability.SmithersObservabilityOptions;
type SmithersObservabilityService = _smithers_orchestrator_observability.SmithersObservabilityService;
type SmithersWorkflow<Schema> = _smithers_orchestrator_components_SmithersWorkflow.SmithersWorkflow<Schema>;
type SmithersWorkflowOptions = _smithers_orchestrator_scheduler_SmithersWorkflowOptions.SmithersWorkflowOptions;
type TaskDescriptor = _smithers_orchestrator_graph_TaskDescriptor.TaskDescriptor;
type TaskMemoryConfig = _smithers_orchestrator_memory.TaskMemoryConfig;
type TimerProps = _smithers_orchestrator_components.TimerProps;
type TimeTravelOptions = _smithers_orchestrator_time_travel_timetravel.TimeTravelOptions;
type TimeTravelResult = _smithers_orchestrator_time_travel_timetravel.TimeTravelResult;
type TryCatchFinallyProps = _smithers_orchestrator_components.TryCatchFinallyProps;
type TrellisProps = _smithers_orchestrator_components.TrellisProps;
type TUIProps = _smithers_orchestrator_components.TUIProps;
type UIProps = _smithers_orchestrator_components.UIProps;
type WaitForEventProps = _smithers_orchestrator_components.WaitForEventProps;
type WorkflowViewBootProps = _smithers_orchestrator_components.WorkflowViewBootProps;
type WorkflowViewProps = _smithers_orchestrator_components.WorkflowViewProps;
type WorkingMemoryConfig<T> = _smithers_orchestrator_memory.WorkingMemoryConfig<T>;
type WorkspaceAddOptions = _smithers_orchestrator_vcs_jj.WorkspaceAddOptions;
type WorkspaceInfo = _smithers_orchestrator_vcs_jj.WorkspaceInfo;
type WorkspaceResult = _smithers_orchestrator_vcs_jj.WorkspaceResult;
type XmlElement = _smithers_orchestrator_graph_XmlNode.XmlElement;
type XmlNode = _smithers_orchestrator_graph_XmlNode.XmlNode;
type XmlText = _smithers_orchestrator_graph_XmlNode.XmlText;

type ApprovalProps<Row = ApprovalDecision$1, Output extends OutputTarget$1 = OutputTarget$1> = ApprovalProps$2<Row, Output>;
type InferDeps<D extends DepsSpec$2> = InferDeps$1<D>;
type SignalProps<Schema extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> = SignalProps$2<Schema>;
type TaskProps<Row, Output extends OutputTarget$1 = OutputTarget$1, D extends DepsSpec$2 = {}> = TaskProps$2<Row, Output, D>;

export { type AgentCapabilityRegistry, type AgentCheckpoint, type AgentCheckpointCapability, type AgentCheckpointContinuationOptions, type AgentCheckpointFormat, type AgentCheckpointJsonArray, type AgentCheckpointJsonObject, type AgentCheckpointJsonPrimitive, type AgentCheckpointJsonValue, type AgentCheckpointMode, type AgentCheckpointPublisher, type AgentCheckpointResult, type AgentGenerateOptions, type AgentLike, type AgentToolDescriptor, type AggregateOptions, type AggregateScore, type AnthropicAgentOptions, type ApprovalAutoApprove, type ApprovalDecision, type ApprovalMode, type ApprovalOption, type ApprovalProps, type ApprovalRanking, type ApprovalRequest, type ApprovalSelection, type ColumnDef, type ConnectRequest, type ContinueAsNewProps, type CreateScorerConfig, type CreateSmithersApi, type CreateSmithersOptions, type CursorAgentOptions, type DepsSpec, type EventFrame, type ExternalSmithersConfig, type GatewayAuthConfig, type GatewayDefaults, type GatewayOperatorUiConfig, type GatewayOptions, type GatewayRegisterOptions, type GatewayTokenGrant, type GatewayUiConfig, type GatewayWebhookConfig, type GatewayWebhookRunConfig, type GatewayWebhookSignalConfig, type GraphSnapshot, type HelloResponse, type HermesAgentOptions, type HermesCliAgentOptions, type HindsightMemoryStoreOptions, type HostContainer, type HostNodeJson, type InferDeps, type InferOutputEntry, type InferRow, type JjRevertResult, type KanbanProps, type KnownSmithersErrorCode, type LlmJudgeConfig, type MemoryFact, type MemoryLayerConfig, type MemoryMessage, type MemoryNamespace, type MemoryNamespaceKind, type MemoryProcessor, type MemoryProcessorConfig, type MemoryProps, type MemoryServiceApi, type MemoryStore, type MemoryThread, type MessageHistoryConfig, type MigrateSmithersStoreOptions, type MonitorCondition, type MonitorProps, type OmpAgentOptions, type OpenAIAgentOptions, type OpenApiAuth, type OpenApiSpec, type OpenApiToolsOptions, type OpenClawAgentOptions, type OpenCodeAgentOptions, type OpenSmithersBackendOptions, type OutputAccessor, type OutputKey, type OutputTarget, type PiAgentOptions, type PiExtensionUiRequest, type PiExtensionUiResponse, type PollerProps, type PoolAgentOptions, type ProofBinding, type RequestFrame, type ResolvedSmithersObservabilityOptions, type ResponseFrame, type RevertOptions, type RevertResult, type RunJjOptions, type RunJjResult, type RunOptions, type RunResult, type RunStartedBy, type RunStatus, type SagaProps, type SagaStepDef, type SagaStepProps, type SamplingConfig, type SandboxProps, type SandboxRuntime, type SandboxVolumeMount, type SandboxWorkspaceSpec, type SchemaRegistryEntry, type ScoreResult, type ScoreRow, type Scorer, type ScorerBinding, type ScorerContext, type ScorerFn, type ScorerInput, type ScorersMap, type SemanticRecallConfig, type SerializedCtx, type ServeOptions, type ServerOptions, type SignalProps, type SmithersAlertLabels, type SmithersAlertPolicy, type SmithersAlertPolicyDefaults, type SmithersAlertPolicyRule, type SmithersAlertReaction, type SmithersAlertReactionKind, type SmithersAlertReactionRef, type SmithersAlertSeverity, type SmithersCtx, type SmithersError, type SmithersErrorCode, type SmithersErrorReport, type SmithersEvent, type SmithersLogFormat, type SmithersMigrationResult, type SmithersObservabilityOptions, type SmithersObservabilityService, type SmithersWorkflow, type SmithersWorkflowOptions, type TUIProps, type TaskDescriptor, type TaskMemoryConfig, type TaskProps, type TimeTravelOptions, type TimeTravelResult, type TimerProps, type TrellisProps, type TryCatchFinallyProps, type UIProps, type VibeAgentOptions, type WaitForEventProps, type WorkflowViewBootProps, type WorkflowViewProps, type WorkingMemoryConfig, type WorkspaceAddOptions, type WorkspaceInfo, type WorkspaceResult, type XmlElement, type XmlNode, type XmlText, bash, createExternalSmithers, createSmithers, createSmithersCloudflare, createSmithersPostgres, defineTool, edit, getDefinedToolMetadata, grep, mdxPlugin, migrateSmithersStore, openSmithersBackend, openSmithersStore, read, resolveSmithersBackendChoice, resolveSmithersBackendPreference, tools, write };
