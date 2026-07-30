import * as MessageStorage from "effect/unstable/cluster/MessageStorage";
import * as RunnerHealth from "effect/unstable/cluster/RunnerHealth";
import * as Runners from "effect/unstable/cluster/Runners";
import * as RunnerStorage from "effect/unstable/cluster/RunnerStorage";
import * as Sharding from "effect/unstable/cluster/Sharding";
import * as ShardingConfig from "effect/unstable/cluster/ShardingConfig";
import * as SingleRunner from "effect/unstable/cluster/SingleRunner";
import { Effect, Layer, ManagedRuntime } from "effect";
import { fromTaggedErrorPayload } from "@smithers-orchestrator/errors/fromTaggedErrorPayload";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { toTaggedErrorPayload } from "@smithers-orchestrator/errors/toTaggedErrorPayload";
import { isUnknownWorkerError, isTaskResultFailure, TaskWorkerEntity } from "./entity-worker.js";
/**
 * @typedef {(task: WorkerTask) => void} TaskWorkerDispatchSubscriber
 */
/**
 * @typedef {{ terminal: boolean; }} WorkerExecutionResult
 */
/**
 * @typedef {{ client: any; context: any; dispose?: () => Promise<void>; }} SingleRunnerRuntime
 */
/**
 * @typedef {"idle" | "opening" | "open" | "closing" | "closed"} SingleRunnerState
 */
/** @typedef {import("./WorkerTask.ts").WorkerTask} WorkerTask */
/** @typedef {import("./TaskResult.ts").TaskResult} TaskResult */
/** @typedef {import("./TaskFailure.ts").TaskFailure} TaskFailure */
/** @typedef {import("./WorkerTaskError.ts").WorkerTaskError} WorkerTaskError */

// @effect/sql-sqlite-bun statically imports bun:sqlite, which breaks module
// load under plain Node (serverless hosts). buildSingleRunnerRuntime -- the
// only user -- is async and runs only when a worker task is first dispatched,
// so load the client lazily via a memoized dynamic import. Under Bun this
// resolves the exact same ESM module the old static import did.
/** @type {Promise<typeof import("@effect/sql-sqlite-bun/SqliteClient")> | undefined} */
let sqliteClientModulePromise;
function loadSqliteClient() {
  return (sqliteClientModulePromise ??= import("@effect/sql-sqlite-bun/SqliteClient"));
}
const workerExecutions = new Map();
const workerErrors = new Map();
const dispatchSubscribers = new Set();
let singleRunnerRuntimePromise;
/**
 * Lifecycle of the process-local SingleRunner runtime:
 *
 *   idle -> opening -> open -> closing -> closed -> (reopen) -> idle
 *
 * Every transition out of a usable state is made SYNCHRONOUSLY, before any
 * await, so a close can never interleave with a dispatch or a run that has
 * already passed the fence.
 * @type {SingleRunnerState}
 */
let singleRunnerState = "idle";
/**
 * The one close promise shared by every concurrent caller. Retained after a
 * successful or failed close so repeat calls settle identically; cleared by a
 * busy rejection (so a later close can retry) and by an explicit reopen.
 * @type {Promise<void> | undefined}
 */
let singleRunnerClosePromise;
/**
 * Live `runWorkflow` calls. A run lease spans validation, every task attempt,
 * driver retry backoff between attempts, and cleanup. `workerExecutions` is
 * empty during backoff, so this is the only thing that stops a close from
 * tearing the runtime out from under a mid-flight run.
 * @type {Map<string, string>}
 */
const activeRunLeases = new Map();
/**
 * Live `dispatchWorkerTask` calls, acquired before the first await so a close
 * cannot observe an empty lease set while a dispatch is still on its way to
 * the runtime.
 * @type {Map<string, string>}
 */
