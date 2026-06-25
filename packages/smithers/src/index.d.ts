import * as _smithers_orchestrator_graph_XmlNode from '@smithers-orchestrator/graph/XmlNode';
import * as _smithers_orchestrator_time_travel_timetravel from '@smithers-orchestrator/time-travel/timetravel';
export { timeTravel } from '@smithers-orchestrator/time-travel/timetravel';
import * as _smithers_orchestrator_graph_TaskDescriptor from '@smithers-orchestrator/graph/TaskDescriptor';
import * as _smithers_orchestrator_components_SmithersWorkflow from '@smithers-orchestrator/components/SmithersWorkflow';
import { SmithersWorkflow as SmithersWorkflow$1 } from '@smithers-orchestrator/components/SmithersWorkflow';
import * as _smithers_orchestrator_observability_SmithersEvent from '@smithers-orchestrator/observability/SmithersEvent';
import { SmithersEvent as SmithersEvent$1 } from '@smithers-orchestrator/observability/SmithersEvent';
import * as _smithers_orchestrator_errors_SmithersErrorCode from '@smithers-orchestrator/errors/SmithersErrorCode';
import * as _smithers_orchestrator_errors_SmithersError from '@smithers-orchestrator/errors/SmithersError';
export { SmithersError as SmithersErrorInstance } from '@smithers-orchestrator/errors/SmithersError';
import * as _smithers_orchestrator_driver_SmithersCtx from '@smithers-orchestrator/driver/SmithersCtx';
import { SmithersCtx as SmithersCtx$1 } from '@smithers-orchestrator/driver/SmithersCtx';
import * as _smithers_orchestrator_scheduler_SmithersWorkflowOptions from '@smithers-orchestrator/scheduler/SmithersWorkflowOptions';
import { SmithersWorkflowOptions as SmithersWorkflowOptions$1, SmithersAlertPolicy as SmithersAlertPolicy$1 } from '@smithers-orchestrator/scheduler/SmithersWorkflowOptions';
import * as _smithers_orchestrator_server from '@smithers-orchestrator/server';
export { startServer } from '@smithers-orchestrator/server';
import * as _smithers_orchestrator_server_serve from '@smithers-orchestrator/server/serve';
export { createServeApp } from '@smithers-orchestrator/server/serve';
import { OutputSnapshot } from '@smithers-orchestrator/driver/OutputSnapshot';
import * as _smithers_orchestrator_db_SchemaRegistryEntry from '@smithers-orchestrator/db/SchemaRegistryEntry';
import * as _smithers_orchestrator_driver_RunStatus from '@smithers-orchestrator/driver/RunStatus';
import * as _smithers_orchestrator_driver_RunResult from '@smithers-orchestrator/driver/RunResult';
import * as _smithers_orchestrator_driver_RunOptions from '@smithers-orchestrator/driver/RunOptions';
import * as _smithers_orchestrator_time_travel_revert from '@smithers-orchestrator/time-travel/revert';
export { revertToAttempt } from '@smithers-orchestrator/time-travel/revert';
import * as _smithers_orchestrator_observability from '@smithers-orchestrator/observability';
export { SmithersObservability, activeNodes, activeRuns, approvalsDenied, approvalsGranted, approvalsRequested, attemptDuration, cacheHits, cacheMisses, createSmithersObservabilityLayer, createSmithersOtelLayer, createSmithersRuntimeLayer, dbQueryDuration, dbRetries, dbTransactionDuration, dbTransactionRetries, dbTransactionRollbacks, externalWaitAsyncPending, hotReloadDuration, hotReloadFailures, hotReloads, httpRequestDuration, httpRequests, nodeDuration, nodesFailed, nodesFinished, nodesStarted, prometheusContentType, renderPrometheusMetrics, resolveSmithersObservabilityOptions, runsTotal, sandboxActive, sandboxBundleSizeBytes, sandboxCompletedTotal, sandboxCreatedTotal, sandboxDurationMs, sandboxPatchCount, sandboxTransportDurationMs, schedulerQueueDepth, smithersMetrics, timerDelayDuration, timersCancelled, timersCreated, timersFired, timersPending, toolCallsTotal, toolDuration, trackSmithersEvent, vcsDuration } from '@smithers-orchestrator/observability';
import * as _smithers_orchestrator_driver_OutputKey from '@smithers-orchestrator/driver/OutputKey';
import * as _smithers_orchestrator_openapi from '@smithers-orchestrator/openapi';
export { createOpenApiTool, createOpenApiToolSync, createOpenApiTools, createOpenApiToolsSync, listOperations, openApiToolCallErrorsTotal, openApiToolCallsTotal, openApiToolDuration } from '@smithers-orchestrator/openapi';
import * as ai from 'ai';
import { Tool } from 'ai';
import * as _smithers_orchestrator_memory from '@smithers-orchestrator/memory';
export { MemoryService, Summarizer, TokenLimiter, TtlGarbageCollector, createMemoryLayer, createMemoryStore, memoryFactReads, memoryFactWrites, memoryMessageSaves, memoryRecallDuration, memoryRecallQueries, namespaceToString, parseNamespace } from '@smithers-orchestrator/memory';
import * as _smithers_orchestrator_errors_KnownSmithersErrorCode from '@smithers-orchestrator/errors/KnownSmithersErrorCode';
import * as _smithers_orchestrator_vcs_jj from '@smithers-orchestrator/vcs/jj';
export { getJjPointer, isJjRepo, revertToJjPointer, runJj, workspaceAdd, workspaceClose, workspaceList } from '@smithers-orchestrator/vcs/jj';
import * as _smithers_orchestrator_driver_OutputAccessor from '@smithers-orchestrator/driver/OutputAccessor';
import * as _smithers_orchestrator_react_reconciler_dom_renderer from '@smithers-orchestrator/react-reconciler/dom/renderer';
export { SmithersRenderer } from '@smithers-orchestrator/react-reconciler/dom/renderer';
import * as _smithers_orchestrator_graph_GraphSnapshot from '@smithers-orchestrator/graph/GraphSnapshot';
import * as _smithers_orchestrator_agents_AgentLike from '@smithers-orchestrator/agents/AgentLike';
import { AgentLike as AgentLike$1 } from '@smithers-orchestrator/agents/AgentLike';
import * as zod from 'zod';
import { z } from 'zod';
import React from 'react';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as _smithers_orchestrator_components from '@smithers-orchestrator/components';
import { Sequence, Parallel, MergeQueue, Branch, Loop, Ralph, ContinueAsNew, continueAsNew, Worktree, Timer } from '@smithers-orchestrator/components';
export { Approval, ApprovalGate, Aspects, Branch, CheckSuite, ClassifyAndRoute, ContentPipeline, ContinueAsNew, Debate, DecisionTable, DriftDetector, EscalationChain, GatherAndSynthesize, HumanTask, Kanban, Loop, MergeQueue, Optimizer, Panel, Parallel, Poller, Ralph, ReviewLoop, Runbook, Saga, SagaStep, Sandbox, ScanFixVerify, Sequence, Sidecar, Signal, Subflow, SuperSmithers, Supervisor, Task, Timer, TryCatchFinally, WaitForEvent, Workflow, Worktree, approvalDecisionSchema, approvalRankingSchema, approvalSelectionSchema, computeSidecarDelta, continueAsNew } from '@smithers-orchestrator/components';
import { ApprovalProps as ApprovalProps$1 } from '@smithers-orchestrator/components/components/ApprovalProps';
import { DepsSpec as DepsSpec$1 } from '@smithers-orchestrator/components/components/DepsSpec';
import { SandboxProps as SandboxProps$1 } from '@smithers-orchestrator/components/components/SandboxProps';
import { SignalProps as SignalProps$1 } from '@smithers-orchestrator/components/components/SignalProps';
import { TaskProps as TaskProps$1 } from '@smithers-orchestrator/components/components/TaskProps';
import { WorkflowProps } from '@smithers-orchestrator/components/components/WorkflowProps';
import * as _smithers_orchestrator_server_gateway from '@smithers-orchestrator/server/gateway';
export { Gateway } from '@smithers-orchestrator/server/gateway';
import * as _smithers_orchestrator_agents from '@smithers-orchestrator/agents';
export { AmpAgent, AnthropicAgent, AntigravityAgent, ClaudeCodeAgent, CodexAgent, ForgeAgent, GeminiAgent, HermesAgent, KimiAgent, OpenAIAgent, OpenCodeAgent, PiAgent, VibeAgent, createHttpTool } from '@smithers-orchestrator/agents';
import * as _smithers_orchestrator_scorers from '@smithers-orchestrator/scorers';
export { aggregateScores, createScorer, faithfulnessScorer, latencyScorer, llmJudge, relevancyScorer, runScorersAsync, runScorersBatch, schemaAdherenceScorer, smithersScorers, toxicityScorer } from '@smithers-orchestrator/scorers';
import * as _smithers_orchestrator_agents_capability_registry from '@smithers-orchestrator/agents/capability-registry';
export { hashCapabilityRegistry } from '@smithers-orchestrator/agents/capability-registry';
export { ERROR_REFERENCE_URL } from '@smithers-orchestrator/errors/ERROR_REFERENCE_URL';
export { errorToJson } from '@smithers-orchestrator/errors/errorToJson';
export { getSmithersErrorDefinition } from '@smithers-orchestrator/errors/getSmithersErrorDefinition';
export { getSmithersErrorDocsUrl } from '@smithers-orchestrator/errors/getSmithersErrorDocsUrl';
export { isKnownSmithersErrorCode } from '@smithers-orchestrator/errors/isKnownSmithersErrorCode';
export { isSmithersError } from '@smithers-orchestrator/errors/isSmithersError';
export { knownSmithersErrorCodes } from '@smithers-orchestrator/errors/knownSmithersErrorCodes';
import { SmithersDb } from '@smithers-orchestrator/db/adapter';
export { resolveWorktreePath } from '@smithers-orchestrator/graph';
export { signalRun } from '@smithers-orchestrator/engine/signals';
export { usePatched } from '@smithers-orchestrator/engine/effect/versioning';
export { ensureSmithersTables } from '@smithers-orchestrator/db/ensure';
export { markdownComponents } from '@smithers-orchestrator/components/markdownComponents';
export { renderMdx } from '@smithers-orchestrator/components/renderMdx';
export { zodToTable } from '@smithers-orchestrator/db/zodToTable';
export { camelToSnake } from '@smithers-orchestrator/db/utils/camelToSnake';
export { unwrapZodType } from '@smithers-orchestrator/db/unwrapZodType';
export { zodSchemaToJsonExample } from '@smithers-orchestrator/components/zod-to-example';
export { Smithers, approveNode, denyNode, fragment, getRun, listRuns, renderFrame, runWorkflow, workflow } from '@smithers-orchestrator/engine';
export { SmithersDb, loadOutputs, loadOutputsEffect } from '@smithers-orchestrator/db';
export { syncZodTableSchema, zodSchemaColumns, zodToCreateTableSQL } from '@smithers-orchestrator/db/zodToCreateTableSQL';

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
 * @returns {Promise<import("./CreateSmithersApi.ts").CreateSmithersApi<Schemas> & { close?: () => Promise<void> }>}
 */
