import { Effect, Metric } from "effect";
import { buildOutputRow, stripAutoColumns, validateOutput } from "@smthrs/db/output";
import { makeAbortError, wireAbortSignal } from "./bridge-utils.js";
import { logDebug, logError, logInfo } from "@smthrs/observability/logging";
import { attemptDuration, nodeDuration } from "@smthrs/observability/metrics";
import { errorToJson } from "@smthrs/errors/errorToJson";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { nowMs } from "@smthrs/scheduler/nowMs";
import { getJjPointer } from "@smthrs/vcs/jj";
import { buildOutputValidationDiagnostics } from "../output-validation-diagnostics.js";
import { getPlatformLayer } from "../platform-layer.js";
import { isThenablePayload, makeThenablePayloadError } from "../thenable-payload.js";
import { stampDurableRetryState } from "./retry-state.js";
/** @typedef {import("@smthrs/db/adapter").SmithersDb} _SmithersDb */
/**
 * @typedef {{ rootDir: string; }} StaticTaskBridgeToolConfig
 */
/** @typedef {import("@smthrs/graph/TaskDescriptor").TaskDescriptor} _TaskDescriptor */

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isAbortError(err) {
  if (!err) return false;
  if (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError") {
    return true;
  }
  if (err.name === "AbortError") return true;
  if (err instanceof Error) {
    return /aborted|abort/i.test(err.message);
  }
  return false;
}
/**
 * @param {_TaskDescriptor} desc
 * @param {boolean} cacheEnabled
 * @returns {boolean}
 */
