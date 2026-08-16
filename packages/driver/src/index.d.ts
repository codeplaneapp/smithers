import * as _smthrs_graph_types from '@smthrs/graph/types';
import { TaskDescriptor as TaskDescriptor$2, WorkflowGraph } from '@smthrs/graph/types';
import { SmithersError } from '@smthrs/errors/SmithersError';
import { SmithersEvent } from '@smthrs/observability/SmithersEvent';
import { Layer } from 'effect';
import * as _smthrs_scheduler from '@smthrs/scheduler';
import { WaitReason as WaitReason$1, EngineDecision as EngineDecision$1 } from '@smthrs/scheduler';
import { z } from 'zod';
import * as _smthrs_graph_ProofBinding from '@smthrs/graph/ProofBinding';
import { SmithersWorkflowOptions } from '@smthrs/scheduler/SmithersWorkflowOptions';
import { SchemaRegistryEntry } from '@smthrs/db/SchemaRegistryEntry';
import * as _smthrs_graph from '@smthrs/graph';
import { ExtractOptions, WorkflowGraph as WorkflowGraph$1 } from '@smthrs/graph';

/**
 * Raw signal row as loaded by a `RuntimeAdapter.signals.load` implementation
 * (or seeded via `RunOptions.signals` for tests/replay without a live
 * adapter). Mirrors `@smthrs/db`'s `SignalRow` shape minus
 * `runId` (the ctx is already run-scoped). `payloadJson` may be a JSON string
 * (as stored durably) or an already-parsed value (test convenience).
 */
type SignalRowInput$1 = {
    seq: number;
    signalName: string;
    correlationId: string | null;
    payloadJson: string | unknown;
    receivedAtMs: number;
    receivedBy?: string | null;
};
/**
 * A signal row as handed to workflow/render code. `payload` is intentionally
 * `unknown` — signals are not schema-validated at receipt time (a `smithers
 * signal` call can deliver arbitrary JSON), so typed access belongs to the
 * caller (e.g. `@smthrs/xstate`'s `eventReceived`, which
 * validates against a supplied schema and reports a typed error naming the
 * signal on failure) rather than being asserted here.
 */
type SignalRow$1 = {
    payload: unknown;
    signalName: string;
    correlationId: string | null;
    seq: number;
    receivedAtMs: number;
};
type SignalRowsOptions$1 = {
    /** Only rows delivered with this exact correlation id (or `null` for uncorrelated rows). */
    correlationId?: string | null;
};
type SignalRowsReader$2 = (signalName: string, options?: SignalRowsOptions$1) => SignalRow$1[];

type RunAuthContext$2 = {
    triggeredBy: string;
    scopes: string[];
    role: string;
    createdAt: string;
};

/**
 * Optional, self-reported provenance for the process that started a run.
 * This is distinct from authenticated `RunAuthContext` identity.
 */
type RunStartedBy$1 = {
    harness?: string;
    sessionId?: string;
    prompt?: string;
    /** Present only when environment detection supplied an identity field. */
    detected?: true;
};

type OutputSnapshot$2<TFallback = unknown> = {
    [tableName: string]: Array<TFallback>;
};

type SmithersErrorReport$1 = {
    readonly error: SmithersError;
    readonly rawError: unknown;
    readonly runId: string;
} & ({
    readonly phase: "run";
    readonly nodeId?: undefined;
    readonly iteration?: undefined;
    readonly attempt?: undefined;
} | {
    readonly phase: "node";
    readonly nodeId: string;
    readonly iteration: number;
    readonly attempt: number;
});

