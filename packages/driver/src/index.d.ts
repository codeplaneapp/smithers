import * as _smithers_orchestrator_graph_types from '@smithers-orchestrator/graph/types';
import { WorkflowGraph as WorkflowGraph$1, TaskDescriptor as TaskDescriptor$1 } from '@smithers-orchestrator/graph/types';
import { SmithersEvent } from '@smithers-orchestrator/observability/SmithersEvent';
import * as _smithers_orchestrator_scheduler from '@smithers-orchestrator/scheduler';
import { WaitReason as WaitReason$1, EngineDecision as EngineDecision$1 } from '@smithers-orchestrator/scheduler';
import { z } from 'zod';
import { SmithersWorkflowOptions } from '@smithers-orchestrator/scheduler/SmithersWorkflowOptions';
import { SchemaRegistryEntry } from '@smithers-orchestrator/db/SchemaRegistryEntry';
import * as _smithers_orchestrator_graph from '@smithers-orchestrator/graph';
import { ExtractOptions, WorkflowGraph } from '@smithers-orchestrator/graph';

type TaskCompletedEvent = {
    nodeId: string;
    iteration: number;
    output: unknown;
};

type TaskFailedEvent = {
    nodeId: string;
    iteration: number;
    error: unknown;
};

type WorkflowSession$2 = {
    submitGraph(graph: WorkflowGraph$1): unknown;
    taskCompleted(event: TaskCompletedEvent): unknown;
    taskFailed(event: TaskFailedEvent): unknown;
    getNextDecision?(): unknown;
    cancelRequested?(): unknown;
};

type WorkflowRuntime$2 = {
    runPromise<A>(effect: unknown): Promise<A>;
};

type RunAuthContext$2 = {
    triggeredBy: string;
    scopes: string[];
    role: string;
    createdAt: string;
};

type OutputSnapshot$2<TFallback = unknown> = {
    [tableName: string]: Array<TFallback>;
};

type HotReloadOptions$1 = {
    /** Root directory to watch for changes (default: auto-detect from workflow entry) */
    rootDir?: string;
    /** Directory for generation overlays (default: rootDir/.smithers/hmr) */
    outDir?: string;
    /** Max overlay generations to keep (default: 3) */
    maxGenerations?: number;
    /** Whether to cancel tasks that become unmounted after hot reload (default: false) */
    cancelUnmounted?: boolean;
    /** Debounce interval in ms for file change events (default: 100) */
    debounceMs?: number;
};
type RunOptions$2 = {
    runId?: string;
    parentRunId?: string | null;
    input: Record<string, unknown>;
    maxConcurrency?: number;
    requireRerenderOnOutputChange?: boolean;
    onProgress?: (e: SmithersEvent) => void;
    signal?: AbortSignal;
    resume?: boolean;
    force?: boolean;
    workflowPath?: string;
    rootDir?: string;
    logDir?: string | null;
    allowNetwork?: boolean;
    maxOutputBytes?: number;
    toolTimeoutMs?: number;
    hot?: boolean | HotReloadOptions$1;
    annotations?: Record<string, string | number | boolean>;
    auth?: RunAuthContext$2 | null;
    config?: Record<string, unknown>;
    cliAgentToolsDefault?: "all" | "explicit-only";
    initialOutputs?: OutputSnapshot$2;
    initialIteration?: number;
    initialIterations?: Record<string, number> | ReadonlyMap<string, number>;
    resumeClaim?: {
        claimOwnerId: string;
        claimHeartbeatAtMs: number;
        restoreRuntimeOwnerId?: string | null;
        restoreHeartbeatAtMs?: number | null;
    };
};

type RunStatus$1 = "running" | "waiting-approval" | "waiting-event" | "waiting-timer" | "waiting-quota" | "finished" | "continued" | "failed" | "cancelled";

