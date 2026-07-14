import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { SmithersCtx } from "./SmithersCtx.js";
import { defaultTaskExecutor } from "./defaultTaskExecutor.js";
import { withAbort } from "./withAbort.js";
/** @typedef {import("./CreateWorkflowSession.ts").CreateWorkflowSession} CreateWorkflowSession */
/** @typedef {import("./OutputSnapshot.ts").OutputSnapshot} OutputSnapshot */
/** @typedef {import("./WorkflowSession.ts").WorkflowSession} WorkflowSession */
/** @typedef {import("./WorkflowRuntime.ts").WorkflowRuntime} WorkflowRuntime */
/** @typedef {import("./WorkflowGraphRenderer.ts").WorkflowGraphRenderer} WorkflowGraphRenderer */
/** @typedef {import("./TaskExecutor.ts").TaskExecutor} TaskExecutor */
/** @typedef {import("./SchedulerWaitHandler.ts").SchedulerWaitHandler} SchedulerWaitHandler */
/** @typedef {import("./WaitHandler.ts").WaitHandler} WaitHandler */
/** @typedef {import("./ContinueAsNewHandler.ts").ContinueAsNewHandler} ContinueAsNewHandler */

/** @typedef {import("./RunOptions.ts").RunOptions} RunOptions */
/** @typedef {import("@smithers-orchestrator/scheduler").RunResult} RunResult */
/** @typedef {import("@smithers-orchestrator/scheduler").EngineDecision} EngineDecision */
/** @typedef {import("@smithers-orchestrator/scheduler").RenderContext} RenderContext */
/** @typedef {import("@smithers-orchestrator/scheduler").WaitReason} WaitReason */
/** @typedef {import("@smithers-orchestrator/graph/types").TaskDescriptor} TaskDescriptor */

const SCHEDULER_SPECIFIER = "@smithers-orchestrator/scheduler";
/**
 * @param {import("./RuntimeAdapter.ts").RuntimeAdapter} [adapter]
 * @returns {string}
 */