type EffectPlatformRuntime$1 = "bun" | "node" | "worker";
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
    /** Internal/runtime proof that maxConcurrency was explicitly persisted for this run. */
    maxConcurrencyPinned?: boolean;
    requireRerenderOnOutputChange?: boolean;
    onProgress?: (e: SmithersEvent) => void;
    /** Called once for each node or run failure occurrence. */
    onError?: (report: SmithersErrorReport$1) => void;
    signal?: AbortSignal;
    /**
     * Separate from {@link signal}: aborting this asks the driver to stop
     * scheduling new tasks and park the run `paused` once in-flight tasks settle,
     * WITHOUT aborting those tasks. Used by graceful pause.
     */
    pauseSignal?: AbortSignal;
    resume?: boolean;
    force?: boolean;
    /**
     * Take over a run whose driver is still demonstrably alive (live owner PID,
     * a heartbeating remote owner, or a held durable resume claim).
     *
     * Deliberately separate from the overloaded {@link force}: attaching a second
     * engine to a live run splits scheduling and races run/attempt writes, so it
     * must be asked for by name (`--steal-ownership`) and never as a side effect
     * of forcing something unrelated. Stale runs (dead driver, expired claim)
     * resume without it, so ordinary crash recovery is unaffected.
     */
    stealOwnership?: boolean;
    /**
     * Resume this run after its workflow source changed, re-blessing the stored
     * durability metadata (workflow hashes) in place instead of forking to a new
     * run id. Skips ONLY the two workflow-hash mismatches; workflow-path and
     * VCS-root mismatches still reject. Replay determinism becomes the caller's
     * responsibility. Only meaningful together with {@link resume}.
     */
    acceptWorkflowChange?: boolean;
    workflowPath?: string;
    rootDir?: string;
    /**
     * Keep the `<Worktree>` directories this run created instead of reaping them
     * when it finishes (default false: a successful run removes its own worktrees,
     * except any holding uncommitted or unpushed work, which are always kept).
     * Failed and cancelled runs never auto-reap. `SMITHERS_KEEP_WORKTREES=1` is
     * the process-wide equivalent.
     */
    keepWorktrees?: boolean;
    logDir?: string | null;
    allowNetwork?: boolean;
    maxOutputBytes?: number;
    /** Per-checkpoint UTF-8 JSON byte limit; defaults to and cannot exceed the 16 MiB system ceiling. */
    maxAgentCheckpointBytes?: number;
    toolTimeoutMs?: number;
    hot?: boolean | HotReloadOptions$1;
    annotations?: Record<string, string | number | boolean>;
    auth?: RunAuthContext$2 | null;
    /** Self-reported launch provenance, distinct from authenticated identity. */
    startedBy?: RunStartedBy$1;
    config?: Record<string, unknown>;
    /**
     * Effect platform runtime label for engines that support a swappable platform
     * layer. "bun" uses the engine's default Bun layer; "node" and "worker"
     * require effectPlatformLayer from the embedding runtime.
     */
    effectPlatformRuntime?: EffectPlatformRuntime$1;
    /**
     * Custom @effect/platform layer, for example NodeContext.layer supplied by a
     * Node serverless entrypoint that owns @effect/platform-node.
     */
    effectPlatformLayer?: Layer.Layer<any, never, never>;
    cliAgentToolsDefault?: "all" | "explicit-only";
    initialOutputs?: OutputSnapshot$2;
    /**
     * Fallback signal rows used when no `runtimeAdapter.signals` capability is
     * configured (e.g. tests, the browser runtime). Ignored once a live
     * adapter is present — `runtimeAdapter.signals.load` is re-read every
     * frame and takes priority.
     */
    signals?: SignalRowInput$1[];
    initialIteration?: number;
    initialIterations?: Record<string, number> | ReadonlyMap<string, number>;
    resumeClaim?: {
        claimOwnerId: string;
        claimHeartbeatAtMs: number;
        restoreRuntimeOwnerId?: string | null;
        restoreHeartbeatAtMs?: number | null;
    };
};

type TaskExecutorContext$1 = {
    runId: string;
    options: RunOptions$2;
    signal?: AbortSignal;
};

type TaskExecutor$1 = (task: TaskDescriptor$2, context: TaskExecutorContext$1) => Promise<unknown> | unknown;

/**
 * Wall-clock and monotonic timing, abstracted so the portable driver never
 * touches `Date`/`performance`/`setTimeout` directly — a runtime supplies the
 * concrete primitives (real globals in Node and in a browser; fakes in tests).
 */
