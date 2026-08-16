/**
 * Engine ↔ Effect seam adapter.
 *
 * This file establishes the interface boundaries for bridging the Smithers engine
 * with the Effect ecosystem. `executeTaskBridge` delegates to the engine's task
 * execution; the Effect-native `Activity.make()` path now lives alongside it (see
 * `activity-bridge.js`). Further engine boundaries are modeled as Workflows over time.
 */
import { Effect } from "effect";
import { toSmithersError } from "@smthrs/errors/toSmithersError";
import { isRetryableFailure } from "@smthrs/scheduler";
import { makeWorkerTask } from "./entity-worker.js";
import { executeTaskActivity, makeTaskBridgeKey, RetriableTaskFailure } from "./activity-bridge.js";
import { parseAttemptMetaJson } from "./bridge-utils.js";
import { isDiscardedSessionAttempt } from "./isDiscardedSessionAttempt.js";
import { canExecuteBridgeManagedComputeTask, executeComputeTaskBridge } from "./compute-task-bridge.js";
import { canExecuteBridgeManagedStaticTask, executeStaticTaskBridge } from "./static-task-bridge.js";
import { dispatchWorkerTask } from "./single-runner.js";
/** @typedef {import("../HijackState.ts").HijackState} HijackState */
/** @typedef {import("./LegacyExecuteTaskFn.ts").LegacyExecuteTaskFn} LegacyExecuteTaskFn */
/** @typedef {import("./TaskBridgeToolConfig.ts").TaskBridgeToolConfig} TaskBridgeToolConfig */
/** @typedef {import("@smthrs/graph/TaskDescriptor").TaskDescriptor} _TaskDescriptor */
/** @typedef {import("./TaskActivityContext.ts").TaskActivityContext} _TaskActivityContext */
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase<Record<string, unknown>>} _BunSQLiteDatabase */
/** @typedef {import("drizzle-orm/sqlite-core").SQLiteTable} SQLiteTable */
/**
 * @typedef {"compute" | "static" | "legacy"} BridgeManagedTaskKind
 */

export {
  bridgeApprovalResolve,
  bridgeSignalResolve,
  bridgeWaitForEventResolve,
  awaitApprovalDurableDeferred,
  awaitWaitForEventDurableDeferred,
  makeApprovalDurableDeferred,
  makeDurableDeferredBridgeExecutionId,
  makeWaitForEventDurableDeferred,
} from "./durable-deferred-bridge.js";
export {
  cancelPendingTimersBridge,
  isBridgeManagedTimerTask,
  isBridgeManagedWaitForEventTask,
  resolveDeferredTaskStateBridge,
} from "./deferred-state-bridge.js";
export {
  createSchedulerWakeQueue,
  getWorkflowMakeBridgeRuntime,
  runWorkflowWithMakeBridge,
  withWorkflowMakeBridgeRuntime,
} from "./workflow-make-bridge.js";
export {
  SqlMessageStorage,
  ensureSqlMessageStorage,
  ensureSqlMessageStorageEffect,
  getSqlMessageStorage,
} from "./sql-message-storage.js";
export {
  SandboxEntity,
  SandboxEntityExecutor,
  makeSandboxEntityId,
  makeSandboxTransportServiceEffect,
} from "@smthrs/sandbox/effect/sandbox-entity";
export { CodeplaneSandboxExecutorLive, DockerSandboxExecutorLive, SandboxHttpRunner } from "./http-runner.js";
export { BubblewrapSandboxExecutorLive, SandboxSocketRunner } from "@smthrs/sandbox/effect/socket-runner";
export {
  isTaskResultFailure,
  makeWorkerTask,
  TaskResult,
  WorkerDispatchKind,
  WorkerTask,
  WorkerTaskKind,
  TaskWorkerEntity,
} from "./entity-worker.js";
export {
  closeSingleRunnerRuntime,
  dispatchWorkerTask,
  reopenSingleRunnerRuntime,
  subscribeTaskWorkerDispatches,
} from "./single-runner.js";
// Dedupe caches keyed by bridgeKey. Completed executions are kept only until the
// end of the current macrotask (see the setTimeout(..., 0) eviction in
// `executeTaskBridge`): duplicate dispatches of the same bridgeKey issued in the
// same tick coalesce onto one promise, while later re-dispatches (retries)
// re-execute.
const inflightTaskExecutions = new Map();
const completedTaskExecutions = new Map();
/**
 * @template A
 * @param {Effect.Effect<A, unknown, never> | PromiseLike<A> | A} value
 * @returns {Promise<A>}
 */