const activeDispatchLeases = new Map();
let singleRunnerLeaseCounter = 0;
const SHUTDOWN_DOC_URL = "https://smithers.sh/runtime/shutdown";
/**
 * @returns {{ state: SingleRunnerState; runIds: string[]; executionIds: string[]; } | undefined}
 */
function describeActiveLeases() {
  if (activeRunLeases.size === 0 && activeDispatchLeases.size === 0) {
    return undefined;
  }
  return {
    state: singleRunnerState,
    runIds: [...new Set(activeRunLeases.values())],
    executionIds: [...new Set(activeDispatchLeases.values())],
  };
}
/**
 * Fence new work once a close has been committed to. Throws synchronously so
 * callers never queue behind a teardown and the runtime is never implicitly
 * rebuilt underneath one.
 * @param {string} what
 * @returns {void}
 */
function assertSingleRunnerAcceptsWork(what) {
  if (singleRunnerState !== "closing" && singleRunnerState !== "closed") {
    return;
  }
  throw new SmithersError(
    "SINGLE_RUNNER_CLOSED",
    `The process-local SingleRunner runtime is ${singleRunnerState}, so ${what} cannot start. Call reopenSingleRunnerRuntime() to allow the runtime to be rebuilt lazily, or start this work before closing it. Shutdown ordering: ${SHUTDOWN_DOC_URL}`,
    { state: singleRunnerState, operation: what },
  );
}
/**
 * @param {Map<string, string>} leases
 * @param {string} kind
 * @param {string} id
 * @returns {() => void}
 */
function acquireSingleRunnerLease(leases, kind, id) {
  const leaseId = `${kind}:${++singleRunnerLeaseCounter}`;
  leases.set(leaseId, id);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    leases.delete(leaseId);
  };
}
/**
 * Hold the process-local SingleRunner runtime open for the entire lifetime of
 * one `runWorkflow` call. The engine acquires this next to the wake lock and
 * releases it in the same `finally`, so `closeSingleRunnerRuntime()` reports
 * the run as busy even while the driver is sleeping between retry attempts.
 * @param {string} runId
 * @returns {() => void} release
 */
export function acquireSingleRunnerRunLease(runId) {
  assertSingleRunnerAcceptsWork(`run ${runId}`);
  return acquireSingleRunnerLease(activeRunLeases, "run", runId);
}
/**
 * @param {string} executionId
 * @returns {() => void} release
 */
function acquireSingleRunnerDispatchLease(executionId) {
  assertSingleRunnerAcceptsWork(`task dispatch ${executionId}`);
  return acquireSingleRunnerLease(activeDispatchLeases, "dispatch", executionId);
}
/**
 * Tear down the process-local SingleRunner runtime so a finite program can
 * exit without `process.exit()`. The Effect Cluster stack behind task dispatch
 * forks repeating daemon fibers (shard lock refresh, shard assignment, message
 * polling, runner health) whose timers pin the event loop forever, so awaiting
 * `runWorkflow` is not by itself a lifecycle boundary.
 *
 * This is a non-async function on purpose: every concurrent caller receives the
 * identical promise object.
 *
 * - Never opened, or already closed: resolves without doing resource work, and
 *   still transitions to `closed` so a shutting-down process cannot be
 *   restarted by a stray dispatch.
 * - Open in progress: awaits the build's settlement first, so a just-built
 *   scope is never leaked.
 * - Any run or dispatch lease held: REJECTS with `SINGLE_RUNNER_BUSY` and
 *   leaves the runtime fully usable. The failed attempt is cleared, so a close
 *   issued after the work settles succeeds.
 * - Terminal by default: `closed` persists until `reopenSingleRunnerRuntime()`.
 * - If disposal itself fails the shared promise rejects for every waiter and
 *   the state stays `closed`; a partially finalized runtime is not safe to
 *   reuse, but an explicit reopen is still available.
 *
 * Smithers installs no process signal handlers. The owner pattern is: stop
 * admission, abort in-flight runs via `RunOptions.signal`, await run
 * settlement, call this, then clean up your own database/backends. See
 * https://smithers.sh/runtime/shutdown.
 * @returns {Promise<void>}
 */