type RuntimeClock$2 = {
    /** Wall-clock time in epoch milliseconds (`Date.now()` in Node/browser). */
    now(): number;
    /** Monotonic time in milliseconds (`performance.now()` in Node/browser). */
    monotonicNow(): number;
    /** Abortable delay; rejects with an `AbortError`-named error if `signal` fires first. */
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
};
/** Minimal durable run record a `RuntimeStorage` persists across the run lifecycle. */
type StoredRunState$1 = {
    runId: string;
    status: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    [key: string]: unknown;
};
/**
 * Persistence seam for the portable driver. A Node engine typically has its
 * own durable database and can treat this as a no-op; a browser (or any host
 * without a bespoke DB) backs it with real storage (e.g. an in-memory `Map`,
 * `IndexedDB`, etc.) so a run's per-task outputs and terminal state survive
 * across the whole lifecycle, not just a save-at-the-end wrapper.
 */
type RuntimeStorage$2 = {
    loadRun(runId: string): Promise<StoredRunState$1 | undefined>;
    saveRun(runId: string, run: StoredRunState$1): Promise<void>;
    loadOutputs(runId: string): Promise<OutputSnapshot$2 | undefined>;
    saveOutputs(runId: string, outputs: OutputSnapshot$2): Promise<void>;
};
/** Filesystem capability namespace. Every environment exposes this object; unsupported ops throw `RuntimeCapabilityError`. */
type RuntimeFilesystem$1 = {
    readFile(path: string): Promise<string>;
    writeFile(path: string, contents: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string, opts?: {
        recursive?: boolean;
    }): Promise<void>;
};
type RuntimeSubprocessResult$1 = {
    stdout: string;
    stderr: string;
    exitCode: number;
};
/** Subprocess capability namespace. Unsupported in any environment without real process spawning (e.g. a browser). */
type RuntimeSubprocess$1 = {
    spawn(command: string, args?: readonly string[], opts?: Record<string, unknown>): Promise<RuntimeSubprocessResult$1>;
};
/** Worktree path-resolution capability, mirroring `@smthrs/graph`'s `resolveWorktreePath` contract. */
type RuntimeWorktree$1 = {
    resolve(path: string, opts?: {
        baseRootDir?: string;
        workflowPath?: string | null;
    }): string;
};
type RuntimeSandboxResult$1 = {
    output: unknown;
};
/** Sandbox-execution capability namespace. Unsupported outside a Node/container host. */
type RuntimeSandbox$1 = {
    run(config: Record<string, unknown>): Promise<RuntimeSandboxResult$1>;
};
/**
 * Durable signal read capability. When present, `WorkflowDriver.renderAndSubmit`
 * calls `load` fresh on every render so `ctx.signalRows` always reflects the
 * latest delivered `_smithers_signals` rows for the run (no separate
 * invalidation step needed — every frame re-reads). Optional: environments
 * without a durable signal store (e.g. the browser runtime, or a driver used
 * purely for tests) fall back to whatever `RunOptions.signals` seeded once at
 * `run()` start.
 */
type RuntimeSignals$1 = {
    load(runId: string): Promise<SignalRowInput$1[]>;
};
/**
 * The full runtime contract the portable Smithers workflow core (driver +
 * scheduler + graph + renderer) depends on instead of reaching for
 * environment globals directly. A concrete adapter (Node, browser, ...) must
 * be a complete, immediately-usable implementation of this type on its own —
 * every field always present and callable, with unsupported operations
 * failing closed via `RuntimeCapabilityError` rather than being `undefined`.
 */
type RuntimeAdapter$1 = {
    /** Identifies the runtime for diagnostics and `RuntimeCapabilityError` messages (e.g. "node", "browser"). */
    readonly name: string;
    readonly clock: RuntimeClock$2;
    readonly storage: RuntimeStorage$2;
    /** Generates a new unique identifier (`crypto.randomUUID()` in Node/browser). */
    uuid(): string;
    /** Executes a single task descriptor to completion (or throws/rejects on failure). */
    executeTask: TaskExecutor$1;
    readonly filesystem: RuntimeFilesystem$1;
    readonly subprocess: RuntimeSubprocess$1;
    readonly worktree: RuntimeWorktree$1;
    readonly sandbox: RuntimeSandbox$1;
    /** Optional: see {@link RuntimeSignals}. Absent in adapters with no durable signal store. */
    readonly signals?: RuntimeSignals$1;
};