const runEffectOrPromise = async (value) => {
  if (Effect.isEffect?.(value)) {
    return Effect.runPromise(value);
  }
  return await value;
};
/**
 * @param {string | null} [errorJson]
 * @returns {string | null}
 */
function parseAttemptErrorCode(errorJson) {
  if (!errorJson) return null;
  try {
    const parsed = JSON.parse(errorJson);
    return typeof parsed?.code === "string" ? parsed.code : null;
  } catch {
    return null;
  }
}
/**
 * @param {{ errorJson?: string | null; metaJson?: string | null } | null} [attempt]
 * @param {{ agent?: unknown; retryPolicy?: unknown }} [descriptor] task descriptor when known; lets the
 * verdict include the author's `retryPolicy.retryable` gate
 */
function isRetryableBridgeTaskFailure(attempt, descriptor) {
  const meta = parseAttemptMetaJson(attempt?.metaJson);
  if (meta?.failureRetryable === false) {
    return false;
  }
  if (meta?.failureRetryable === true) {
    return true;
  }
  const kind = typeof meta?.kind === "string" ? meta.kind : null;
  // Mirror the scheduler's retry/terminal verdict (#1500) from the persisted
  // attempt row: terminal failure shapes (ENOENT preconditions, hard size
  // caps) and the author's retryPolicy.retryable gate must read identically
  // here, or a bridge-managed task would be retried over a failure the
  // scheduler already declared terminal.
  const error = (() => {
    const errorJson = attempt?.errorJson;
    if (typeof errorJson !== "string" || errorJson.length === 0) return null;
    try {
      const parsed = JSON.parse(errorJson);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  })();
  if (error) {
    return isRetryableFailure(
      {
        agent: descriptor?.agent ?? (kind === "agent" ? true : undefined),
        retryPolicy: descriptor?.retryPolicy,
      },
      error,
    );
  }
  const errorCode = parseAttemptErrorCode(attempt?.errorJson);
  if (errorCode === "AGENT_CONFIG_INVALID") {
    return false;
  }
  // INVALID_OUTPUT is only retryable for agent tasks.
  if (kind !== "agent" && errorCode === "INVALID_OUTPUT") {
    return false;
  }
  return true;
}
/**
 * A quota-limited attempt never consumes the retry budget: the engine either
 * fails the task over to the next agent in its chain or parks the run until the
 * provider resets. Either way the task must stay dispatchable — a terminal
 * classification here would cache the failed attempt's result under the bridge
 * key and the next dispatch would replay it instead of re-executing the task.
 * @param {{ errorJson?: string | null; metaJson?: string | null } | null} [attempt]
 */
function isQuotaBridgeTaskFailure(attempt) {
  if (parseAttemptErrorCode(attempt?.errorJson) === "AGENT_QUOTA_EXCEEDED") {
    return true;
  }
  if (attempt?.errorJson) {
    try {
      if (JSON.parse(attempt.errorJson)?.details?.failureQuota === true) {
        return true;
      }
    } catch {
      /* ignore parse errors */
    }
  }
  return parseAttemptMetaJson(attempt?.metaJson)?.failureQuota === true;
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 * @param {_TaskActivityContext} context
 */
const classifyTaskAttempt = async (adapter, runId, desc, context) => {
  const attempts = await runEffectOrPromise(adapter.listAttempts(runId, desc.nodeId, desc.iteration));
  const latest = attempts[0];
  const latestAttempt = latest?.attempt ?? context.attempt;
  const latestState = latest?.state ?? null;
  if (latestState === "failed") {
    const failedAttempts = attempts.filter((attempt) => attempt.state === "failed");
    const hasNonRetryableFailure = failedAttempts.some((attempt) => !isRetryableBridgeTaskFailure(attempt, desc));
    const retryConsumingFailures = failedAttempts.filter(
      (attempt) => !isQuotaBridgeTaskFailure(attempt) && !isDiscardedSessionAttempt(attempt),
    );
    if (
      !hasNonRetryableFailure &&
      (isQuotaBridgeTaskFailure(latest) || retryConsumingFailures.length <= desc.retries)
    ) {
      throw new RetriableTaskFailure(desc.nodeId, latestAttempt);
    }
  }
  return {
    state: latestState,
    attempt: latestAttempt,
    idempotencyKey: context.idempotencyKey,
  };
};
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 */
const getNextTaskActivityAttempt = async (adapter, runId, desc) => {
  const attempts = await runEffectOrPromise(adapter.listAttempts(runId, desc.nodeId, desc.iteration));
  const latestAttempt = attempts[0]?.attempt ?? 0;
  return latestAttempt + 1;
};
/**
 * Converts a RetriableTaskFailure into a non-terminal bridge result; rethrows every other error.
 *
 * @param {unknown} error
 * @returns {{ terminal: false }}
 */
function taskBridgeResultForError(error) {
  if (error instanceof RetriableTaskFailure) {
    return { terminal: false };
  }
  throw error;
}
/**
 * @param {SmithersDb} adapter
 * @param {_BunSQLiteDatabase} db
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 * @param {Map<string, _TaskDescriptor>} descriptorMap
 * @param {SQLiteTable} inputTable
 * @param {EventBus} eventBus
 * @param {TaskBridgeToolConfig} toolConfig
 * @param {string} workflowName
 * @param {boolean} cacheEnabled
 * @param {BridgeManagedTaskKind} bridgeManagedExecution
 * @param {_TaskActivityContext} context
 * @param {AbortSignal} [signal]
 * @param {Set<string>} [disabledAgents]
 * @param {AbortController} [runAbortController]
 * @param {HijackState} [hijackState]
 * @param {LegacyExecuteTaskFn} [legacyExecuteTaskFn]
 * @param {AbortSignal} [pauseSignal]
 */
const executeBridgeAttempt = async (
  adapter,
  db,
  runId,
  desc,
  descriptorMap,
  inputTable,
  eventBus,
  toolConfig,
  workflowName,
  cacheEnabled,
  bridgeManagedExecution,
  context,
  signal,
  disabledAgents,
  runAbortController,
  hijackState,
  legacyExecuteTaskFn,
  pauseSignal,
) => {
  if (bridgeManagedExecution === "static") {
    await executeStaticTaskBridge(adapter, runId, desc, eventBus, toolConfig, workflowName, signal);
  } else if (bridgeManagedExecution === "compute") {
    await executeComputeTaskBridge(adapter, db, runId, desc, eventBus, toolConfig, workflowName, signal, pauseSignal);
  } else {
    await legacyExecuteTaskFn(
      adapter,
      db,
      runId,
      desc,
      descriptorMap,
      inputTable,
      eventBus,
      toolConfig,
      workflowName,
      cacheEnabled,
      signal,
      disabledAgents,
      runAbortController,
      hijackState,
      pauseSignal,
    );
  }
  return classifyTaskAttempt(adapter, runId, desc, context);
};
/**
 * @param {SmithersDb} adapter
 * @param {_BunSQLiteDatabase} db
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 * @param {Map<string, _TaskDescriptor>} descriptorMap
 * @param {SQLiteTable} inputTable
 * @param {EventBus} eventBus
 * @param {TaskBridgeToolConfig} toolConfig
 * @param {string} workflowName
 * @param {boolean} cacheEnabled
 * @param {BridgeManagedTaskKind} bridgeManagedExecution
 * @param {string} bridgeKey
 * @param {AbortSignal} [signal]
 * @param {Set<string>} [disabledAgents]
 * @param {AbortController} [runAbortController]
 * @param {HijackState} [hijackState]
 * @param {LegacyExecuteTaskFn} [legacyExecuteTaskFn]
 * @param {AbortSignal} [pauseSignal]
 */
const runTaskBridgeExecution = async (
  adapter,
  db,
  runId,
  desc,
  descriptorMap,
  inputTable,
  eventBus,
  toolConfig,
  workflowName,
  cacheEnabled,
  bridgeManagedExecution,
  bridgeKey,
  signal,
  disabledAgents,
  runAbortController,
  hijackState,
  legacyExecuteTaskFn,
  pauseSignal,
) => {
  const initialAttempt = await getNextTaskActivityAttempt(adapter, runId, desc);
  return dispatchWorkerTask(makeWorkerTask(bridgeKey, workflowName, runId, desc, bridgeManagedExecution), async () => {
    try {
      await executeTaskActivity(
        adapter,
        workflowName,
        runId,
        desc,
        (context) =>
          executeBridgeAttempt(
            adapter,
            db,
            runId,
            desc,
            descriptorMap,
            inputTable,
            eventBus,
            toolConfig,
            workflowName,
            cacheEnabled,
            bridgeManagedExecution,
            context,
            signal,
            disabledAgents,
            runAbortController,
            hijackState,
            legacyExecuteTaskFn,
            pauseSignal,
          ),
        {
          initialAttempt,
          retry: false,
        },
      );
      return { terminal: true };
    } catch (error) {
      return taskBridgeResultForError(error);
    }
  });
};
/**
 * @param {SmithersDb} adapter
 * @param {_BunSQLiteDatabase} db
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 * @param {Map<string, _TaskDescriptor>} descriptorMap
 * @param {SQLiteTable} inputTable
 * @param {EventBus} eventBus
 * @param {TaskBridgeToolConfig} toolConfig
 * @param {string} workflowName
 * @param {boolean} cacheEnabled
 * @param {AbortSignal} [signal]
 * @param {Set<string>} [disabledAgents]
 * @param {AbortController} [runAbortController]
 * @param {HijackState} [hijackState]
 * @param {LegacyExecuteTaskFn} [legacyExecuteTaskFn]
 * @param {AbortSignal} [pauseSignal]
 * @returns {Promise<void>}
 */
export const executeTaskBridge = (
  adapter,
  db,
  runId,
  desc,
  descriptorMap,
  inputTable,
  eventBus,
  toolConfig,
  workflowName,
  cacheEnabled,
  signal,
  disabledAgents,
  runAbortController,
  hijackState,
  legacyExecuteTaskFn,
  pauseSignal,
) => {
  const bridgeManagedExecution = canExecuteBridgeManagedComputeTask(desc, cacheEnabled)
    ? "compute"
    : canExecuteBridgeManagedStaticTask(desc, cacheEnabled)
      ? "static"
      : "legacy";
  if (bridgeManagedExecution === "legacy" && typeof legacyExecuteTaskFn !== "function") {
    return Promise.reject(new TypeError("legacyExecuteTaskFn must be provided"));
  }
  const bridgeKey = makeTaskBridgeKey(adapter, workflowName, runId, desc);
  const completed = completedTaskExecutions.get(bridgeKey);
  if (completed) {
    return completed;
  }
  const existing = inflightTaskExecutions.get(bridgeKey);
  if (existing) {
    return existing;
  }
  const execution = runTaskBridgeExecution(
    adapter,
    db,
    runId,
    desc,
    descriptorMap,
    inputTable,
    eventBus,
    toolConfig,
    workflowName,
    cacheEnabled,
    bridgeManagedExecution,
    bridgeKey,
    signal,
    disabledAgents,
    runAbortController,
    hijackState,
    legacyExecuteTaskFn,
    pauseSignal,
  )
    .then((result) => {
      if (!result.terminal) {
        return undefined;
      }
      completedTaskExecutions.set(bridgeKey, execution);
      setTimeout(() => {
        if (completedTaskExecutions.get(bridgeKey) === execution) {
          completedTaskExecutions.delete(bridgeKey);
        }
      }, 0);
      return undefined;
    })
    .finally(() => {
      if (inflightTaskExecutions.get(bridgeKey) === execution) {
        inflightTaskExecutions.delete(bridgeKey);
      }
    });
  inflightTaskExecutions.set(bridgeKey, execution);
  return execution;
};
/**
 * @param {SmithersDb} adapter
 * @param {_BunSQLiteDatabase} db
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 * @param {Map<string, _TaskDescriptor>} descriptorMap
 * @param {SQLiteTable} inputTable
 * @param {EventBus} eventBus
 * @param {TaskBridgeToolConfig} toolConfig
 * @param {string} workflowName
 * @param {boolean} cacheEnabled
 * @param {AbortSignal} [signal]
 * @param {Set<string>} [disabledAgents]
 * @param {AbortController} [runAbortController]
 * @param {HijackState} [hijackState]
 * @param {LegacyExecuteTaskFn} [legacyExecuteTaskFn]
 * @param {AbortSignal} [pauseSignal]
 * @returns {Effect.Effect<void, import("@smthrs/errors/SmithersError").SmithersError, never>}
 */
export const executeTaskBridgeEffect = (
  adapter,
  db,
  runId,
  desc,
  descriptorMap,
  inputTable,
  eventBus,
  toolConfig,
  workflowName,
  cacheEnabled,
  signal,
  disabledAgents,
  runAbortController,
  hijackState,
  legacyExecuteTaskFn,
  pauseSignal,
) =>
  Effect.tryPromise({
    try: () =>
      executeTaskBridge(
        adapter,
        db,
        runId,
        desc,
        descriptorMap,
        inputTable,
        eventBus,
        toolConfig,
        workflowName,
        cacheEnabled,
        signal,
        disabledAgents,
        runAbortController,
        hijackState,
        legacyExecuteTaskFn,
        pauseSignal,
      ),
    catch: (cause) => toSmithersError(cause, "execute task bridge"),
  });
export const __workflowBridgeInternals = {
  classifyTaskAttempt,
  getNextTaskActivityAttempt,
  isRetryableBridgeTaskFailure,
  parseAttemptErrorCode,
  runEffectOrPromise,
  taskBridgeResultForError,
};