type RunResult$2 = {
    readonly runId: string;
    readonly status: RunStatus$1;
    readonly output?: unknown;
    readonly error?: unknown;
    readonly nextRunId?: string;
    /**
     * Number of tasks that ended `failed` yet did not fail the run — "masked"
     * child failures (a `continueOnFail` task, or an agent task that failed
     * transiently: rate limit, timeout, abort) the binary `finished` status cannot
     * express. Present (and `> 0`) only on a `finished` result. See
     * `docs/runtime/run-state.mdx`.
     */
    readonly failedChildren?: number;
    /**
     * Task state keys (`nodeId::iteration`) of the tasks counted by
     * {@link failedChildren}.
     */
    readonly failedChildKeys?: readonly string[];
};

type ContinueAsNewHandler$1 = (transition: unknown, context: {
    runId: string;
    options: RunOptions$2;
}) => Promise<RunResult$2> | RunResult$2;

type CreateWorkflowSessionOptions = {
    db?: unknown;
    runId: string;
    rootDir?: string;
    workflowPath?: string | null;
    options: RunOptions$2;
};

type CreateWorkflowSession$1 = (opts: CreateWorkflowSessionOptions) => unknown;

type SchedulerWaitHandler$1 = (durationMs: number, context: {
    runId: string;
    tasks: readonly TaskDescriptor$1[];
}) => Promise<void> | void;

type TaskExecutorContext = {
    runId: string;
    options: RunOptions$2;
    signal?: AbortSignal;
};

type TaskExecutor$1 = (task: TaskDescriptor$1, context: TaskExecutorContext) => Promise<unknown> | unknown;

type WaitHandler$1 = (reason: WaitReason$1, context: {
    runId: string;
    options: RunOptions$2;
}) => Promise<EngineDecision$1 | RunResult$2> | EngineDecision$1 | RunResult$2;

type InferRow<TTable> = TTable extends {
    $inferSelect: infer R;
} ? R : never;
type InferOutputEntry$1<T> = T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: unknown;
} ? InferRow<T> : never;
type FallbackTableName<Schema> = [keyof Schema & string] extends [never] ? string : never;
type OutputAccessor$2<Schema, TRow = unknown> = {
    (table: FallbackTableName<Schema>): Array<TRow>;
    <K extends keyof Schema & string>(table: K): Array<InferOutputEntry$1<Schema[K]>>;
} & {
    [K in keyof Schema & string]: Array<InferOutputEntry$1<Schema[K]>>;
};

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
type ResolveOutputRow$1<Schema, T> = T extends keyof Schema ? Schema[T] extends z.ZodTypeAny ? z.infer<Schema[T]> : Schema[T] extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown> : T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: infer R;
} ? R : Record<string, unknown>;

type SmithersRuntimeConfig$1 = {
    cliAgentToolsDefault?: "all" | "explicit-only";
    baseRootDir?: string;
    workflowPath?: string | null;
    worktreePaths?: Record<string, string>;
};

type SmithersCtxOptions$2 = {
    runId: string;
    iteration: number;
    iterations?: Record<string, number>;
    input: unknown;
    auth?: RunAuthContext$2 | null;
    outputs: OutputSnapshot$2;
    zodToKeyName?: Map<any, string>;
    runtimeConfig?: SmithersRuntimeConfig$1;
};

type SafeParser$1 = {
    safeParse(value: unknown): {
        success: true;
        data: unknown;
    } | {
        success: false;
        error?: unknown;
    };
};

type OutputKey$2 = {
    nodeId: string;
    iteration?: number;
};

/**
 * @template {unknown} [Schema=unknown]
 */