declare function openSmithersBackend<Schemas extends Record<string, zod.ZodObject<any>>>(schemas?: Schemas, opts?: OpenSmithersBackendOptions$1): Promise<CreateSmithersApi$1<Schemas> & {
    close?: () => Promise<void>;
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
        hasRunsTable?: boolean;
        runCount: number;
        schemaVersion: string;
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

/**
 * One-shot copy from the legacy bun:sqlite Smithers store to PGlite/Postgres.
 *
 * @param {MigrateSmithersStoreOptions} [opts]
 * @returns {Promise<MigrateSmithersStoreResult>}
 */
declare function migrateSmithersStore(opts?: MigrateSmithersStoreOptions$1): Promise<MigrateSmithersStoreResult>;
type MigrateSmithersBackend = "sqlite" | "pglite" | "postgres";
type MigrateSmithersStoreOptions$1 = {
    cwd?: string;
    dbPath?: string;
    from?: MigrateSmithersBackend;
    to?: MigrateSmithersBackend;
    url?: string;
    env?: Record<string, string | undefined>;
    pgliteDataDir?: string;
    keepSqlite?: boolean;
    batchSize?: number;
    onProgress?: (event: MigrationProgressEvent) => void | Promise<void>;
};
type MigrationProgressEvent = {
    type: "table-start" | "table-copied" | "done";
    table?: string;
    copiedRows?: number;
    sourceRows?: number;
    targetRows?: number;
    tableCount?: number;
    durationMs?: number;
};
type MigrationTableResult = {
    table: string;
    sourceRows: number;
    targetRows: number;
    durationMs: number;
};
type MigrateSmithersStoreResult = {
    backend: MigrateSmithersBackend;
    source: {
        backend: MigrateSmithersBackend;
        dbPath?: string;
        dataDir?: string;
        url?: string;
    };
    dbPath: string;
    markerPath: string;
    target: {
        backend: MigrateSmithersBackend;
        dbPath?: string;
        dataDir?: string;
        url?: string;
    };
    runCount: number;
    schemaVersion: string;
    durationMs: number;
    tables: MigrationTableResult[];
    sqliteRemoved: boolean;
};

/**
 * Create a SmithersWorkflow from an external build function.
 *
 * Schemas and agents are defined in TS. The build function produces a HostNode JSON tree
 * that maps 1:1 to what the JSX renderer would produce.
 *
 * @template {Record<string, import("zod").ZodObject<any>>} S
 * @param {ExternalSmithersConfig<S>} config
 * @returns {import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<S> & { tables: Record<string, any>; cleanup: () => void }}
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
 * @param {CreateSmithersOptions & ({ provider: "postgres"; connectionString?: string; connection?: object } | { provider: "pglite"; dataDir?: string })} opts
 * @returns {Promise<import("./CreateSmithersApi.ts").CreateSmithersApi<Schemas> & { close: () => Promise<void> }>}
 */
declare function createSmithersPostgres<Schemas extends Record<string, zod.ZodObject<any>>>(schemas: Schemas, opts: CreateSmithersOptions$1 & ({
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
};

type DefinedToolMetadata = {
  name: string;
  sideEffect: boolean;
  idempotent: boolean;
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
type AgentLike = _smithers_orchestrator_agents_AgentLike.AgentLike;
type AgentToolDescriptor = _smithers_orchestrator_agents_capability_registry.AgentToolDescriptor;
type AggregateOptions = _smithers_orchestrator_scorers.AggregateOptions;
type AggregateScore = _smithers_orchestrator_scorers.AggregateScore;
type AnthropicAgentOptions<CALL_OPTIONS, TOOLS> = _smithers_orchestrator_agents.AnthropicAgentOptions<CALL_OPTIONS, TOOLS>;
type ApprovalAutoApprove = _smithers_orchestrator_components.ApprovalAutoApprove;
type ApprovalDecision = _smithers_orchestrator_components.ApprovalDecision;
type ApprovalMode = _smithers_orchestrator_components.ApprovalMode;
type ApprovalOption = _smithers_orchestrator_components.ApprovalOption;
type ApprovalProps = any;
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
type InferDeps = any;
type InferOutputEntry<T> = _smithers_orchestrator_driver_OutputAccessor.InferOutputEntry<T>;
type InferRow<TTable> = _smithers_orchestrator_driver_OutputAccessor.InferRow<TTable>;
type JjRevertResult = _smithers_orchestrator_vcs_jj.JjRevertResult;
type KanbanProps = _smithers_orchestrator_components.KanbanProps;
type KnownSmithersErrorCode = _smithers_orchestrator_errors_KnownSmithersErrorCode.KnownSmithersErrorCode;
type LlmJudgeConfig = _smithers_orchestrator_scorers.LlmJudgeConfig;
type MemoryFact = _smithers_orchestrator_memory.MemoryFact;
type MemoryLayerConfig = _smithers_orchestrator_memory.MemoryLayerConfig;
type MemoryMessage = _smithers_orchestrator_memory.MemoryMessage;
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
type OpenApiAuth = _smithers_orchestrator_openapi.OpenApiAuth;
type OpenApiSpec = _smithers_orchestrator_openapi.OpenApiSpec;
type OpenApiToolsOptions = _smithers_orchestrator_openapi.OpenApiToolsOptions;
type OutputAccessor<Schema> = _smithers_orchestrator_driver_OutputAccessor.OutputAccessor<Schema>;
type OutputKey = _smithers_orchestrator_driver_OutputKey.OutputKey;
type OutputTarget = _smithers_orchestrator_components.OutputTarget;
type PiAgentOptions = _smithers_orchestrator_agents.PiAgentOptions;
type PiExtensionUiRequest = _smithers_orchestrator_agents.PiExtensionUiRequest;
type PiExtensionUiResponse = _smithers_orchestrator_agents.PiExtensionUiResponse;
type OpenCodeAgentOptions = _smithers_orchestrator_agents.OpenCodeAgentOptions;
type VibeAgentOptions = _smithers_orchestrator_agents.VibeAgentOptions;
type PollerProps = _smithers_orchestrator_components.PollerProps;
type RequestFrame = _smithers_orchestrator_server_gateway.RequestFrame;
type ResolvedSmithersObservabilityOptions = _smithers_orchestrator_observability.ResolvedSmithersObservabilityOptions;
type ResponseFrame = _smithers_orchestrator_server_gateway.ResponseFrame;
type RevertOptions = _smithers_orchestrator_time_travel_revert.RevertOptions;
type RevertResult = _smithers_orchestrator_time_travel_revert.RevertResult;
type RunJjOptions = _smithers_orchestrator_vcs_jj.RunJjOptions;
type RunJjResult = _smithers_orchestrator_vcs_jj.RunJjResult;
type RunOptions = _smithers_orchestrator_driver_RunOptions.RunOptions;
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
type SignalProps = any;
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
type TaskProps = any;
type TimerProps = _smithers_orchestrator_components.TimerProps;
type TimeTravelOptions = _smithers_orchestrator_time_travel_timetravel.TimeTravelOptions;
type TimeTravelResult = _smithers_orchestrator_time_travel_timetravel.TimeTravelResult;
type TryCatchFinallyProps = _smithers_orchestrator_components.TryCatchFinallyProps;
type WaitForEventProps = _smithers_orchestrator_components.WaitForEventProps;
type WorkingMemoryConfig<T> = _smithers_orchestrator_memory.WorkingMemoryConfig<T>;
type WorkspaceAddOptions = _smithers_orchestrator_vcs_jj.WorkspaceAddOptions;
type WorkspaceInfo = _smithers_orchestrator_vcs_jj.WorkspaceInfo;
type WorkspaceResult = _smithers_orchestrator_vcs_jj.WorkspaceResult;
type XmlElement = _smithers_orchestrator_graph_XmlNode.XmlElement;
type XmlNode = _smithers_orchestrator_graph_XmlNode.XmlNode;
type XmlText = _smithers_orchestrator_graph_XmlNode.XmlText;

export { type AgentCapabilityRegistry, type AgentLike, type AgentToolDescriptor, type AggregateOptions, type AggregateScore, type AnthropicAgentOptions, type ApprovalAutoApprove, type ApprovalDecision, type ApprovalMode, type ApprovalOption, type ApprovalProps, type ApprovalRanking, type ApprovalRequest, type ApprovalSelection, type ColumnDef, type ConnectRequest, type ContinueAsNewProps, type CreateScorerConfig, type CreateSmithersApi, type CreateSmithersOptions, type DepsSpec, type EventFrame, type ExternalSmithersConfig, type GatewayAuthConfig, type GatewayDefaults, type GatewayOperatorUiConfig, type GatewayOptions, type GatewayRegisterOptions, type GatewayTokenGrant, type GatewayUiConfig, type GatewayWebhookConfig, type GatewayWebhookRunConfig, type GatewayWebhookSignalConfig, type GraphSnapshot, type HelloResponse, type HermesAgentOptions, type HostContainer, type HostNodeJson, type InferDeps, type InferOutputEntry, type InferRow, type JjRevertResult, type KanbanProps, type KnownSmithersErrorCode, type LlmJudgeConfig, type MemoryFact, type MemoryLayerConfig, type MemoryMessage, type MemoryNamespace, type MemoryNamespaceKind, type MemoryProcessor, type MemoryProcessorConfig, type MemoryServiceApi, type MemoryStore, type MemoryThread, type MessageHistoryConfig, type MigrateSmithersStoreOptions, type OpenAIAgentOptions, type OpenApiAuth, type OpenApiSpec, type OpenApiToolsOptions, type OpenCodeAgentOptions, type OpenSmithersBackendOptions, type OutputAccessor, type OutputKey, type OutputTarget, type PiAgentOptions, type PiExtensionUiRequest, type PiExtensionUiResponse, type PollerProps, type RequestFrame, type ResolvedSmithersObservabilityOptions, type ResponseFrame, type RevertOptions, type RevertResult, type RunJjOptions, type RunJjResult, type RunOptions, type RunResult, type RunStatus, type SagaProps, type SagaStepDef, type SagaStepProps, type SamplingConfig, type SandboxProps, type SandboxRuntime, type SandboxVolumeMount, type SandboxWorkspaceSpec, type SchemaRegistryEntry, type ScoreResult, type ScoreRow, type Scorer, type ScorerBinding, type ScorerContext, type ScorerFn, type ScorerInput, type ScorersMap, type SemanticRecallConfig, type SerializedCtx, type ServeOptions, type ServerOptions, type SignalProps, type SmithersAlertLabels, type SmithersAlertPolicy, type SmithersAlertPolicyDefaults, type SmithersAlertPolicyRule, type SmithersAlertReaction, type SmithersAlertReactionKind, type SmithersAlertReactionRef, type SmithersAlertSeverity, type SmithersCtx, type SmithersError, type SmithersErrorCode, type SmithersEvent, type SmithersLogFormat, type SmithersMigrationResult, type SmithersObservabilityOptions, type SmithersObservabilityService, type SmithersWorkflow, type SmithersWorkflowOptions, type TaskDescriptor, type TaskMemoryConfig, type TaskProps, type TimeTravelOptions, type TimeTravelResult, type TimerProps, type TryCatchFinallyProps, type VibeAgentOptions, type WaitForEventProps, type WorkingMemoryConfig, type WorkspaceAddOptions, type WorkspaceInfo, type WorkspaceResult, type XmlElement, type XmlNode, type XmlText, bash, createExternalSmithers, createSmithers, createSmithersPostgres, defineTool, edit, getDefinedToolMetadata, grep, mdxPlugin, migrateSmithersStore, openSmithersBackend, openSmithersStore, read, resolveSmithersBackendChoice, tools, write };