function createRunId(adapter) {
    if (typeof adapter?.uuid === "function") {
        return `run_${adapter.uuid()}`;
    }
    return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
/**
 * @param {unknown} value
 * @returns {value is EngineDecision}
 */
function isEngineDecision(value) {
    if (!value || typeof value !== "object")
        return false;
    return typeof value._tag === "string";
}
/**
 * @param {unknown} value
 * @returns {value is RunResult}
 */
function isRunResult(value) {
    if (!value || typeof value !== "object")
        return false;
    const status = value.status;
    return typeof status === "string";
}
/**
 * @param {unknown} value
 * @returns {value is WorkflowSession}
 */
function isWorkflowSession(value) {
    return Boolean(value &&
        typeof value === "object" &&
        typeof value.submitGraph === "function" &&
        typeof value.taskCompleted === "function" &&
        typeof value.taskFailed === "function");
}
/**
 * @param {Record<string, number> | ReadonlyMap<string, number>} [iterations]
 * @returns {Record<string, number> | undefined}
 */
function recordFromIterations(iterations) {
    if (!iterations)
        return undefined;
    if (typeof iterations.entries === "function") {
        return Object.fromEntries(iterations);
    }
    return iterations;
}
/**
 * @param {readonly TaskDescriptor[]} tasks
 * @returns {Record<string, string>}
 */
function buildWorktreePathLookup(tasks) {
    /** @type {Record<string, string>} */
    const lookup = {};
    for (const task of tasks) {
        if (!task.worktreePath)
            continue;
        lookup[task.nodeId] = task.worktreePath;
        if (task.worktreeId && lookup[task.worktreeId] === undefined) {
            lookup[task.worktreeId] = task.worktreePath;
        }
    }
    return lookup;
}
/**
 * @param {RenderContext} context
 * @param {ReadonlyMap<string, string>} [knownOutputTables]
 * @returns {OutputSnapshot}
 */
function snapshotFromContext(context, knownOutputTables) {
    const outputs = context.outputs;
    if (!outputs)
        return {};
    if (typeof outputs.values !== "function") {
        return normalizeOutputSnapshot(outputs);
    }
    const outputMap = outputs;
    /** @type {Map<string, string | undefined>} nodeId -> outputTableName */
    const descriptors = new Map();
    for (const [nodeId, outputTableName] of knownOutputTables ?? []) {
        descriptors.set(nodeId, outputTableName);
    }
    for (const task of context.graph?.tasks ?? []) {
        descriptors.set(task.nodeId, task.outputTableName);
    }
    const snapshot = {};
    for (const output of outputMap.values()) {
        const tableName = descriptors.get(output.nodeId);
        if (!tableName)
            continue;
        const row = output.output && typeof output.output === "object" && !Array.isArray(output.output)
            ? {
                ...output.output,
                nodeId: output.nodeId,
                iteration: output.iteration,
            }
            : {
                nodeId: output.nodeId,
                iteration: output.iteration,
                payload: output.output,
            };
        (snapshot[tableName] ??= []).push(row);
    }
    return snapshot;
}
/**
 * @param {unknown} value
 * @returns {OutputSnapshot}
 */
function normalizeOutputSnapshot(value) {
    if (!value || typeof value !== "object")
        return {};
    const snapshot = {};
    for (const [key, rows] of Object.entries(value)) {
        snapshot[key] = Array.isArray(rows) ? rows : [];
    }
    return snapshot;
}
/**
 * @param {OutputSnapshot} base
 * @param {OutputSnapshot} live
 * @returns {OutputSnapshot}
 */
function mergeOutputSnapshots(base, live) {
    const merged = {};
    for (const [key, rows] of Object.entries(base)) {
        merged[key] = [...rows];
    }
    for (const [key, rows] of Object.entries(live)) {
        merged[key] = [...(merged[key] ?? []), ...rows];
    }
    return merged;
}
/**
 * @returns {Promise<CreateWorkflowSession | null>}
 */
async function loadCreateSession() {
    let mod;
    try {
        // The scheduler is a workspace dependency, so the package specifier always
        // resolves (no relative-path fallback needed).
        mod = (await import(SCHEDULER_SPECIFIER));
    }
    catch {
        return null;
    }
    if (typeof mod.makeWorkflowSession === "function") {
        return mod.makeWorkflowSession;
    }
    return null;
}
/**
 * Build a diagnostic for tasks that declared `deps` they could never resolve, so
 * they deferred (returned null) instead of mounting and the run reached
 * quiescence without them. Left undetected this is a silent skip — the run
 * "finishes" without ever running the task.
 * @param {{ nodeId: string; waitingOn: string[] }[]} deferred
 * @returns {string}
 */
function describeDeferredDeadlock(deferred) {
    const lines = deferred.map(({ nodeId, waitingOn }) => {
        const detail = waitingOn.length === 0
            ? "its deps never resolved"
            : `waiting on ${waitingOn.map((id) => `'${id}'`).join(", ")}`;
        return `  - '${nodeId}' never ran (${detail})`;
    });
    return [
        "Workflow has task(s) that can never run: their deps reference outputs no task produces.",
        ...lines,
        "",
        "A deps={{ <key>: ... }} entry resolves <key> as the upstream task's id unless you remap it. " +
            "Add needs={{ <key>: '<upstream task id>' }} (or rename the upstream task to match the key) so the dependency points at a real task.",
    ].join("\n");
}
/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbortError(error) {
    return Boolean(error &&
        typeof error === "object" &&
        "name" in error &&
        error.name === "AbortError");
}
/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
async function sleepWithAbort(ms, signal) {
    if (signal?.aborted) {
        const error = new Error("Task aborted");
        error.name = "AbortError";
        throw error;
    }
    if (ms <= 0)
        return;
    let timeout;
    const sleep = new Promise((resolve) => {
        timeout = setTimeout(resolve, ms);
    });
    try {
        await withAbort(sleep, signal);
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
    }
}
/**
 * @template {unknown} [Schema=unknown]
 */
export class WorkflowDriver {
    /** @type {import("./WorkflowDefinition.ts").WorkflowDefinition<Schema>} */
    workflow;
    /** @type {WorkflowRuntime} */
    runtime;
    /** @type {unknown} */
    db;
    /** @type {string | undefined} */
    configuredRunId;
    /** @type {string | undefined} */
    rootDir;
    /** @type {string | null | undefined} */
    workflowPath;
    /** @type {TaskExecutor} */
    executeTask;
    /** @type {SchedulerWaitHandler | undefined} */
    onSchedulerWait;
    /** @type {WaitHandler | undefined} */
    onWait;
    /** @type {ContinueAsNewHandler | undefined} */
    continueAsNewHandler;
    /** @type {CreateWorkflowSession | undefined} */
    createSession;
    /** @type {WorkflowGraphRenderer} */
    renderer;
    /** @type {WorkflowSession | undefined} */
    session;
    /** @type {string} */
    activeRunId = "";
    /** @type {RunOptions | undefined} */
    activeOptions;
    /** @type {import("@smithers-orchestrator/graph").WorkflowGraph | undefined} */
    lastGraph;
    /** @type {{ nodeId: string; waitingOn: string[] }[]} Tasks that deferred on unresolved deps in the latest render. */
    lastDeferredDeps = [];
    /** @type {Record<string, string>} */
    worktreePathsById = {};
    /** @type {Map<string, string>} */
    outputTablesByNodeId = new Map();
    /** @type {OutputSnapshot} */
    baseOutputs = {};
    /** @type {Map<string, Promise<{ key: string; task: TaskDescriptor; kind: "completed" | "failed" | "cancelled"; output?: unknown; error?: unknown }>>} */
    inflightTasks = new Map();
    /** @type {Map<string, TaskDescriptor>} */
    inflightTaskDescriptors = new Map();
    /** @type {Array<{ key: string; task: TaskDescriptor; kind: "completed" | "failed" | "cancelled"; output?: unknown; error?: unknown }>} */
    settledTasks = [];
    /** @type {import("./RuntimeAdapter.ts").RuntimeAdapter | undefined} */
    runtimeAdapter;
    /** @type {OutputSnapshot} Output rows persisted to runtimeAdapter.storage this run, kept in sync so each save is a full, monotonically-growing snapshot. */
    persistedOutputs = {};
    /** @type {import("./RuntimeAdapter.ts").StoredRunState | undefined} */
    storedRun;
    /**
     * @param {import("./WorkflowDriverOptions.ts").WorkflowDriverOptions<Schema>} options
     */
    constructor(options) {
        this.workflow = options.workflow;
        this.runtime = options.runtime;
        this.db = options.db ?? options.workflow.db;
        this.configuredRunId = options.runId;
        this.rootDir = options.rootDir;
        this.workflowPath = options.workflowPath;
        this.session = options.session;
        this.createSession = options.createSession;
        this.runtimeAdapter = options.runtimeAdapter;
        this.executeTask = options.executeTask ?? this.runtimeAdapter?.executeTask ?? defaultTaskExecutor;
        this.onSchedulerWait = options.onSchedulerWait;
        this.onWait = options.onWait;
        this.continueAsNewHandler = options.continueAsNew;
        this.renderer = options.renderer;
    }
    /**
     * Persist a partial run-state patch through `runtimeAdapter.storage`, if
     * configured. A no-op when no runtimeAdapter (or no storage) was supplied,
     * so existing callers that never wired a RuntimeAdapter see no behavior
     * change.
     * @param {Partial<import("./RuntimeAdapter.ts").StoredRunState>} patch
     * @returns {Promise<void>}
     */
    async persistRunState(patch) {
        if (!this.runtimeAdapter?.storage)
            return;
        this.storedRun = /** @type {import("./RuntimeAdapter.ts").StoredRunState} */ ({
            ...this.storedRun,
            runId: this.activeRunId,
            ...patch,
        });
        await this.runtimeAdapter.storage.saveRun(this.activeRunId, this.storedRun);
    }
    /**
     * Persist a single completed task's output row through
     * `runtimeAdapter.storage`, merging it into the full per-run output
     * snapshot so `storage.loadOutputs(runId)` always reflects every
     * completed task's output table — not just the terminal result.
     * @param {TaskDescriptor} task
     * @param {unknown} output
     * @returns {Promise<void>}
     */
    async persistTaskOutput(task, output) {
        if (!this.runtimeAdapter?.storage)
            return;
        const tableName = this.outputTablesByNodeId.get(task.nodeId);
        if (!tableName)
            return;
        const row = output && typeof output === "object" && !Array.isArray(output)
            ? { ...output, nodeId: task.nodeId, iteration: task.iteration }
            : { nodeId: task.nodeId, iteration: task.iteration, payload: output };
        this.persistedOutputs = mergeOutputSnapshots(this.persistedOutputs, { [tableName]: [row] });
        await this.runtimeAdapter.storage.saveOutputs(this.activeRunId, this.persistedOutputs);
    }
    /**
   * @param {RunOptions} options
   * @returns {Promise<RunResult>}
   */
    async run(options) {
        const runId = options.runId ?? this.configuredRunId ?? createRunId(this.runtimeAdapter);
        this.activeRunId = runId;
        this.activeOptions = options;
        this.baseOutputs = normalizeOutputSnapshot(options.initialOutputs ?? options.outputs);
        if (this.runtimeAdapter?.storage) {
            // Resume support: seed already-persisted per-task outputs (and the
            // last stored run record) so a resumed run's render sees every prior
            // task's output row, not just whatever the caller passed in.
            const [storedRun, storedOutputs] = await Promise.all([
                this.runtimeAdapter.storage.loadRun(runId),
                this.runtimeAdapter.storage.loadOutputs(runId),
            ]);
            this.storedRun = storedRun;
            if (storedOutputs) {
                this.persistedOutputs = storedOutputs;
                this.baseOutputs = mergeOutputSnapshots(this.baseOutputs, storedOutputs);
            }
            await this.persistRunState({ status: "running", input: options.input });
        }
        const result = await this.runUntilTerminal(runId, options);
        await this.persistRunState({
            status: result.status,
            ...("error" in result && result.error !== undefined ? { error: result.error } : {}),
            ...("output" in result && result.output !== undefined ? { output: result.output } : {}),
        });
        return result;
    }
    /**
   * The body of `run()` up to (but not including) durable run-state
   * persistence — split out so every exit path (including the early
   * signal-abort return) is persisted uniformly by `run()`.
   * @param {string} runId
   * @param {RunOptions} options
   * @returns {Promise<RunResult>}
   */
    async runUntilTerminal(runId, options) {
        this.session = this.session ?? (await this.initializeSession(runId, options));
        if (options.signal?.aborted) {
            return this.cancelRun();
        }
        const initialIterations = recordFromIterations(options.initialIterations ??
            options.iterations ??
            options.ralphIterations);
        let decision = await this.renderAndSubmit({
            runId,
            iteration: typeof options.initialIteration === "number"
                ? options.initialIteration
                : typeof options.iteration === "number"
                    ? options.iteration
                    : 0,
            iterations: initialIterations ?? {},
            input: options.input,
            outputs: {},
            auth: options.auth ?? null,
        });
        while (true) {
            if (this.activeOptions?.signal?.aborted) {
                return this.cancelRun();
            }
            // Graceful pause: stop scheduling new tasks, let already-started tasks
            // settle (drainInflight never aborts them), then park the run resumably.
            // The pause signal is separate from the abort signal so in-flight work
            // completes instead of being killed.
            if (this.activeOptions?.pauseSignal?.aborted) {
                await this.drainInflight();
                // A cancel can land during the drain window: the engine's
                // pause-watcher keeps polling and aborts the run signal when
                // cancel is requested. Re-check after draining so the durable
                // cancel wins over parking; otherwise finalizeDriverResult's
                // paused branch clears cancelRequestedAtMs and erases it.
                if (this.activeOptions?.signal?.aborted)
                    return this.cancelRun();
                return { runId, status: "paused" };
            }
            switch (decision._tag) {
                case "Execute": {
                    const next = await this.executeTasks(decision.tasks);
                    if (isRunResult(next))
                        return next;
                    decision = next;
                    break;
                }
                case "ReRender":
                    decision = await this.renderAndSubmit(decision.context);
                    break;
                case "Wait": {
                    const next = await this.handleWait(decision.reason);
                    if (isRunResult(next))
                        return next;
                    decision = next;
                    break;
                }
                case "ContinueAsNew":
                    await this.drainInflight();
                    return this.continueAsNew(decision.transition);
                case "Finished": {
                    if (this.lastDeferredDeps.length > 0) {
                        await this.drainInflight();
                        return {
                            runId,
                            status: "failed",
                            error: new SmithersError("DEPENDENCY_DEADLOCK", describeDeferredDeadlock(this.lastDeferredDeps)),
                        };
                    }
                    return decision.result;
                }
                case "Failed":
                    await this.drainInflight();
                    return { runId, status: "failed", error: decision.error };
                default:
                    return {
                        runId,
                        status: "failed",
                        error: new Error(`Unknown engine decision: ${String(decision?._tag)}`),
                    };
            }
        }
    }
    /**
   * @param {string} runId
   * @param {RunOptions} options
   * @returns {Promise<WorkflowSession>}
   */
    async initializeSession(runId, options) {
        const createSession = this.createSession ?? (await loadCreateSession());
        if (!createSession) {
            throw new Error("WorkflowDriver requires a WorkflowSession or createSession from @smithers-orchestrator/scheduler.");
        }
        const created = createSession({
            db: this.db,
            runId,
            rootDir: options.rootDir ?? this.rootDir,
            workflowPath: options.workflowPath ?? this.workflowPath ?? null,
            options,
        });
        if (isWorkflowSession(created)) {
            return created;
        }
        return this.runEffect(created);
    }
    /**
   * @param {RenderContext} context
   * @returns {Promise<EngineDecision>}
   */
    async renderAndSubmit(context) {
        if (!this.session) {
            throw new Error("WorkflowSession is not initialized.");
        }
        const iteration = typeof context.iteration === "number" ? context.iteration : 0;
        const iterations = recordFromIterations(context.iterations ?? context.ralphIterations);
        const baseRootDir = this.activeOptions?.rootDir ?? this.rootDir;
        const workflowPath = this.activeOptions?.workflowPath ?? this.workflowPath ?? null;
        // Sourced from the runtimeAdapter (Node: wraps the real, unmodified
        // resolveWorktreePath; browser: fails closed with a typed
        // RuntimeCapabilityError) rather than imported here directly, so this
        // portable driver never statically pulls in a Node-only path resolver.
        const resolveWorktreePathFn = this.runtimeAdapter?.worktree?.resolve;
        const ctx = new SmithersCtx({
            runId: context.runId,
            iteration,
            iterations,
            input: context.input ?? this.activeOptions?.input ?? {},
            auth: context.auth,
            outputs: mergeOutputSnapshots(this.baseOutputs, snapshotFromContext(context, this.outputTablesByNodeId)),
            zodToKeyName: this.workflow.zodToKeyName,
            runtimeConfig: {
                ...(this.activeOptions?.cliAgentToolsDefault
                    ? { cliAgentToolsDefault: this.activeOptions.cliAgentToolsDefault }
                    : {}),
                baseRootDir,
                workflowPath,
                worktreePaths: this.worktreePathsById,
                ...(resolveWorktreePathFn
                    ? { resolveWorktreePath: resolveWorktreePathFn, runtimeName: this.runtimeAdapter?.name }
                    : {}),
            },
        });
        let graph;
        try {
            graph = await this.renderer.render(this.workflow.build(ctx), {
                ralphIterations: context.iterations ?? context.ralphIterations,
                defaultIteration: iteration,
                baseRootDir,
                workflowPath,
                trigger: context.trigger,
                ...(resolveWorktreePathFn ? { resolveWorktreePath: resolveWorktreePathFn } : {}),
            });
        }
        catch (renderError) {
            // Typed errors (CONTEXT_OUTSIDE_WORKFLOW, DUPLICATE_ID, ...) are
            // already friendly — pass them through unchanged. Everything else
            // is a raw exception from the user's workflow component (a plain
            // TypeError with a React-internals stack), which is useless
            // without the workflow it came from. Name the workflow and, for
            // the classic null-dispatcher crash, say what it means.
            if (renderError instanceof SmithersError) {
                throw renderError;
            }
            const rawMessage = renderError instanceof Error
                ? renderError.message
                : String(renderError);
            const hooksHint = /dispatcher\.useContext|Invalid hook call|null is not an object[\s\S]{0,80}useContext/i.test(rawMessage)
                ? " This usually means a React hook (useSmithers/useContext/useCtx) was called outside a component render — call hooks at the top level of a component function, not at module scope or inside a callback."
                : "";
            throw new SmithersError("WORKFLOW_RENDER_FAILED", `Rendering workflow${workflowPath ? ` "${workflowPath}"` : ""} threw: ${rawMessage}.${hooksHint}`, {
                workflowPath: workflowPath ?? null,
            }, { cause: renderError });
        }
        // Capture tasks that deferred on unresolved deps this render so the run
        // loop can fail loudly if any survive to a Finished decision instead of
        // silently skipping them.
        this.lastDeferredDeps = ctx._deferredDeps ?? [];
        for (const task of graph.tasks) {
            if (task.outputTableName) {
                this.outputTablesByNodeId.set(task.nodeId, task.outputTableName);
            }
        }
        this.worktreePathsById = buildWorktreePathLookup(graph.tasks);
        this.lastGraph = graph;
        return this.runEffect(this.session.submitGraph(graph));
    }
    /**
   * @param {readonly TaskDescriptor[]} tasks
   * @returns {Promise<EngineDecision | RunResult>}
   */
    async executeTasks(tasks) {
        if (!this.session) {
            throw new Error("WorkflowSession is not initialized.");
        }
        const context = {
            runId: this.activeRunId,
            options: this.activeOptions ?? { input: {} },
            signal: this.activeOptions?.signal,
        };
        if (context.signal?.aborted) {
            return this.cancelRun();
        }
        for (const task of tasks) {
            this.startInflightTask(task, context);
        }
        return this.nextCompletionDecision();
    }
    /**
   * Start a task without blocking the driver loop on its completion. Settled
   * tasks queue in `settledTasks` and are reported to the session one at a
   * time from `nextCompletionDecision`, so each decision is computed against
   * fresh session state and a slow task never blocks scheduling work that
   * became ready elsewhere in the graph (#267).
   * @param {TaskDescriptor} task
   * @param {{ runId: string; options: RunOptions; signal?: AbortSignal }} context
   */
    startInflightTask(task, context) {
        const key = `${task.nodeId}::${task.iteration}`;
        if (this.inflightTasks.has(key)) {
            return;
        }
        const promise = (async () => {
            try {
                const output = await withAbort(Promise.resolve().then(() => this.executeTask(task, context)), context.signal);
                return { key, task, kind: /** @type {const} */ ("completed"), output };
            }
            catch (error) {
                if (context.signal?.aborted || isAbortError(error)) {
                    return { key, task, kind: /** @type {const} */ ("cancelled") };
                }
                return { key, task, kind: /** @type {const} */ ("failed"), error };
            }
        })().then((settled) => {
            this.inflightTasks.delete(key);
            this.inflightTaskDescriptors.delete(key);
            this.settledTasks.push(settled);
            return settled;
        });
        this.inflightTasks.set(key, promise);
        this.inflightTaskDescriptors.set(key, task);
    }
    /**
   * Wait for the next settled task (or an optional deadline) and report it to
   * the session for a fresh decision. Completions that landed while a previous
   * one was being processed drain from `settledTasks` first.
   * @param {number | null} [deadlineMs]
   * @returns {Promise<EngineDecision | RunResult>}
   */
    async nextCompletionDecision(deadlineMs = null) {
        if (!this.session) {
            throw new Error("WorkflowSession is not initialized.");
        }
        let waitedTasks = [];
        let waitStart = 0;
        try {
            if (this.settledTasks.length === 0 && this.inflightTasks.size > 0) {
                waitedTasks = [...this.inflightTaskDescriptors.values()];
                waitStart = performance.now();
                const racers = [...this.inflightTasks.values()];
                if (deadlineMs != null) {
                    racers.push(sleepWithAbort(deadlineMs, this.activeOptions?.signal).then(() => null));
                }
                try {
                    await Promise.race(racers);
                }
                catch (error) {
                    if (!this.activeOptions?.signal?.aborted || !isAbortError(error)) {
                        throw error;
                    }
                }
            }
        }
        finally {
            if (waitedTasks.length > 0) {
                await this.onSchedulerWait?.(performance.now() - waitStart, {
                    runId: this.activeRunId,
                    tasks: waitedTasks,
                });
            }
        }
        if (this.activeOptions?.signal?.aborted) {
            return this.cancelRun();
        }
        const settled = this.settledTasks.shift();
        if (!settled) {
            // Deadline elapsed (retry backoff / timer) without a completion —
            // re-submit the last graph for a fresh decision.
            if (this.lastGraph) {
                return this.runEffect(this.session.submitGraph(this.lastGraph));
            }
            return { runId: this.activeRunId, status: "waiting-event" };
        }
        if (settled.kind === "cancelled") {
            return this.cancelRun();
        }
        if (settled.kind === "completed") {
            // Persist this task's output row as it lands — not just a
            // save-at-the-end wrapper — so `storage.loadOutputs(runId)`
            // reflects every completed task, including ones a downstream task
            // in the same run already consumed via ctx.outputs/SmithersCtx.
            await this.persistTaskOutput(settled.task, settled.output);
        }
        const report = settled.kind === "completed"
            ? await this.runEffect(this.session.taskCompleted({
                nodeId: settled.task.nodeId,
                iteration: settled.task.iteration,
                output: settled.output,
            }))
            : await this.runEffect(this.session.taskFailed({
                nodeId: settled.task.nodeId,
                iteration: settled.task.iteration,
                error: settled.error,
            }));
        if (isEngineDecision(report)) {
            return report;
        }
        if (typeof this.session.getNextDecision === "function") {
            return this.runEffect(this.session.getNextDecision());
        }
        throw new Error("WorkflowSession did not provide the next EngineDecision.");
    }
    /**
   * Await every in-flight task without reporting further decisions. Used
   * before run-level exits (failure, continue-as-new) so task executors are
   * not abandoned mid-write. This matches the pre-#267 barrier semantics:
   * failure reporting waits for in-flight siblings (bounded by their
   * timeouts), trading latency for the invariant that no executor writes
   * after the run is terminal. Fail-fast would need a per-run abort threaded
   * through executors.
   */
    async drainInflight() {
        while (this.inflightTasks.size > 0) {
            await Promise.allSettled([...this.inflightTasks.values()]);
        }
        this.settledTasks.length = 0;
    }
    /**
   * @param {WaitReason} reason
   * @returns {Promise<EngineDecision | RunResult>}
   */
    async handleWait(reason) {
        if (this.inflightTasks.size > 0 || this.settledTasks.length > 0) {
            // Work is still in flight — consume the next completion instead of
            // suspending the run. Deadline-style waits keep their deadline so a
            // retry backoff or timer elsewhere in the graph still fires on time.
            const timerGap = reason._tag === "Timer" ? reason.resumeAtMs - Date.now() : 0;
            const deadlineMs = reason._tag === "RetryBackoff"
                ? Math.max(0, reason.waitMs)
                : reason._tag === "Timer"
                    ? // An already-elapsed absolute timer would yield a 0ms deadline that
                      // resolves immediately, busy-spinning until a sibling completes. Block
                      // purely on the in-flight promises instead so a real completion drives
                      // the next decision.
                      timerGap > 0 ? timerGap : null
                    : null;
            return this.nextCompletionDecision(deadlineMs);
        }
        if (this.onWait) {
            return this.onWait(reason, {
                runId: this.activeRunId,
                options: this.activeOptions ?? { input: {} },
            });
        }
        switch (reason._tag) {
            case "Approval":
                return { runId: this.activeRunId, status: "waiting-approval" };
            case "Event":
            case "ExternalTrigger":
            case "HotReload":
            case "OrphanRecovery":
                return { runId: this.activeRunId, status: "waiting-event" };
            case "Timer":
                return { runId: this.activeRunId, status: "waiting-timer" };
            case "Quota":
                return { runId: this.activeRunId, status: "waiting-quota" };
            case "RetryBackoff": {
                try {
                    await sleepWithAbort(reason.waitMs, this.activeOptions?.signal);
                }
                catch (error) {
                    if (!this.activeOptions?.signal?.aborted || !isAbortError(error)) {
                        throw error;
                    }
                }
                if (this.activeOptions?.signal?.aborted) {
                    return this.cancelRun();
                }
                if (this.session && typeof this.session.getNextDecision === "function") {
                    return this.runEffect(this.session.getNextDecision());
                }
                if (this.session && this.lastGraph) {
                    return this.runEffect(this.session.submitGraph(this.lastGraph));
                }
                return { runId: this.activeRunId, status: "waiting-timer" };
            }
        }
    }
    /**
   * @param {unknown} transition
   * @returns {Promise<RunResult>}
   */
    async continueAsNew(transition) {
        if (this.continueAsNewHandler) {
            return this.continueAsNewHandler(transition, {
                runId: this.activeRunId,
                options: this.activeOptions ?? { input: {} },
            });
        }
        return {
            runId: this.activeRunId,
            status: "continued",
            output: transition,
        };
    }
    /**
   * @returns {Promise<RunResult>}
   */
    async cancelRun() {
        if (this.session && typeof this.session.cancelRequested === "function") {
            const result = await this.runEffect(this.session.cancelRequested());
            if (isRunResult(result))
                return result;
            if (isEngineDecision(result)) {
                if (result._tag === "Finished")
                    return result.result;
                if (result._tag === "Failed") {
                    return {
                        runId: this.activeRunId,
                        status: "failed",
                        error: result.error,
                    };
                }
            }
        }
        return { runId: this.activeRunId, status: "cancelled" };
    }
    /**
   * @template A
   * @param {unknown} effect
   * @returns {Promise<A>}
   */
    runEffect(effect) {
        return this.runtime.runPromise(effect);
    }
}