export function closeSingleRunnerRuntime() {
  if (singleRunnerClosePromise) {
    return singleRunnerClosePromise;
  }
  const busy = describeActiveLeases();
  if (busy) {
    // Never force a close: the entity handler wraps task work in an
    // uninterruptible Effect.promise, so tearing the scope down here would
    // abandon live work and stall in Sharding's entityTerminationTimeout.
    const attempt = Promise.reject(
      new SmithersError(
        "SINGLE_RUNNER_BUSY",
        `The process-local SingleRunner runtime is still in use by ${busy.runIds.length} run(s) and ${busy.executionIds.length} task dispatch(es), so it was left open. Await your runWorkflow promises (or abort them via RunOptions.signal) before closing. Shutdown ordering: ${SHUTDOWN_DOC_URL}`,
        busy,
      ),
    );
    singleRunnerClosePromise = attempt;
    // Clear only this failed attempt so a later close can retry. The no-op
    // catch keeps a caller that ignores the promise from crashing the
    // process on an unhandled rejection.
    queueMicrotask(() => {
      if (singleRunnerClosePromise === attempt) {
        singleRunnerClosePromise = undefined;
      }
    });
    attempt.catch(() => {});
    return attempt;
  }
  // Fence synchronously, before any await.
  singleRunnerState = "closing";
  const pendingRuntime = singleRunnerRuntimePromise;
  const closing = (async () => {
    try {
      const runtime = pendingRuntime ? await pendingRuntime.catch(() => undefined) : undefined;
      await runtime?.dispose?.();
    } finally {
      singleRunnerRuntimePromise = undefined;
      singleRunnerState = "closed";
    }
  })();
  closing.catch(() => {});
  singleRunnerClosePromise = closing;
  return closing;
}
/**
 * Allow the lazy open path again after a completed close, for a long-lived host
 * recovering from a component-level shutdown. Nothing in Smithers calls this by
 * default; the next task dispatch rebuilds the runtime through the existing
 * lazy memo.
 *
 * No-op while the runtime is still usable (`idle`/`opening`/`open`). Throws
 * while a close is in flight: await `closeSingleRunnerRuntime()` first, then
 * reopen.
 * @returns {void}
 */
export function reopenSingleRunnerRuntime() {
  if (singleRunnerState === "closing") {
    throw new SmithersError(
      "SINGLE_RUNNER_CLOSED",
      `The process-local SingleRunner runtime is still closing. Await closeSingleRunnerRuntime() before reopening it. Shutdown ordering: ${SHUTDOWN_DOC_URL}`,
      { state: singleRunnerState, operation: "reopen" },
    );
  }
  if (singleRunnerState !== "closed") {
    return;
  }
  singleRunnerState = "idle";
  singleRunnerClosePromise = undefined;
  singleRunnerRuntimePromise = undefined;
}
/**
 * @param {WorkerTask} task
 */
function notifyDispatchSubscribers(task) {
  for (const subscriber of dispatchSubscribers) {
    try {
      subscriber(task);
    } catch {
      // Dispatch observers are best-effort and should not affect execution.
    }
  }
}
/**
 * @param {WorkerTask} task
 * @returns {Extract<TaskResult, { _tag: "Failure" }>}
 */
function buildMissingExecutionResult(task) {
  return {
    _tag: "Failure",
    executionId: task.executionId,
    error: {
      _tag: "UnknownWorkerError",
      errorId: `missing:${task.executionId}`,
      message: `No worker execution registered for ${task.executionId}`,
    },
  };
}
/**
 * @param {string} executionId
 * @param {unknown} error
 * @returns {string}
 */
function storeWorkerError(executionId, error) {
  const errorId = `${executionId}:error`;
  workerErrors.set(errorId, error);
  return errorId;
}
/**
 * @param {string} executionId
 * @param {unknown} error
 * @returns {WorkerTaskError}
 */