declare class SmithersCtx<Schema extends unknown = unknown> {
    /**
     * @param {SmithersCtxOptions} opts
     */
    constructor(opts: SmithersCtxOptions$1);
    /** @type {string} */
    runId: string;
    /** @type {number} */
    iteration: number;
    /** @type {Record<string, number> | undefined} */
    iterations: Record<string, number> | undefined;
    /** @type {Schema extends { input: infer T } ? T : unknown} */
    input: Schema extends {
        input: infer T;
    } ? T : unknown;
    /** @type {RunAuthContext | null} */
    auth: RunAuthContext$1 | null;
    /** @type {SmithersRuntimeConfig | null | undefined} */
    __smithersRuntime: SmithersRuntimeConfig | null | undefined;
    /** @type {Record<string, string>} */
    _worktreePaths: Record<string, string>;
    /** @type {OutputAccessor<Schema>} */
    outputs: OutputAccessor$1<Schema>;
    /** @type {import("./OutputSnapshot.ts").OutputSnapshot} */
    _outputs: OutputSnapshot$2;
    /** @type {Map<unknown, string> | undefined} */
    _zodToKeyName: Map<unknown, string> | undefined;
    /** @type {Set<string>} */
    _currentScopes: Set<string>;
    /**
     * Tasks that declared `deps` but could not resolve them this render, so
     * they deferred (returned null) instead of mounting. The engine reads this
     * after each render: a deferral is normal while an upstream is still
     * producing, but one that survives to quiescence means the dependency can
     * never resolve (e.g. a deps/needs key that maps to a node id no task
     * produces) and the run would otherwise finish silently without it.
     * @type {{ nodeId: string; waitingOn: string[] }[]}
     */
    _deferredDeps: {
        nodeId: string;
        waitingOn: string[];
    }[];
    /**
     * Return the resolved absolute path for a rendered worktree or task id.
     * The lookup is populated from task descriptors, so task node ids and
     * explicit <Worktree id> values both work once the worktree has rendered.
     *
     * @param {string} id
     * @returns {string | undefined}
     */
    worktreePath(id: string): string | undefined;
    /**
     * Resolve a <Worktree path> prop against the active workflow root using
     * the same resolver graph extraction uses.
     *
     * @param {string} path
     * @returns {string}
     */
    resolveWorktreePath(path: string): string;
    /**
     * @template {keyof Schema & string} K
     * @overload
     * @param {K} table
     * @param {OutputKey} key
     * @returns {ResolveOutputRow<Schema, K>}
     */
    output<K extends keyof Schema & string>(table: K, key: OutputKey$1): ResolveOutputRow<Schema, K>;
    /**
     * @template {TableRef} T
     * @overload
     * @param {T} table
     * @param {OutputKey} key
     * @returns {ResolveOutputRow<Schema, T>}
     */
    output<T extends TableRef>(table: T, key: OutputKey$1): ResolveOutputRow<Schema, T>;
    /**
     * Resolve a single output row. Without an explicit `key.iteration` this
     * resolves the CURRENT render iteration — which equals the loop iteration
     * only for a single, non-nested loop, and is 0 when several loops coexist.
     * For a `<Loop>` exit condition use {@link latest} (the most recent
     * iteration), not `outputMaybe`, or an `until` built on it never advances.
     *
     * @template {keyof Schema & string} K
     * @overload
     * @param {K} table
     * @param {OutputKey} key
     * @returns {ResolveOutputRow<Schema, K> | undefined}
     */
    outputMaybe<K extends keyof Schema & string>(table: K, key: OutputKey$1): ResolveOutputRow<Schema, K> | undefined;
    /**
     * @template {TableRef} T
     * @overload
     * @param {T} table
     * @param {OutputKey} key
     * @returns {ResolveOutputRow<Schema, T> | undefined}
     */
    outputMaybe<T extends TableRef>(table: T, key: OutputKey$1): ResolveOutputRow<Schema, T> | undefined;
    /**
     * Resolve the most recent iteration's output row for `nodeId` (highest
     * iteration across all matching rows). This is the correct reader for a
     * `<Loop>`/`<Ralph>` `until` exit condition; {@link outputMaybe} resolves
     * the current render iteration and can read stale/iteration-0 data inside a
     * loop.
     *
     * @template {keyof Schema & string} K
     * @overload
     * @param {K} table
     * @param {string} nodeId
     * @returns {ResolveOutputRow<Schema, K> | undefined}
     */
    latest<K extends keyof Schema & string>(table: K, nodeId: string): ResolveOutputRow<Schema, K> | undefined;
    /**
     * @template {TableRef} T
     * @overload
     * @param {T} table
     * @param {string} nodeId
     * @returns {ResolveOutputRow<Schema, T> | undefined}
     */
    latest<T extends TableRef>(table: T, nodeId: string): ResolveOutputRow<Schema, T> | undefined;
    /**
     * @param {unknown} value
     * @param {SafeParser} schema
     * @returns {unknown[]}
     */
    latestArray(value: unknown, schema: SafeParser): unknown[];
    /**
     * @param {TableRef} table
     * @param {string} nodeId
     * @returns {number}
     */
    iterationCount(table: TableRef, nodeId: string): number;
    /**
     * @param {TableRef} table
     * @returns {string}
     */
    resolveTableName(table: TableRef): string;
    /**
     * Record that a task with `deps` deferred this render because its
     * dependencies were not resolvable. Called by the Task component before it
     * returns null. The engine inspects these at quiescence to turn a permanent
     * deferral (a never-satisfiable dependency) into a loud error instead of a
     * silent skip.
     * @param {string} nodeId
     * @param {string[]} waitingOn
     * @returns {void}
     */
    recordDeferredDep(nodeId: string, waitingOn: string[]): void;
    /**
     * @param {TableRef} table
     * @param {OutputKey} key
     * @returns {OutputRow | undefined}
     */
    resolveRow(table: TableRef, key: OutputKey$1): OutputRow | undefined;
}
type OutputKey$1 = OutputKey$2;
type SafeParser = SafeParser$1;
type SmithersCtxOptions$1 = SmithersCtxOptions$2;
type RunAuthContext$1 = RunAuthContext$2;
type SmithersRuntimeConfig = SmithersRuntimeConfig$1;
type TableRef = unknown;
/**
 * User-visible output row — harness metadata fields (runId, nodeId, iteration) are stripped.
 */