type TaskDescriptor$1 = _smthrs_graph_types.TaskDescriptor;
type TaskExecutorContext = TaskExecutorContext$1;
type BrowserRuntimeOptions$1 = {
    clock?: RuntimeClock$1;
    storage?: RuntimeStorage$1;
    uuid?: () => string;
    executeTask?: (task: TaskDescriptor$1, context: TaskExecutorContext) => Promise<unknown> | unknown;
};
type RuntimeClock$1 = RuntimeClock$2;
type RuntimeStorage$1 = RuntimeStorage$2;

/** @typedef {"filesystem" | "subprocess" | "worktree" | "sandbox"} RuntimeCapability */
/** @typedef {{ runtime: string; capability: RuntimeCapability | string; operation: string }} RuntimeCapabilityErrorDetails */
/**
 * Stable, registered `SmithersError` code every `RuntimeCapabilityError`
 * carries. Exported so callers can match on it without importing the class
 * itself (e.g. `error.code === RUNTIME_CAPABILITY_UNAVAILABLE`).
 */
declare const RUNTIME_CAPABILITY_UNAVAILABLE: "RUNTIME_CAPABILITY_UNAVAILABLE";
/**
 * Thrown by a {@link import("./RuntimeAdapter.ts").RuntimeAdapter} capability
 * namespace (`filesystem`/`subprocess`/`worktree`/`sandbox`) when the current
 * runtime does not implement the requested operation.
 *
 * Every capability namespace on a `RuntimeAdapter` is always present and
 * callable — an adapter never leaves a capability `undefined`. An environment
 * that cannot support an operation (e.g. a browser has no real filesystem)
 * fails CLOSED by throwing this typed error instead of silently no-op'ing or
 * reaching for a Node/Bun global that does not exist there.
 */
declare class RuntimeCapabilityError extends SmithersError {
    /**
     * @param {string} runtime Name of the active runtime (e.g. "browser", "node").
     * @param {string} capability Capability namespace (e.g. "filesystem", "subprocess", "worktree", "sandbox").
     * @param {string} operation Method name that was called (e.g. "readFile", "spawn", "resolve", "run").
     * @param {{ cause?: unknown }} [opts]
     */
    constructor(runtime: string, capability: string, operation: string, opts?: {
        cause?: unknown;
    });
    /** @type {string} */
    runtime: string;
    /** @type {string} */
    capability: string;
    /** @type {string} */
    operation: string;
}
type RuntimeCapability$1 = "filesystem" | "subprocess" | "worktree" | "sandbox";
type RuntimeCapabilityErrorDetails$1 = {
    runtime: string;
    capability: RuntimeCapability$1 | string;
    operation: string;
};

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
    submitGraph(graph: WorkflowGraph): unknown;
    taskCompleted(event: TaskCompletedEvent): unknown;
    taskFailed(event: TaskFailedEvent): unknown;
    getNextDecision?(): unknown;
    cancelRequested?(): unknown;
};

type WorkflowRuntime$2 = {
    runPromise<A>(effect: unknown): Promise<A>;
};

type RunStatus$1 = "running" | "waiting-approval" | "waiting-event" | "waiting-timer" | "waiting-quota" | "paused" | "finished" | "continued" | "failed" | "cancelled";

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
    /**
     * Loops that exited via `onMaxReached: "return-last"` with their `until`
     * predicate still false. Present (and non-empty) only on a `finished` result:
     * the run completed, but these loops never converged (#1464 AWF-1). See
     * `docs/runtime/run-state.mdx`.
     */
    readonly exhaustedLoops?: readonly {
        readonly id: string;
        readonly iteration: number;
        readonly maxIterations: number | null;
    }[];
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
    tasks: readonly TaskDescriptor$2[];
}) => Promise<void> | void;

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
    <K extends keyof Schema & string>(table: Schema[K]): Array<InferOutputEntry$1<Schema[K]>>;
} & {
    [K in keyof Schema & string]: Array<InferOutputEntry$1<Schema[K]>>;
};