function toWorkerTaskError(executionId, error) {
  const taggedError = toTaggedErrorPayload(error);
  if (taggedError) {
    return taggedError;
  }
  return {
    _tag: "UnknownWorkerError",
    errorId: storeWorkerError(executionId, error),
    message: error instanceof Error ? error.message : String(error),
  };
}
/**
 * @param {TaskFailure} result
 * @returns {unknown}
 */
function consumeWorkerError(result) {
  if (!isUnknownWorkerError(result.error)) {
    return fromTaggedErrorPayload(result.error);
  }
  const error = workerErrors.get(result.error.errorId);
  workerErrors.delete(result.error.errorId);
  if (error !== undefined) {
    return error;
  }
  return new Error(result.error.message);
}
/**
 * @param {WorkerTask} task
 * @returns {Promise<TaskResult>}
 */
async function runRegisteredExecution(task) {
  const registered = workerExecutions.get(task.executionId);
  if (!registered) {
    return buildMissingExecutionResult(task);
  }
  try {
    notifyDispatchSubscribers(registered.task);
    const result = await registered.execute();
    return {
      _tag: "Success",
      executionId: task.executionId,
      terminal: result.terminal,
    };
  } catch (error) {
    return {
      _tag: "Failure",
      executionId: task.executionId,
      error: toWorkerTaskError(task.executionId, error),
    };
  } finally {
    if (workerExecutions.get(task.executionId) === registered) {
      workerExecutions.delete(task.executionId);
    }
  }
}
/**
 * The cluster layer backing the in-process task worker. Under Bun this is the
 * stock sql-backed SingleRunner.layer over an in-memory bun:sqlite database
 * (behavior unchanged). Under plain Node (serverless hosts) `bun:sqlite` does
 * not exist, so the same Sharding stack is assembled with @effect/cluster's
 * official in-memory MessageStorage driver instead. Durability is equivalent:
 * the Bun path's sqlite storage is `:memory:` — process-local and non-durable
 * — already; smithers' own durability lives in the workflow store, not here.
 * @returns {Promise<import("effect").Layer.Layer<never, unknown, never>>}
 */
async function buildRunnerLayer() {
  if (typeof Bun !== "undefined") {
    const SqliteClient = await loadSqliteClient();
    return SingleRunner.layer({ runnerStorage: "memory" }).pipe(
      Layer.provide(
        Layer.orDie(
          SqliteClient.layer({
            filename: ":memory:",
            disableWAL: true,
          }),
        ),
      ),
    );
  }
  // Mirrors SingleRunner.layer({ runnerStorage: "memory" }) with
  // SqlMessageStorage.layer swapped for MessageStorage.layerMemory.
  return Sharding.layer.pipe(
    Layer.provideMerge(Runners.layerNoop),
    Layer.provideMerge(MessageStorage.layerMemory),
    Layer.provide([RunnerStorage.layerMemory, RunnerHealth.layerNoop]),
    Layer.provide(ShardingConfig.layerFromEnv()),
  );
}
/**
 * @returns {Promise<SingleRunnerRuntime>}
 */
async function buildSingleRunnerRuntime() {
  const runnerLayer = await buildRunnerLayer();
  const layer = TaskWorkerEntity.toLayer(
    TaskWorkerEntity.of({
      execute: (request) => Effect.promise(() => runRegisteredExecution(request.payload)),
    }),
    { concurrency: "unbounded" },
  ).pipe(Layer.provideMerge(runnerLayer));
  // ManagedRuntime owns the layer's scope, so `dispose()` is the teardown
  // handle this function used to build and then drop on the floor (#1378).
  // Precedent: packages/integrations/src/core/IntegrationRuntime.js.
  const managed = ManagedRuntime.make(layer);
  const context = (await managed.runtime()).context;
  const client = await managed.runPromise(TaskWorkerEntity.client);
  return {
    client: client,
    context,
    dispose: () => managed.dispose(),
  };
}
/**
 * @returns {Promise<SingleRunnerRuntime>}
 */