type OutputRow = Record<string, unknown>;
type ResolveOutputRow<Schema, T> = ResolveOutputRow$1<Schema, T>;
type OutputAccessor$1<Schema> = OutputAccessor$2<Schema>;

type WorkflowElement = {
    type: unknown;
    props: unknown;
    key: string | number | null;
};

type WorkflowSmithersCtx<Schema = unknown> = SmithersCtx<Schema>;
type WorkflowDefinition$1<Schema = unknown> = {
    readableName?: string;
    description?: string;
    db?: unknown;
    build: (ctx: WorkflowSmithersCtx<Schema>) => WorkflowElement;
    opts: SmithersWorkflowOptions;
    schemaRegistry?: Map<string, SchemaRegistryEntry>;
    zodToKeyName?: Map<z.ZodObject<z.ZodRawShape>, string>;
};

type WorkflowGraphRenderer$1 = {
    render(element: WorkflowElement, opts?: ExtractOptions): Promise<WorkflowGraph> | WorkflowGraph;
};

type WorkflowDriverOptions$1<Schema = unknown> = {
    workflow: WorkflowDefinition$1<Schema>;
    runtime: WorkflowRuntime$2;
    renderer: WorkflowGraphRenderer$1;
    session?: WorkflowSession$2;
    createSession?: CreateWorkflowSession$1;
    db?: unknown;
    runId?: string;
    rootDir?: string;
    workflowPath?: string | null;
    executeTask?: TaskExecutor$1;
    onSchedulerWait?: SchedulerWaitHandler$1;
    onWait?: WaitHandler$1;
    continueAsNew?: ContinueAsNewHandler$1;
};

/**
 * @template {unknown} [Schema=unknown]
 */