type OutputRow$1<Payload = unknown> = {
    payload: Payload;
    nodeId: string;
    iteration: number;
    seq: number;
};
type OutputRowsOptions = {
    nodeId?: string;
    scope?: string;
};
type OutputRowsReader$2<Schema = unknown> = {
    <K extends keyof Schema & string>(output: K, options?: OutputRowsOptions): Array<OutputRow$1<InferOutputEntry$1<Schema[K]>>>;
    <T extends z.ZodTypeAny>(output: T, options?: OutputRowsOptions): Array<OutputRow$1<z.infer<T>>>;
    <T extends {
        $inferSelect: unknown;
    }>(output: T, options?: OutputRowsOptions): Array<OutputRow$1<InferRow<T>>>;
    (output: unknown, options?: OutputRowsOptions): Array<OutputRow$1<unknown>>;
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

type SmithersRuntimeConfig$1 = {
    cliAgentToolsDefault?: "all" | "explicit-only";
    maxConcurrency?: number;
    maxConcurrencyPinned?: boolean;
    requireRerenderOnOutputChange?: boolean;
    taskStates?: ReadonlyMap<string, string>;
    taskFailures?: ReadonlyMap<string, unknown>;
    baseRootDir?: string;
    workflowPath?: string | null;
    worktreePaths?: Record<string, string>;
    /** Name of the active RuntimeAdapter (e.g. "node", "browser"), used only for diagnostics. */
    runtimeName?: string;
    /**
     * Resolves a `<Worktree path>` prop the same way graph extraction does.
     * Sourced from `runtimeAdapter.worktree.resolve` by `WorkflowDriver`; when
     * absent, `SmithersCtx.resolveWorktreePath()` throws a typed
     * `RuntimeCapabilityError` instead of falling back to a Node-only import.
     */
    resolveWorktreePath?: (path: string, opts?: {
        baseRootDir?: string;
        workflowPath?: string | null;
    }) => string;
};

type SmithersCtxOptions$2 = {
    runId: string;
    iteration: number;
    iterations?: Record<string, number>;
    input: unknown;
    auth?: RunAuthContext$2 | null;
    outputs: OutputSnapshot$2;
    /** Durable `_smithers_signals` rows for this run, freshly loaded for the current frame. */
    signals?: SignalRowInput$1[];
    taskStates?: ReadonlyMap<string, unknown> | Record<string, unknown>;
    taskIterations?: ReadonlyMap<string, number> | Record<string, number>;
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
    /** @type {OutputRowsReader<Schema>} */
    outputRows: OutputRowsReader$1<Schema>;
    /** @type {SignalRowsReader} */
    signalRows: SignalRowsReader$1;
    /** @type {import("./OutputSnapshot.ts").OutputSnapshot} */
    _outputs: OutputSnapshot$2;
    /** @type {Map<unknown, string> | undefined} */
    _zodToKeyName: Map<unknown, string> | undefined;
    /** @type {Set<string>} */
    _currentScopes: Set<string>;
    /** @type {ReadonlyMap<string, unknown> | Record<string, unknown> | undefined} */
    _taskStates: ReadonlyMap<string, unknown> | Record<string, unknown> | undefined;
    /** @type {ReadonlyMap<string, number> | Record<string, number> | undefined} */
    _taskIterations: ReadonlyMap<string, number> | Record<string, number> | undefined;
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
     * the same resolver graph extraction uses. Delegates to the runtime's
     * injected `resolveWorktreePath` resolver (sourced from
     * `runtimeAdapter.worktree.resolve` — see `WorkflowDriver.renderAndSubmit`)
     * so this class never statically imports a Node-only path resolver
     * itself; that keeps `SmithersCtx` safe to bundle for non-Node runtimes.
     * Throws a typed `RuntimeCapabilityError` if no resolver was configured.
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
     * Bind to the latest (or explicitly named) persisted output row for a node.
     * The digest is computed from the typed row only; persistence identity
     * columns are carried separately in the returned binding.
     *
     * @param {TableRef} table
     * @param {OutputKey} key
     * @returns {ProofBinding | undefined}
     */
    prove(table: TableRef, key: OutputKey$1): ProofBinding$1 | undefined;
    /**
     * Whether the named task has attempted scheduling and its proof binding no
     * longer matches the current authority row.
     *
     * @param {string} nodeId
     * @returns {boolean}
     */
    boundStale(nodeId: string): boolean;
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
     * Like {@link resolveTableName}, but throws instead of degrading to
     * `String(table)` when the argument maps to no declared output table. Used
     * by the callable `ctx.outputs(...)` form, where a silent `[]` is
     * indistinguishable from "the upstream has not produced rows yet".
     * @param {TableRef} table
     * @returns {string}
     */
    requireTableName(table: TableRef): string;
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
type ProofBinding$1 = _smthrs_graph_ProofBinding.ProofBinding;
type SmithersRuntimeConfig = SmithersRuntimeConfig$1;
type TableRef = unknown;
/**
 * User-visible output row — harness metadata fields (runId, nodeId, iteration) are stripped.
 */
type OutputRow = Record<string, unknown>;
type ResolveOutputRow<Schema, T> = ResolveOutputRow$1<Schema, T>;
type OutputAccessor$1<Schema> = OutputAccessor$2<Schema>;
type OutputRowsReader$1<Schema = unknown> = OutputRowsReader$2<Schema>;
type SignalRowsReader$1 = SignalRowsReader$2;

type WorkflowElement = {
    type: unknown;
    props: unknown;
    key: string | number | null;
};

type WorkflowViewKind$1 = "ui" | "tui";
type WorkflowLiteralViewNode$1 = string | number | null | WorkflowLiteralViewNode$1[] | {
    type: string;
    props?: Record<string, unknown>;
    children?: WorkflowLiteralViewNode$1[];
};
type WorkflowViewDefinition$1 = {
    kind: WorkflowViewKind$1;
    title?: string;
    props?: Record<string, unknown>;
    entry?: string;
    path?: string;
    source?: string;
    exportName?: string;
    literal?: WorkflowLiteralViewNode$1;
};

type MemoryRuntimeRecallResult = {
    text: string;
    bank?: string;
    context?: string | null;
    occurred_start?: string | null;
    occurred_end?: string | null;
    mentioned_at?: string | null;
};
type MemoryRuntimeTagGroup$1 = {
    tags: string[];
    match?: "any" | "all" | "any_strict" | "all_strict" | "exact";
} | {
    and: MemoryRuntimeTagGroup$1[];
} | {
    or: MemoryRuntimeTagGroup$1[];
} | {
    not: MemoryRuntimeTagGroup$1;
};
type MemoryRuntimeService$1 = {
    recallMemory(input: {
        banks: string[];
        query: string;
        tags?: string[];
        tagGroupsByBank?: Record<string, MemoryRuntimeTagGroup$1[]>;
        budget?: "low" | "mid" | "high";
        maxTokens?: number;
        signal?: AbortSignal;
    }): Promise<MemoryRuntimeRecallResult[]>;
    getPrimers(input: {
        banks: string[];
        primerIds: string[];
        signal?: AbortSignal;
    }): Promise<Array<{
        bank?: string;
        id: string;
        content: string;
    }>>;
    retainMemory(input: {
        bank: string;
        content: string;
        tags?: string[];
        metadata?: Record<string, string>;
        documentId: string;
        updateMode?: "replace" | "append";
        async?: boolean;
        context?: string;
        signal?: AbortSignal;
    }): Promise<void>;
};

type WorkflowSmithersCtx<Schema = unknown> = SmithersCtx<Schema>;
type WorkflowDefinition$1<Schema = unknown> = {
    readableName?: string;
    description?: string;
    ui?: WorkflowViewDefinition$1;
    tui?: WorkflowViewDefinition$1;
    db?: unknown;
    build: (ctx: WorkflowSmithersCtx<Schema>) => WorkflowElement;
    opts: SmithersWorkflowOptions;
    /** Memory bridge selected by `openSmithersBackend`, when available. */
    memoryService?: MemoryRuntimeService$1;
    schemaRegistry?: Map<string, SchemaRegistryEntry>;
    zodToKeyName?: Map<z.ZodObject<z.ZodRawShape>, string>;
};

type WorkflowGraphRenderer$1 = {
    render(element: WorkflowElement, opts?: ExtractOptions): Promise<WorkflowGraph$1> | WorkflowGraph$1;
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
    /**
     * Environment seam for the portable driver: supplies clock/storage/uuid,
     * a default `executeTask`, and OS-capability namespaces
     * (filesystem/subprocess/worktree/sandbox) that fail closed with
     * `RuntimeCapabilityError` when unimplemented. Optional — when absent, the
     * driver behaves exactly as it did before `RuntimeAdapter` existed (no
     * storage threading, no worktree resolver, `defaultTaskExecutor` as the
     * final `executeTask` fallback).
     */
    runtimeAdapter?: RuntimeAdapter$1;
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
    /** @type {import("@smthrs/graph").WorkflowGraph | undefined} */
    lastGraph: _smthrs_graph.WorkflowGraph | undefined;
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
    /** @type {import("./SignalRows.ts").SignalRowInput[]} Fallback signal rows when no `runtimeAdapter.signals` capability is configured. */
    baseSignals: SignalRowInput$1[];
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
    /** A paused child task parks the run through the same graceful drain path as a direct pause signal. */
    pausedByChildSuspension: boolean;
    /** @type {import("./RuntimeAdapter.ts").RuntimeAdapter | undefined} */
    runtimeAdapter: RuntimeAdapter$1 | undefined;
    /** @type {OutputSnapshot} Output rows persisted to runtimeAdapter.storage this run, kept in sync so each save is a full, monotonically-growing snapshot. */
    persistedOutputs: OutputSnapshot$1;
    /** @type {import("./RuntimeAdapter.ts").StoredRunState | undefined} */
    storedRun: StoredRunState$1 | undefined;
    /**
     * Persist a partial run-state patch through `runtimeAdapter.storage`, if
     * configured. A no-op when no runtimeAdapter (or no storage) was supplied,
     * so existing callers that never wired a RuntimeAdapter see no behavior
     * change.
     * @param {Partial<import("./RuntimeAdapter.ts").StoredRunState>} patch
     * @returns {Promise<void>}
     */
    persistRunState(patch: Partial<StoredRunState$1>): Promise<void>;
    /**
     * Persist a single completed task's output row through
     * `runtimeAdapter.storage`, merging it into the full per-run output
     * snapshot so `storage.loadOutputs(runId)` always reflects every
     * completed task's output table — not just the terminal result.
     * @param {TaskDescriptor} task
     * @param {unknown} output
     * @returns {Promise<void>}
     */
    persistTaskOutput(task: TaskDescriptor, output: unknown): Promise<void>;
    /**
     * @param {RunOptions} options
     * @returns {Promise<RunResult>}
     */
    run(options: RunOptions$1): Promise<RunResult$1>;
    /**
     * The body of `run()` up to (but not including) durable run-state
     * persistence — split out so every exit path (including the early
     * signal-abort return) is persisted uniformly by `run()`.
     * @param {string} runId
     * @param {RunOptions} options
     * @returns {Promise<RunResult>}
     */
    runUntilTerminal(runId: string, options: RunOptions$1): Promise<RunResult$1>;
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
type RunResult$1 = _smthrs_scheduler.RunResult;
type EngineDecision = _smthrs_scheduler.EngineDecision;
type RenderContext = _smthrs_scheduler.RenderContext;
type WaitReason = _smthrs_scheduler.WaitReason;
type TaskDescriptor = _smthrs_graph_types.TaskDescriptor;

/**
 * Clamp a startedBy prompt to its persisted budget, surrogate-pair safe.
 * Transports call this BEFORE generic frame string bounds so an over-long
 * prompt truncates (the documented behavior) instead of rejecting the frame.
 *
 * @param {string} prompt
 * @returns {string}
 */
declare function clampRunStartedByPrompt(prompt: string): string;
/**
 * Normalize optional harness provenance at public ingress and before durable
 * persistence. Unknown object keys are intentionally ignored for direct JS
 * callers; public schemas reject them before this helper runs.
 *
 * @param {unknown} value
 * @returns {import("./RunStartedBy.ts").RunStartedBy | undefined}
 */
declare function normalizeRunStartedBy(value: unknown): RunStartedBy$1 | undefined;
declare const RUN_STARTED_BY_HARNESS_MAX_CODE_POINTS: 64;
declare const RUN_STARTED_BY_SESSION_ID_MAX_CODE_POINTS: 256;
declare const RUN_STARTED_BY_PROMPT_MAX_CODE_POINTS: 8192;

type HotReloadOptions = HotReloadOptions$1;
type OutputAccessor<Schema = any> = OutputAccessor$2<Schema>;
type InferOutputEntry<T> = InferOutputEntry$1<T>;
type OutputKey = OutputKey$2;
type OutputSnapshot = OutputSnapshot$2;
type OutputRowsReader<Schema = unknown> = OutputRowsReader$2<Schema>;
type ProofBinding = _smthrs_graph_ProofBinding.ProofBinding;
type RunAuthContext = RunAuthContext$2;
type RunStartedBy = RunStartedBy$1;
type EffectPlatformRuntime = EffectPlatformRuntime$1;
type RunOptions = RunOptions$2;
type SmithersErrorReport = SmithersErrorReport$1;
type RunResult = RunResult$2;
type RunStatus = RunStatus$1;
type MemoryRuntimeService = MemoryRuntimeService$1;
type MemoryRuntimeTagGroup = MemoryRuntimeTagGroup$1;
type SmithersCtxOptions = SmithersCtxOptions$2;
type WorkflowDefinition<Schema = unknown> = WorkflowDefinition$1<Schema>;
type WorkflowLiteralViewNode = WorkflowLiteralViewNode$1;
type WorkflowViewDefinition = WorkflowViewDefinition$1;
type WorkflowViewKind = WorkflowViewKind$1;
type WorkflowDriverOptions<Schema = unknown> = WorkflowDriverOptions$1<Schema>;
type WorkflowRuntime = WorkflowRuntime$2;
type WorkflowSession = WorkflowSession$2;
type RuntimeAdapter = RuntimeAdapter$1;
type RuntimeClock = RuntimeClock$2;
type RuntimeStorage = RuntimeStorage$2;
type RuntimeFilesystem = RuntimeFilesystem$1;
type RuntimeSubprocess = RuntimeSubprocess$1;
type RuntimeSubprocessResult = RuntimeSubprocessResult$1;
type RuntimeWorktree = RuntimeWorktree$1;
type RuntimeSandbox = RuntimeSandbox$1;
type RuntimeSandboxResult = RuntimeSandboxResult$1;
type RuntimeSignals = RuntimeSignals$1;
type StoredRunState = StoredRunState$1;
type RuntimeCapability = RuntimeCapability$1;
type RuntimeCapabilityErrorDetails = RuntimeCapabilityErrorDetails$1;
type BrowserRuntimeOptions = BrowserRuntimeOptions$1;
type SignalRowInput = SignalRowInput$1;
type SignalRow = SignalRow$1;
type SignalRowsOptions = SignalRowsOptions$1;
type SignalRowsReader = SignalRowsReader$2;

export { type BrowserRuntimeOptions, type EffectPlatformRuntime, type HotReloadOptions, type InferOutputEntry, type MemoryRuntimeService, type MemoryRuntimeTagGroup, type OutputAccessor, type OutputKey, type OutputRowsReader, type OutputSnapshot, type ProofBinding, RUNTIME_CAPABILITY_UNAVAILABLE, RUN_STARTED_BY_HARNESS_MAX_CODE_POINTS, RUN_STARTED_BY_PROMPT_MAX_CODE_POINTS, RUN_STARTED_BY_SESSION_ID_MAX_CODE_POINTS, type RunAuthContext, type RunOptions, type RunResult, type RunStartedBy, type RunStatus, type RuntimeAdapter, type RuntimeCapability, RuntimeCapabilityError, type RuntimeCapabilityErrorDetails, type RuntimeClock, type RuntimeFilesystem, type RuntimeSandbox, type RuntimeSandboxResult, type RuntimeSignals, type RuntimeStorage, type RuntimeSubprocess, type RuntimeSubprocessResult, type RuntimeWorktree, type SignalRow, type SignalRowInput, type SignalRowsOptions, type SignalRowsReader, SmithersCtx, type SmithersCtxOptions, type SmithersErrorReport, type StoredRunState, type WorkflowDefinition, WorkflowDriver, type WorkflowDriverOptions, type WorkflowLiteralViewNode, type WorkflowRuntime, type WorkflowSession, type WorkflowViewDefinition, type WorkflowViewKind, clampRunStartedByPrompt, normalizeRunStartedBy };