async function getSingleRunnerRuntime() {
  return getSingleRunnerRuntimeFromBuilder(buildSingleRunnerRuntime);
}
/**
 * @param {() => Promise<SingleRunnerRuntime>} buildRuntime
 * @returns {Promise<SingleRunnerRuntime>}
 */
async function getSingleRunnerRuntimeFromBuilder(buildRuntime) {
  assertSingleRunnerAcceptsWork("opening the SingleRunner runtime");
  if (!singleRunnerRuntimePromise) {
    singleRunnerState = "opening";
    singleRunnerRuntimePromise = buildRuntime().then(
      (runtime) => {
        // A close that raced this build already owns the state machine; do
        // not resurrect it here.
        if (singleRunnerState === "opening") {
          singleRunnerState = "open";
        }
        return runtime;
      },
      (error) => {
        // Construction failure stays retryable, exactly as before: drop the
        // memo so the next dispatch rebuilds.
        singleRunnerRuntimePromise = undefined;
        if (singleRunnerState === "opening") {
          singleRunnerState = "idle";
        }
        throw error;
      },
    );
  }
  return singleRunnerRuntimePromise;
}
/**
 * @param {WorkerTask} task
 * @param {() => Promise<WorkerExecutionResult>} execute
 * @returns {Promise<WorkerExecutionResult>}
 */
export async function dispatchWorkerTask(task, execute) {
  // Acquired before the first await (and before the runtime is built) so a
  // concurrent close can never see an empty lease set for this dispatch.
  const releaseDispatchLease = acquireSingleRunnerDispatchLease(task.executionId);
  try {
    const runtime = await getSingleRunnerRuntime();
    const registered = {
      task,
      execute,
    };
    workerExecutions.set(task.executionId, registered);
    try {
      const result = await Effect.runPromise(
        runtime.client(task.bridgeKey).execute(task).pipe(Effect.provide(runtime.context)),
      );
      if (isTaskResultFailure(result)) {
        throw consumeWorkerError(result);
      }
      return {
        terminal: result.terminal,
      };
    } finally {
      if (workerExecutions.get(task.executionId) === registered) {
        workerExecutions.delete(task.executionId);
      }
    }
  } finally {
    releaseDispatchLease();
  }
}
/**
 * @param {TaskWorkerDispatchSubscriber} subscriber
 * @returns {() => void}
 */
export function subscribeTaskWorkerDispatches(subscriber) {
  dispatchSubscribers.add(subscriber);
  return () => {
    dispatchSubscribers.delete(subscriber);
  };
}

export const __singleRunnerInternals = {
  acquireSingleRunnerDispatchLease,
  activeDispatchLeases,
  activeRunLeases,
  buildMissingExecutionResult,
  buildSingleRunnerRuntime,
  consumeWorkerError,
  dispatchSubscribers,
  getSingleRunnerRuntimeFromBuilder,
  getSingleRunnerRuntime,
  getSingleRunnerStateForTest: () => singleRunnerState,
  getSingleRunnerClosePromiseForTest: () => singleRunnerClosePromise,
  getSingleRunnerRuntimePromiseForTest: () => singleRunnerRuntimePromise,
  resetSingleRunnerLifecycleForTest: () => {
    singleRunnerState = "idle";
    singleRunnerClosePromise = undefined;
    singleRunnerRuntimePromise = undefined;
    activeRunLeases.clear();
    activeDispatchLeases.clear();
  },
  setSingleRunnerRuntimePromiseForTest: (promise) => {
    singleRunnerRuntimePromise = promise;
    singleRunnerState = promise ? "open" : "idle";
  },
  notifyDispatchSubscribers,
  runRegisteredExecution,
  storeWorkerError,
  toWorkerTaskError,
  workerErrors,
  workerExecutions,
};