declare class WorkflowDriver<Schema extends unknown = unknown> {
    /**
     * @param {import("./WorkflowDriverOptions.ts").WorkflowDriverOptions<Schema>} options
     */
    constructor(options: WorkflowDriverOptions$1<Schema>);
    /** @type {import("./WorkflowDefinition.ts").WorkflowDefinition<Schema>} */
    workflow: WorkflowDefinition$1<Schema>;
    /** @type {WorkflowRuntime} */
    runtime: WorkflowRuntime$1;
    /** @type {unknown} */
    db: unknown;
    /** @type {string | undefined} */
    configuredRunId: string | undefined;
    /** @type {string | undefined} */
    rootDir: string | undefined;
    /** @type {string | null | undefined} */
    workflowPath: string | null | undefined;
    /** @type {TaskExecutor} */
    executeTask: TaskExecutor;
    /** @type {SchedulerWaitHandler | undefined} */
    onSchedulerWait: SchedulerWaitHandler | undefined;
    /** @type {WaitHandler | undefined} */
    onWait: WaitHandler | undefined;
    /** @type {ContinueAsNewHandler | undefined} */
    continueAsNewHandler: ContinueAsNewHandler | undefined;
    /** @type {CreateWorkflowSession | undefined} */
    createSession: CreateWorkflowSession | undefined;
    /** @type {WorkflowGraphRenderer} */
    renderer: WorkflowGraphRenderer;
    /** @type {WorkflowSession | undefined} */
    session: WorkflowSession$1 | undefined;
    /** @type {string} */
    activeRunId: string;
    /** @type {RunOptions | undefined} */
    activeOptions: RunOptions$1 | undefined;
    /** @type {import("@smithers-orchestrator/graph").WorkflowGraph | undefined} */
    lastGraph: _smithers_orchestrator_graph.WorkflowGraph | undefined;
    /** @type {{ nodeId: string; waitingOn: string[] }[]} Tasks that deferred on unresolved deps in the latest render. */
    lastDeferredDeps: {
        nodeId: string;
        waitingOn: string[];
    }[];
    /** @type {Record<string, string>} */
    worktreePathsById: Record<string, string>;
    /** @type {Map<string, string>} */
    outputTablesByNodeId: Map<string, string>;
    /** @type {OutputSnapshot} */
    baseOutputs: OutputSnapshot$1;
    /** @type {Map<string, Promise<{ key: string; task: TaskDescriptor; kind: "completed" | "failed" | "cancelled"; output?: unknown; error?: unknown }>>} */
    inflightTasks: Map<string, Promise<{
        key: string;
        task: TaskDescriptor;
        kind: "completed" | "failed" | "cancelled";
        output?: unknown;
        error?: unknown;
    }>>;
    /** @type {Map<string, TaskDescriptor>} */
    inflightTaskDescriptors: Map<string, TaskDescriptor>;
    /** @type {Array<{ key: string; task: TaskDescriptor; kind: "completed" | "failed" | "cancelled"; output?: unknown; error?: unknown }>} */
    settledTasks: Array<{
        key: string;
        task: TaskDescriptor;
        kind: "completed" | "failed" | "cancelled";
        output?: unknown;
        error?: unknown;
    }>;
    /**
   * @param {RunOptions} options
   * @returns {Promise<RunResult>}
   */
    run(options: RunOptions$1): Promise<RunResult$1>;
    /**
   * @param {string} runId
   * @param {RunOptions} options
   * @returns {Promise<WorkflowSession>}
   */
    initializeSession(runId: string, options: RunOptions$1): Promise<WorkflowSession$1>;
    /**
   * @param {RenderContext} context
   * @returns {Promise<EngineDecision>}
   */
    renderAndSubmit(context: RenderContext): Promise<EngineDecision>;
    /**
   * @param {readonly TaskDescriptor[]} tasks
   * @returns {Promise<EngineDecision | RunResult>}
   */
    executeTasks(tasks: readonly TaskDescriptor[]): Promise<EngineDecision | RunResult$1>;
    /**
   * Start a task without blocking the driver loop on its completion. Settled
   * tasks queue in `settledTasks` and are reported to the session one at a
   * time from `nextCompletionDecision`, so each decision is computed against
   * fresh session state and a slow task never blocks scheduling work that
   * became ready elsewhere in the graph (#267).
   * @param {TaskDescriptor} task
   * @param {{ runId: string; options: RunOptions; signal?: AbortSignal }} context
   */
    startInflightTask(task: TaskDescriptor, context: {
        runId: string;
        options: RunOptions$1;
        signal?: AbortSignal;
    }): void;
    /**
   * Wait for the next settled task (or an optional deadline) and report it to
   * the session for a fresh decision. Completions that landed while a previous
   * one was being processed drain from `settledTasks` first.
   * @param {number | null} [deadlineMs]
   * @returns {Promise<EngineDecision | RunResult>}
   */
    nextCompletionDecision(deadlineMs?: number | null): Promise<EngineDecision | RunResult$1>;
    /**
   * Await every in-flight task without reporting further decisions. Used
   * before run-level exits (failure, continue-as-new) so task executors are
   * not abandoned mid-write. This matches the pre-#267 barrier semantics:
   * failure reporting waits for in-flight siblings (bounded by their
   * timeouts), trading latency for the invariant that no executor writes
   * after the run is terminal. Fail-fast would need a per-run abort threaded
   * through executors.
   */
    drainInflight(): Promise<void>;
    /**
   * @param {WaitReason} reason
   * @returns {Promise<EngineDecision | RunResult>}
   */
    handleWait(reason: WaitReason): Promise<EngineDecision | RunResult$1>;
    /**
   * @param {unknown} transition
   * @returns {Promise<RunResult>}
   */
    continueAsNew(transition: unknown): Promise<RunResult$1>;
    /**
   * @returns {Promise<RunResult>}
   */
    cancelRun(): Promise<RunResult$1>;
    /**
   * @template A
   * @param {unknown} effect
   * @returns {Promise<A>}
   */
    runEffect<A>(effect: unknown): Promise<A>;
}
type CreateWorkflowSession = CreateWorkflowSession$1;
type OutputSnapshot$1 = OutputSnapshot$2;
type WorkflowSession$1 = WorkflowSession$2;
type WorkflowRuntime$1 = WorkflowRuntime$2;
type WorkflowGraphRenderer = WorkflowGraphRenderer$1;
type TaskExecutor = TaskExecutor$1;
type SchedulerWaitHandler = SchedulerWaitHandler$1;
type WaitHandler = WaitHandler$1;
type ContinueAsNewHandler = ContinueAsNewHandler$1;
type RunOptions$1 = RunOptions$2;
type RunResult$1 = _smithers_orchestrator_scheduler.RunResult;
type EngineDecision = _smithers_orchestrator_scheduler.EngineDecision;
type RenderContext = _smithers_orchestrator_scheduler.RenderContext;
type WaitReason = _smithers_orchestrator_scheduler.WaitReason;
type TaskDescriptor = _smithers_orchestrator_graph_types.TaskDescriptor;

type HotReloadOptions = HotReloadOptions$1;
type OutputAccessor<Schema = any> = OutputAccessor$2<Schema>;
type InferOutputEntry<T> = InferOutputEntry$1<T>;
type OutputKey = OutputKey$2;
type OutputSnapshot = OutputSnapshot$2;
type RunAuthContext = RunAuthContext$2;
type RunOptions = RunOptions$2;
type RunResult = RunResult$2;
type RunStatus = RunStatus$1;
type SmithersCtxOptions = SmithersCtxOptions$2;
type WorkflowDefinition<Schema = unknown> = WorkflowDefinition$1<Schema>;
type WorkflowDriverOptions<Schema = unknown> = WorkflowDriverOptions$1<Schema>;
type WorkflowRuntime = WorkflowRuntime$2;
type WorkflowSession = WorkflowSession$2;

export { type HotReloadOptions, type InferOutputEntry, type OutputAccessor, type OutputKey, type OutputSnapshot, type RunAuthContext, type RunOptions, type RunResult, type RunStatus, SmithersCtx, type SmithersCtxOptions, type WorkflowDefinition, WorkflowDriver, type WorkflowDriverOptions, type WorkflowRuntime, type WorkflowSession };