export const canExecuteBridgeManagedStaticTask = (desc, cacheEnabled) => {
  if (desc.sideEffect) {
    return false;
  }
  if (cacheEnabled || desc.cachePolicy) {
    return false;
  }
  if (desc.agent || desc.computeFn || desc.staticPayload === undefined) {
    return false;
  }
  if (desc.worktreePath) {
    return false;
  }
  return !desc.scorers || Object.keys(desc.scorers).length === 0;
};
/**
 * @param {_SmithersDb} adapter
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 * @param {EventBus} eventBus
 * @param {StaticTaskBridgeToolConfig} toolConfig
 * @param {string} workflowName
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export const executeStaticTaskBridge = async (adapter, runId, desc, eventBus, toolConfig, workflowName, signal) => {
  const taskStartMs = performance.now();
  const attempts = await Effect.runPromise(adapter.listAttempts(runId, desc.nodeId, desc.iteration));
  const attemptNo = (attempts[0]?.attempt ?? 0) + 1;
  const taskAbortController = new AbortController();
  const removeAbortForwarder = wireAbortSignal(taskAbortController, signal);
  const taskSignal = taskAbortController.signal;
  const startedAtMs = nowMs();
  const executionOwnerId = (await Effect.runPromise(adapter.getRun(runId)))?.runtimeOwnerId ?? null;
  const attemptMeta = {
    kind: "static",
    prompt: desc.prompt ?? null,
    staticPayload: desc.staticPayload ?? null,
    label: desc.label ?? null,
    outputTable: desc.outputTableName,
    needsApproval: desc.needsApproval,
    retries: desc.retries,
    timeoutMs: desc.timeoutMs,
    heartbeatTimeoutMs: desc.heartbeatTimeoutMs,
    lastHeartbeat: null,
    agentId: null,
    agentModel: null,
    agentEngine: null,
    agentResume: null,
    agentConversation: null,
    resumedFromSession: null,
    resumedFromConversation: false,
    hijackHandoff: null,
  };
  await adapter.withTransaction(
    "task-start",
    Effect.gen(function* () {
      yield* adapter.insertAttempt({
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        state: "in-progress",
        startedAtMs,
        finishedAtMs: null,
        heartbeatAtMs: null,
        heartbeatDataJson: null,
        errorJson: null,
        jjPointer: null,
        jjCwd: toolConfig.rootDir,
        cached: false,
        metaJson: JSON.stringify(attemptMeta),
      });
      yield* adapter.insertNode({
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        state: "in-progress",
        lastAttempt: attemptNo,
        updatedAtMs: nowMs(),
        outputTable: desc.outputTableName,
        label: desc.label ?? null,
      });
    }),
  );
  await Effect.runPromise(
    eventBus.emitEventWithPersist({
      type: "NodeStarted",
      runId,
      nodeId: desc.nodeId,
      iteration: desc.iteration,
      attempt: attemptNo,
      timestampMs: nowMs(),
    }),
  );
  try {
    if (taskSignal.aborted) {
      throw taskSignal.reason ?? makeAbortError();
    }
    logDebug(
      "bridge-managed static task execution starting",
      {
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        workflowName,
      },
      "engine:task",
    );
    if (isThenablePayload(desc.staticPayload)) {
      attemptMeta.failureRetryable = false;
      throw makeThenablePayloadError(desc, { attempt: attemptNo });
    }
    let payload = stripAutoColumns(desc.staticPayload);
    const payloadWithKeys = buildOutputRow(desc.outputTable, runId, desc.nodeId, desc.iteration, payload);
    let validation = validateOutput(desc.outputTable, payloadWithKeys);
    if (validation.ok && desc.outputSchema) {
      const zodResult = desc.outputSchema.safeParse(payload);
      if (!zodResult.success) {
        validation = { ok: false, error: zodResult.error };
      }
    }
    if (!validation.ok) {
      attemptMeta.failureRetryable = false;
      const diagnostics = buildOutputValidationDiagnostics(validation.error, payload);
      throw new SmithersError(
        "INVALID_OUTPUT",
        `Task output failed validation for ${desc.outputTableName}: ${diagnostics.summary}`,
        {
          attempt: attemptNo,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          outputTable: desc.outputTableName,
          issues: validation.error?.issues,
          receivedKeys: diagnostics.receivedKeys,
          receivedDescription: diagnostics.receivedDescription,
        },
        { cause: validation.error },
      );
    }
    payload = validation.data;
    const completedAtMs = nowMs();
    const jjPointer = await Effect.runPromise(
      getJjPointer(toolConfig.rootDir).pipe(Effect.provide(getPlatformLayer())),
    );
    if (taskSignal.aborted) {
      throw taskSignal.reason ?? makeAbortError();
    }
    const completionClaimed = await adapter.withTransaction(
      "task-completion",
      Effect.gen(function* () {
        const claimed = yield* adapter.claimAttemptCompletion(
          runId,
          desc.nodeId,
          desc.iteration,
          attemptNo,
          executionOwnerId,
          completedAtMs,
        );
        if (!claimed) return false;
        yield* adapter.upsertOutputRow(
          desc.outputTable,
          { runId, nodeId: desc.nodeId, iteration: desc.iteration },
          payload,
        );
        yield* adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
          state: "finished",
          finishedAtMs: completedAtMs,
          jjPointer,
          cached: false,
          metaJson: JSON.stringify(attemptMeta),
          responseText: null,
        });
        yield* adapter.insertNode({
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          state: "finished",
          lastAttempt: attemptNo,
          updatedAtMs: completedAtMs,
          outputTable: desc.outputTableName,
          label: desc.label ?? null,
        });
        return true;
      }),
    );
    if (!completionClaimed) return;
    await Effect.runPromise(
      eventBus.emitEventWithPersist({
        type: "NodeFinished",
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        timestampMs: nowMs(),
      }),
    );
    const taskElapsedMs = performance.now() - taskStartMs;
    void Effect.runPromise(
      Effect.all([Metric.update(nodeDuration, taskElapsedMs), Metric.update(attemptDuration, taskElapsedMs)], {
        discard: true,
      }),
    );
    logInfo(
      "bridge-managed static task execution finished",
      {
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        durationMs: Math.round(taskElapsedMs),
        jjPointer,
      },
      "engine:task",
    );
  } catch (err) {
    const aborted = taskSignal.aborted || isAbortError(err);
    const effectiveError =
      aborted && taskSignal.reason !== undefined ? taskSignal.reason : aborted ? makeAbortError() : err;
    if (aborted) {
      const cancelledAtMs = nowMs();
      const cancellationClaimed = await adapter.withTransaction(
        "task-cancel",
        Effect.gen(function* () {
          const claimed = yield* adapter.claimAttemptTerminal(
            runId,
            desc.nodeId,
            desc.iteration,
            attemptNo,
            executionOwnerId,
            "cancelled",
            cancelledAtMs,
            JSON.stringify(errorToJson(effectiveError)),
          );
          if (!claimed) return false;
          yield* adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
            metaJson: JSON.stringify(attemptMeta),
            responseText: null,
          });
          yield* adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "cancelled",
            lastAttempt: attemptNo,
            updatedAtMs: cancelledAtMs,
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
          });
          return true;
        }),
      );
      if (!cancellationClaimed) return;
      await Effect.runPromise(
        eventBus.emitEventWithPersist({
          type: "NodeCancelled",
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          reason: "aborted",
          timestampMs: nowMs(),
        }),
      );
      logInfo(
        "bridge-managed static task execution cancelled",
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          error: effectiveError instanceof Error ? effectiveError.message : String(effectiveError),
        },
        "engine:task",
      );
      return;
    }
    logError(
      "bridge-managed static task execution failed",
      {
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        maxAttempts: Number.isFinite(desc.retries) ? desc.retries + 1 : "infinite",
        error: effectiveError instanceof Error ? effectiveError.message : String(effectiveError),
      },
      "engine:task",
    );
    const failedAtMs = nowMs();
    const failureErrorJson = errorToJson(effectiveError);
    stampDurableRetryState({
      attemptMeta,
      attempts,
      descriptor: desc,
      error: failureErrorJson,
      failedAtMs,
    });
    const failureClaimed = await adapter.withTransaction(
      "task-fail",
      Effect.gen(function* () {
        const claimed = yield* adapter.claimAttemptTerminal(
          runId,
          desc.nodeId,
          desc.iteration,
          attemptNo,
          executionOwnerId,
          "failed",
          failedAtMs,
          JSON.stringify(failureErrorJson),
        );
        if (!claimed) return false;
        yield* adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
          metaJson: JSON.stringify(attemptMeta),
          responseText: null,
        });
        yield* adapter.insertNode({
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          state: "failed",
          lastAttempt: attemptNo,
          updatedAtMs: failedAtMs,
          outputTable: desc.outputTableName,
          label: desc.label ?? null,
        });
        return true;
      }),
    );
    if (!failureClaimed) return;
    /** @type {any} */ (toolConfig).reportError?.(effectiveError, {
      phase: "node",
      runId,
      nodeId: desc.nodeId,
      iteration: desc.iteration,
      attempt: attemptNo,
    });
    await Effect.runPromise(
      eventBus.emitEventWithPersist({
        type: "NodeFailed",
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        error: errorToJson(effectiveError),
        timestampMs: nowMs(),
      }),
    );
    const updatedAttempts = await Effect.runPromise(adapter.listAttempts(runId, desc.nodeId, desc.iteration));
    const failedAttempts = updatedAttempts.filter((attempt) => attempt.state === "failed");
    if (attemptMeta.failureRetryable !== false && failedAttempts.length <= desc.retries) {
      await Effect.runPromise(
        eventBus.emitEventWithPersist({
          type: "NodeRetrying",
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo + 1,
          timestampMs: nowMs(),
        }),
      );
    }
  } finally {
    removeAbortForwarder();
  }
};

export const __staticTaskBridgeInternals = {
  isAbortError,
};
