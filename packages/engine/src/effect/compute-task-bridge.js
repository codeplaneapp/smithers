import { Cause, Duration, Effect, Exit, Metric, Result, Schedule } from "effect";
import { buildOutputRow, stripAutoColumns, validateOutput } from "@smthrs/db/output";
import { TaskHeartbeatTimeout } from "@smthrs/errors/TaskHeartbeatTimeout";
import { TaskTimeout } from "@smthrs/errors/TaskTimeout";
import { makeAbortError, wireAbortSignal } from "./bridge-utils.js";
import { withTaskRuntime } from "@smthrs/driver/task-runtime";
import { getSubflowChildRunId } from "../task-compute-fns.js";
import { logDebug, logError, logInfo, logWarning } from "@smthrs/observability/logging";
import { attemptDuration, nodeDuration } from "@smthrs/observability/metrics";
import { errorToJson } from "@smthrs/errors/errorToJson";
import { fromTaggedError } from "@smthrs/errors/fromTaggedError";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { nowMs } from "@smthrs/scheduler/nowMs";
import { getJjPointer } from "@smthrs/vcs/jj";
import { buildOutputValidationDiagnostics } from "../output-validation-diagnostics.js";
import { getPlatformLayer } from "../platform-layer.js";
import { sleep } from "../sleep.js";
import { createHash } from "node:crypto";
import { runWithToolContext } from "@smthrs/tool-context";
import { createToolJournalContext } from "../createToolJournalContext.js";
import { stampDurableRetryState } from "./retry-state.js";
/**
 * @typedef {{ rootDir: string; }} ComputeTaskBridgeToolConfig
 */
/** @typedef {import("@smthrs/db/adapter").SmithersDb} _SmithersDb */
/** @typedef {import("@smthrs/graph/TaskDescriptor").TaskDescriptor} _TaskDescriptor */
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase<Record<string, unknown>>} _BunSQLiteDatabase */

// Floor between heartbeat DB writes so a hot heartbeat() loop cannot hammer
// sqlite; enforced in flushHeartbeat.
const TASK_HEARTBEAT_THROTTLE_MS = 500;
// Hard cap on a serialized heartbeat payload; exceeding it throws
// HEARTBEAT_PAYLOAD_TOO_LARGE into the compute callback and marks the attempt
// non-retryable.
const TASK_HEARTBEAT_MAX_PAYLOAD_BYTES = 1_000_000;
// Watchdog poll cadence: the lower bound on how quickly a heartbeatTimeoutMs
// breach is detected.
const TASK_HEARTBEAT_TIMEOUT_CHECK_MS = 250;
// Give abort-aware in-process tools a short window to persist their terminal
// journal update before the compute attempt is detached.
const TOOL_ABORT_GRACE_MS = 250;
/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isAbortError(err) {
  if (!err) return false;
  if (err instanceof SmithersError && err.code === "TASK_ABORTED") return true;
  if (err && typeof err === "object" && err.code === "TASK_ABORTED") {
    return true;
  }
  if (fromTaggedError(err)?.code === "TASK_ABORTED") return true;
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
 * @param {string | null} [heartbeatDataJson]
 * @returns {unknown | null}
 */
function parseAttemptHeartbeatData(heartbeatDataJson) {
  if (typeof heartbeatDataJson !== "string" || heartbeatDataJson.length === 0) {
    return null;
  }
  try {
    return JSON.parse(heartbeatDataJson);
  } catch {
    return null;
  }
}
/**
 * @param {unknown} value
 * @param {string} path
 * @param {Set<unknown>} seen
 */
function validateHeartbeatValue(value, path, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SmithersError(
        "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
        `Heartbeat payload must contain only finite numbers (invalid at ${path}).`,
        { path, value },
      );
    }
    return;
  }
  if (value === undefined) {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
      `Heartbeat payload cannot include undefined values (invalid at ${path}).`,
      { path },
    );
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
      `Heartbeat payload contains a non-JSON value (invalid at ${path}).`,
      { path, valueType: typeof value },
    );
  }
  if (seen.has(value)) {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
      "Heartbeat payload cannot contain circular references.",
      { path },
    );
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      validateHeartbeatValue(value[i], `${path}[${i}]`, seen);
    }
    seen.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !(value instanceof Date)) {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
      "Heartbeat payload must contain plain JSON objects.",
      { path },
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    validateHeartbeatValue(entry, `${path}.${key}`, seen);
  }
  seen.delete(value);
}
/**
 * @param {unknown} data
 * @returns {{ heartbeatDataJson: string; dataSizeBytes: number; }}
 */
function serializeHeartbeatPayload(data) {
  validateHeartbeatValue(data, "$", new Set());
  const heartbeatDataJson = JSON.stringify(data);
  const dataSizeBytes = Buffer.byteLength(heartbeatDataJson, "utf8");
  if (dataSizeBytes > TASK_HEARTBEAT_MAX_PAYLOAD_BYTES) {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_TOO_LARGE",
      `Heartbeat payload exceeds ${TASK_HEARTBEAT_MAX_PAYLOAD_BYTES} bytes.`,
      {
        dataSizeBytes,
        maxBytes: TASK_HEARTBEAT_MAX_PAYLOAD_BYTES,
      },
    );
  }
  return { heartbeatDataJson, dataSizeBytes };
}
/**
 * @param {AbortSignal | undefined} signal
 * @param {unknown} err
 * @returns {unknown | null}
 */
function heartbeatTimeoutReasonFromAbort(signal, err) {
  const reason = signal?.aborted ? signal.reason : undefined;
  const candidate = reason ?? err;
  if (
    candidate instanceof TaskHeartbeatTimeout ||
    (candidate instanceof SmithersError && candidate.code === "TASK_HEARTBEAT_TIMEOUT")
  ) {
    return candidate;
  }
  const taggedCandidate = fromTaggedError(candidate);
  if (taggedCandidate?.code === "TASK_HEARTBEAT_TIMEOUT") {
    return taggedCandidate;
  }
  if (candidate && typeof candidate === "object" && candidate.code === "TASK_HEARTBEAT_TIMEOUT") {
    return new SmithersError(
      "TASK_HEARTBEAT_TIMEOUT",
      String(candidate.message ?? "Task heartbeat timed out."),
      candidate.details,
      { cause: candidate },
    );
  }
  return null;
}
/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isHeartbeatPayloadValidationError(err) {
  if (err instanceof SmithersError) {
    return err.code === "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE" || err.code === "HEARTBEAT_PAYLOAD_TOO_LARGE";
  }
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = err.code;
  return code === "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE" || code === "HEARTBEAT_PAYLOAD_TOO_LARGE";
}
/**
 * @param {AbortController} controller
 * @param {AbortSignal} signal
 * @returns {() => void}
 */
function linkEffectAbortSignal(controller, signal) {
  const forwardAbort = () => {
    controller.abort(signal.reason ?? makeAbortError());
  };
  if (signal.aborted) {
    forwardAbort();
  } else {
    signal.addEventListener("abort", forwardAbort, { once: true });
  }
  return () => {
    signal.removeEventListener("abort", forwardAbort);
  };
}
/**
 * @param {_TaskDescriptor} desc
 * @param {boolean} cacheEnabled
 * @returns {boolean}
 */
export const canExecuteBridgeManagedComputeTask = (desc, cacheEnabled) => {
  if (desc.sideEffect) {
    return false;
  }
  if (cacheEnabled || desc.cachePolicy) {
    return false;
  }
  if (desc.agent || !desc.computeFn) {
    return false;
  }
  if (desc.worktreePath) {
    return false;
  }
  return !desc.scorers || Object.keys(desc.scorers).length === 0;
};

/**
 * @param {number} taskIteration
 * @param {number} attempt
 * @returns {number}
 */
function distinctReplayUnsafeApprovalIteration(taskIteration, attempt) {
  const iterationPart = Number.isSafeInteger(taskIteration) && taskIteration >= 0 ? taskIteration : 0;
  const attemptPart = Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0;
  const sum = iterationPart + attemptPart;
  return -((sum * (sum + 1)) / 2 + attemptPart + 1);
}
/**
 * @param {string | null | undefined} value
 * @returns {Record<string, unknown> | null}
 */
function parseJsonRecord(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
/**
 * @param {Record<string, unknown> | undefined} approval
 * @param {{ runId: string; nodeId: string; iteration: number; fingerprint: string; authorizedAttempt: number }} expected
 * @returns {boolean}
 */
function replayUnsafeApprovalCovers(approval, expected) {
  if (!approval || (approval.status !== "approved" && approval.status !== "denied")) {
    return false;
  }
  const request = parseJsonRecord(approval.requestJson);
  const decision = parseJsonRecord(approval.decisionJson);
  const approved = approval.status === "approved";
  return (
    request?.kind === "ReplayUnsafeApproval" &&
    request.runId === expected.runId &&
    request.nodeId === expected.nodeId &&
    request.iteration === expected.iteration &&
    request.fingerprint === expected.fingerprint &&
    decision?.kind === "ReplayUnsafeApproval" &&
    decision.approved === approved &&
    decision.fingerprint === expected.fingerprint &&
    decision.authorizedAttempt === request.authorizedAttempt &&
    (!approved || request.authorizedAttempt === expected.authorizedAttempt)
  );
}
/**
 * @param {Record<string, unknown> | undefined} approval
 * @param {{ runId: string; nodeId: string; iteration: number; fingerprint?: string }} expected
 * @returns {boolean}
 */
function isReplayUnsafeApprovalFor(approval, expected) {
  const request = parseJsonRecord(approval?.requestJson);
  return (
    request?.kind === "ReplayUnsafeApproval" &&
    request.runId === expected.runId &&
    request.nodeId === expected.nodeId &&
    request.iteration === expected.iteration &&
    (expected.fingerprint === undefined || request.fingerprint === expected.fingerprint)
  );
}

async function guardReplayUnsafeCompute(adapter, eventBus, runId, desc, attemptNo, attemptMeta) {
  if (attemptNo <= 1) return false;
  const priorCalls = await Effect.runPromise(adapter.listToolCalls(runId, desc.nodeId, desc.iteration));
  const offending = priorCalls
    .filter((call) => Number(call.attempt) < attemptNo)
    .filter((call) => call.sideEffect === true && call.idempotent === false && call.acceptsIdempotencyKey !== true)
    .map((call) => ({
      kind: call.kind === "task" ? "task" : "tool",
      toolName: String(call.toolName ?? ""),
      attempt: Number(call.attempt),
      seq: Number(call.seq),
      hasRevert: call.hasRevert === true,
    }))
    .sort(
      (left, right) =>
        left.toolName.localeCompare(right.toolName) || left.attempt - right.attempt || left.seq - right.seq,
    );
  if (offending.length === 0) return false;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(offending.map((call) => [call.toolName, call.attempt, call.seq])))
    .digest("hex");
  const approvalTarget = {
    runId,
    nodeId: desc.nodeId,
    iteration: desc.iteration,
    fingerprint,
    authorizedAttempt: attemptNo,
  };
  const existing = await Effect.runPromise(adapter.getApproval(runId, desc.nodeId, desc.iteration));
  const decidedApprovals = await Effect.runPromise(adapter.listAllDecidedApprovals(runId));
  const coveringApproval = [existing, ...decidedApprovals].find(
    (approval, index, rows) =>
      approval &&
      rows.findIndex(
        (candidate) => candidate?.nodeId === approval.nodeId && candidate?.iteration === approval.iteration,
      ) === index &&
      replayUnsafeApprovalCovers(approval, approvalTarget),
  );
  if (coveringApproval?.status === "denied") {
    throw new SmithersError("INVALID_INPUT", `Replay of task ${desc.nodeId} was denied.`, {
      nodeId: desc.nodeId,
      iteration: desc.iteration,
      attempt: attemptNo,
      fingerprint,
      failureRetryable: false,
    });
  }
  if (coveringApproval?.status === "approved") {
    attemptMeta.replayUnsafeApproval = {
      status: "approved",
      fingerprint,
      authorizedAttempt: attemptNo,
    };
    return false;
  }
  const requestedAtMs = nowMs();
  const authorizedAttempt = attemptNo + 1;
  const pendingApprovals = await Effect.runPromise(adapter.listPendingApprovals(runId));
  const existingPendingApproval = pendingApprovals.find((approval) =>
    isReplayUnsafeApprovalFor(approval, {
      runId,
      nodeId: desc.nodeId,
      iteration: desc.iteration,
      fingerprint,
    }),
  );
  const initialApprovalIteration =
    existingPendingApproval?.iteration ??
    (!existing || existing.status === "requested"
      ? desc.iteration
      : distinctReplayUnsafeApprovalIteration(desc.iteration, attemptNo));
  const request = await adapter.withTransaction(
    "compute-replay-unsafe-approval",
    Effect.gen(function* () {
      let approvalIteration = initialApprovalIteration;
      let approvalAtIteration = yield* adapter.getApproval(runId, desc.nodeId, approvalIteration);
      while (approvalAtIteration && approvalAtIteration.status !== "requested") {
        approvalIteration -= 1;
        approvalAtIteration = yield* adapter.getApproval(runId, desc.nodeId, approvalIteration);
      }
      const persistedRequest = {
        kind: "ReplayUnsafeApproval",
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        approvalIteration,
        attempt: attemptNo,
        authorizedAttempt,
        fingerprint,
        offending,
        prompt:
          "Replay would re-execute non-idempotent side effects without a usable idempotency key. Registered revert handlers do not make forward replay safe.",
      };
      yield* adapter.insertOrUpdateApproval({
        runId,
        nodeId: desc.nodeId,
        iteration: approvalIteration,
        status: "requested",
        requestedAtMs,
        decidedAtMs: null,
        note: null,
        decidedBy: null,
        requestJson: JSON.stringify(persistedRequest),
        decisionJson: null,
        autoApproved: false,
      });
      yield* adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
        state: "waiting-approval",
        metaJson: JSON.stringify({ ...attemptMeta, replayUnsafeToolCalls: offending }),
      });
      yield* adapter.insertNode({
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        state: "waiting-approval",
        lastAttempt: attemptNo,
        updatedAtMs: requestedAtMs,
        outputTable: desc.outputTableName,
        label: desc.label ?? null,
      });
      yield* adapter.updateRunIfNotCancelled(runId, {
        status: "waiting-approval",
        heartbeatAtMs: null,
        runtimeOwnerId: null,
      });
      return persistedRequest;
    }),
  );
  await Effect.runPromise(
    eventBus.emitEventWithPersist({
      type: "ApprovalRequested",
      runId,
      nodeId: desc.nodeId,
      iteration: request.approvalIteration,
      request,
      timestampMs: requestedAtMs,
    }),
  );
  await Effect.runPromise(
    eventBus.emitEventWithPersist({
      type: "NodeWaitingApproval",
      runId,
      nodeId: desc.nodeId,
      iteration: desc.iteration,
      attempt: attemptNo,
      timestampMs: requestedAtMs,
    }),
  );
  return true;
}
/**
 * @param {_SmithersDb} adapter
 * @param {_BunSQLiteDatabase} db
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 * @param {EventBus} eventBus
 * @param {ComputeTaskBridgeToolConfig} toolConfig
 * @param {string} workflowName
 * @param {AbortSignal} [signal]
 * @param {AbortSignal} [pauseSignal]
 * @returns {Promise<void>}
 */
export const executeComputeTaskBridge = async (
  adapter,
  db,
  runId,
  desc,
  eventBus,
  toolConfig,
  workflowName,
  signal,
  pauseSignal,
) => {
  const taskStartMs = performance.now();
  const attempts = await Effect.runPromise(adapter.listAttempts(runId, desc.nodeId, desc.iteration));
  const previousHeartbeat = (() => {
    for (const attempt of attempts) {
      const parsed = parseAttemptHeartbeatData(attempt.heartbeatDataJson);
      if (parsed !== null) return parsed;
    }
    return null;
  })();
  const attemptNo = (attempts[0]?.attempt ?? 0) + 1;
  const taskAbortController = new AbortController();
  const removeAbortForwarder = wireAbortSignal(taskAbortController, signal);
  const taskSignal = taskAbortController.signal;
  const startedAtMs = nowMs();
  const executionOwnerId = (await Effect.runPromise(adapter.getRun(runId)))?.runtimeOwnerId ?? null;
  let taskCompleted = false;
  let taskExecutionReturned = false;
  let heartbeatClosed = false;
  let heartbeatWriteInFlight = false;
  let heartbeatPendingDataJson = previousHeartbeat === null ? null : JSON.stringify(previousHeartbeat);
  let heartbeatPendingDataSizeBytes =
    heartbeatPendingDataJson === null ? 0 : Buffer.byteLength(heartbeatPendingDataJson, "utf8");
  let heartbeatPendingAtMs = startedAtMs;
  let heartbeatEvidenceAtMs = startedAtMs;
  let heartbeatTimeoutWon = false;
  let heartbeatHasPendingWrite = false;
  let heartbeatLastPersistedWriteAtMs = 0;
  let heartbeatLastReceivedAtMs = null;
  let heartbeatWriteTimer;
  /**
   * @returns {Promise<void>}
   */
  const flushHeartbeat = async (force = false) => {
    if (heartbeatClosed || !heartbeatHasPendingWrite || heartbeatWriteInFlight) {
      return;
    }
    const now = nowMs();
    const heartbeatThrottleMs = desc.heartbeatTimeoutMs
      ? Math.min(TASK_HEARTBEAT_THROTTLE_MS, Math.max(0, Math.floor(desc.heartbeatTimeoutMs / 3)))
      : TASK_HEARTBEAT_THROTTLE_MS;
    const minNextWriteAt = heartbeatLastPersistedWriteAtMs + heartbeatThrottleMs;
    if (!force && now < minNextWriteAt) {
      const waitMs = Math.max(0, minNextWriteAt - now);
      if (!heartbeatWriteTimer) {
        heartbeatWriteTimer = setTimeout(() => {
          heartbeatWriteTimer = undefined;
          void flushHeartbeat();
        }, waitMs);
      }
      return;
    }
    heartbeatHasPendingWrite = false;
    heartbeatWriteInFlight = true;
    const heartbeatAtMs = heartbeatPendingAtMs;
    const heartbeatDataJson = heartbeatPendingDataJson;
    const dataSizeBytes = heartbeatPendingDataSizeBytes;
    const intervalMs =
      heartbeatLastReceivedAtMs == null ? null : Math.max(0, heartbeatAtMs - heartbeatLastReceivedAtMs);
    heartbeatLastReceivedAtMs = heartbeatAtMs;
    try {
      const persisted = await Effect.runPromise(
        adapter.heartbeatAttempt(
          runId,
          desc.nodeId,
          desc.iteration,
          attemptNo,
          heartbeatAtMs,
          heartbeatDataJson,
          executionOwnerId,
        ),
      );
      if (!persisted) {
        heartbeatHasPendingWrite = false;
        heartbeatEvidenceAtMs = Math.max(startedAtMs, heartbeatLastPersistedWriteAtMs);
        return;
      }
      heartbeatEvidenceAtMs = heartbeatAtMs;
      heartbeatLastPersistedWriteAtMs = nowMs();
      logDebug(
        "bridge-managed compute task heartbeat recorded",
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          dataSizeBytes,
        },
        "heartbeat:record",
      );
      await eventBus.emitEventQueued({
        type: "TaskHeartbeat",
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        hasData: heartbeatDataJson !== null,
        dataSizeBytes,
        intervalMs: intervalMs ?? undefined,
        timestampMs: heartbeatAtMs,
      });
    } catch (error) {
      logWarning(
        "failed to persist bridge-managed compute task heartbeat",
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          error: error instanceof Error ? error.message : String(error),
        },
        "heartbeat:record",
      );
    } finally {
      heartbeatWriteInFlight = false;
      if (heartbeatHasPendingWrite && !heartbeatClosed) {
        void flushHeartbeat();
      }
    }
  };
  /**
   * @param {unknown} data
   */
  const queueHeartbeat = (data) => {
    if (taskCompleted || heartbeatClosed || taskExecutionReturned) {
      return;
    }
    const heartbeatAtMs = nowMs();
    let nextHeartbeatDataJson = heartbeatPendingDataJson;
    let dataSizeBytes = heartbeatPendingDataSizeBytes;
    if (data !== undefined) {
      const serialized = serializeHeartbeatPayload(data);
      nextHeartbeatDataJson = serialized.heartbeatDataJson;
      dataSizeBytes = serialized.dataSizeBytes;
    }
    heartbeatPendingAtMs = heartbeatAtMs;
    heartbeatPendingDataJson = nextHeartbeatDataJson;
    heartbeatPendingDataSizeBytes = dataSizeBytes;
    heartbeatHasPendingWrite = true;
    if (!heartbeatWriteTimer) {
      void flushHeartbeat();
    }
  };
  const waitForHeartbeatWriteDrain = async () => {
    while (heartbeatWriteInFlight) {
      await sleep(5);
    }
  };
  /**
   * @template A
   * @param {Effect.Effect<A, unknown>} taskEffect
   * @returns {Promise<A>}
   */
  const runWithHeartbeatWatchdog = async (taskEffect) => {
    /**
     * @param {Effect.Effect<A, unknown>} effect
     */
    const runTaskEffect = async (effect) => {
      const exit = await Effect.runPromiseExit(effect, {
        signal: taskSignal,
      });
      if (Exit.isSuccess(exit)) {
        return exit.value;
      }
      throw Cause.squash(exit.cause);
    };
    const heartbeatTimeoutMs = desc.heartbeatTimeoutMs;
    if (!heartbeatTimeoutMs) {
      return await runTaskEffect(taskEffect);
    }
    const checkHeartbeat = Effect.suspend(() => {
      const lastHeartbeatAtMs = Math.max(startedAtMs, heartbeatEvidenceAtMs);
      const staleForMs = nowMs() - lastHeartbeatAtMs;
      if (staleForMs <= heartbeatTimeoutMs) {
        return Effect.void;
      }
      const timeoutError = new TaskHeartbeatTimeout({
        message: `Task ${desc.nodeId} has not heartbeated in ${staleForMs}ms (timeout: ${heartbeatTimeoutMs}ms).`,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        timeoutMs: heartbeatTimeoutMs,
        staleForMs,
        lastHeartbeatAtMs,
      });
      logWarning(
        "bridge-managed compute task heartbeat timed out",
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          timeoutMs: heartbeatTimeoutMs,
          staleForMs,
          lastHeartbeatAtMs,
        },
        "heartbeat:timeout",
      );
      void eventBus.emitEventQueued({
        type: "TaskHeartbeatTimeout",
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        lastHeartbeatAtMs,
        timeoutMs: heartbeatTimeoutMs,
        timestampMs: nowMs(),
      });
      heartbeatTimeoutWon = true;
      taskAbortController.abort(timeoutError);
      return Effect.fail(timeoutError);
    });
    const watchdog = Effect.repeat(
      checkHeartbeat,
      Schedule.spaced(Duration.millis(TASK_HEARTBEAT_TIMEOUT_CHECK_MS)),
    ).pipe(Effect.flatMap(() => Effect.never));
    const raced = await Effect.runPromise(Effect.race(Effect.result(taskEffect), Effect.result(watchdog)), {
      signal: taskSignal,
    });
    if (Result.isFailure(raced)) {
      throw raced.failure;
    }
    return raced.success;
  };
  const attemptMeta = {
    kind: "compute",
    prompt: desc.prompt ?? null,
    staticPayload: desc.staticPayload ?? null,
    label: desc.label ?? null,
    outputTable: desc.outputTableName,
    needsApproval: desc.needsApproval,
    retries: desc.retries,
    timeoutMs: desc.timeoutMs,
    heartbeatTimeoutMs: desc.heartbeatTimeoutMs,
    lastHeartbeat: previousHeartbeat,
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
      ...(getSubflowChildRunId(desc, runId) ? { childRunId: getSubflowChildRunId(desc, runId) } : {}),
      timestampMs: nowMs(),
    }),
  );
  let computeToolContext;
  let computeAbortController;
  let removeTaskToolAbortForwarder;
  try {
    if (taskSignal.aborted || heartbeatTimeoutWon) {
      throw taskSignal.reason ?? makeAbortError();
    }
    logDebug(
      "bridge-managed compute task execution starting",
      {
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        workflowName,
        taskRoot: toolConfig.rootDir,
      },
      "engine:task",
    );
    if (await guardReplayUnsafeCompute(adapter, eventBus, runId, desc, attemptNo, attemptMeta)) {
      return;
    }
    computeAbortController = new AbortController();
    removeTaskToolAbortForwarder = wireAbortSignal(computeAbortController, taskSignal);
    computeToolContext = createToolJournalContext({
      adapter,
      eventBus,
      runId,
      nodeId: desc.nodeId,
      iteration: desc.iteration,
      attempt: attemptNo,
      rootDir: toolConfig.rootDir,
      abortSignal: computeAbortController.signal,
    });
    let computeEffect = Effect.tryPromise({
      try: (effectSignal) => {
        const removeEffectAbortForwarder = linkEffectAbortSignal(computeAbortController, effectSignal);
        return Promise.resolve()
          .then(() =>
            withTaskRuntime(
              {
                runId,
                stepId: desc.nodeId,
                attempt: attemptNo,
                iteration: desc.iteration,
                rootDir: toolConfig.rootDir,
                signal: computeAbortController.signal,
                pauseSignal,
                db,
                heartbeat: (data) => {
                  queueHeartbeat(data);
                },
                lastHeartbeat: previousHeartbeat,
              },
              () => runWithToolContext(computeToolContext, () => desc.computeFn()),
            ),
          )
          .finally(() => {
            removeEffectAbortForwarder();
          });
      },
      catch: (error) => error,
    });
    const timeoutMs = desc.timeoutMs;
    if (timeoutMs) {
      computeEffect = computeEffect.pipe(
        Effect.timeout(Duration.millis(timeoutMs)),
        Effect.catchIf(Cause.isTimeoutError, () =>
          Effect.fail(
            new TaskTimeout({
              message: `Compute callback timed out after ${timeoutMs}ms`,
              attempt: attemptNo,
              nodeId: desc.nodeId,
              timeoutMs,
            }),
          ),
        ),
      );
    }
    let payload = await runWithHeartbeatWatchdog(computeEffect);
    await computeToolContext.waitForPendingToolCalls(TOOL_ABORT_GRACE_MS);
    payload = stripAutoColumns(payload);
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
    if (desc.heartbeatTimeoutMs && nowMs() - heartbeatEvidenceAtMs > desc.heartbeatTimeoutMs) {
      heartbeatTimeoutWon = true;
      throw new SmithersError(
        "TASK_HEARTBEAT_TIMEOUT",
        `Task ${desc.nodeId} exceeded its heartbeat timeout before completion.`,
        {
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          timeoutMs: desc.heartbeatTimeoutMs,
        },
      );
    }
    taskExecutionReturned = true;
    await Effect.runPromise(eventBus.flush());
    const jjPointer = await Effect.runPromise(
      getJjPointer(toolConfig.rootDir).pipe(Effect.provide(getPlatformLayer())),
    );
    await waitForHeartbeatWriteDrain();
    await flushHeartbeat(true);
    // Timeout/abort is a terminal contender; a late resolved Promise is
    // not allowed to commit output after it has won.
    if (taskSignal.aborted) {
      throw taskSignal.reason ?? makeAbortError();
    }
    taskCompleted = true;
    const completedAtMs = nowMs();
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
        if (!claimed) {
          return false;
        }
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
    if (!completionClaimed) {
      return;
    }
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
      "bridge-managed compute task execution finished",
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
    try {
      await Effect.runPromise(eventBus.flush());
    } catch (flushError) {
      logError(
        "failed to flush queued bridge-managed compute task events",
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          error: flushError instanceof Error ? flushError.message : String(flushError),
        },
        "engine:task-events",
      );
    }
    const heartbeatTimeoutError = heartbeatTimeoutReasonFromAbort(taskSignal, err);
    const aborted = !heartbeatTimeoutError && (taskSignal.aborted || isAbortError(err));
    const effectiveError =
      heartbeatTimeoutError ??
      (aborted && taskSignal.reason !== undefined ? taskSignal.reason : aborted ? makeAbortError() : err);
    if (computeAbortController && !computeAbortController.signal.aborted) {
      computeAbortController.abort(effectiveError);
    }
    if (computeToolContext) {
      await computeToolContext.waitForPendingToolCalls(TOOL_ABORT_GRACE_MS);
    }
    if (isHeartbeatPayloadValidationError(effectiveError)) {
      attemptMeta.failureRetryable = false;
    }
    // An authored retryability decision is authoritative. In its absence,
    // deterministic configuration errors keep their fail-fast default.
    const explicitRetryability = effectiveError?.details?.failureRetryable;
    if (explicitRetryability === false || explicitRetryability === true) {
      attemptMeta.failureRetryable = explicitRetryability;
    } else if (effectiveError?.code === "AGENT_CONFIG_INVALID") {
      attemptMeta.failureRetryable = false;
    }
    const suspensionStatus =
      effectiveError?.details && typeof effectiveError.details.suspensionStatus === "string"
        ? effectiveError.details.suspensionStatus
        : null;
    if (
      suspensionStatus === "waiting-approval" ||
      suspensionStatus === "waiting-event" ||
      suspensionStatus === "waiting-timer" ||
      suspensionStatus === "waiting-quota" ||
      suspensionStatus === "paused"
    ) {
      await waitForHeartbeatWriteDrain();
      await flushHeartbeat(true);
      taskCompleted = true;
      const taskState = suspensionStatus === "paused" ? "waiting-event" : suspensionStatus;
      const suspendedAtMs = nowMs();
      await adapter.withTransaction(
        "task-suspend",
        Effect.gen(function* () {
          yield* adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
            state: taskState,
            errorJson: JSON.stringify(errorToJson(effectiveError)),
            metaJson: JSON.stringify(attemptMeta),
            responseText: null,
          });
          yield* adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: taskState,
            lastAttempt: attemptNo,
            updatedAtMs: suspendedAtMs,
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
          });
        }),
      );
      if (taskState === "waiting-approval") {
        await Effect.runPromise(
          eventBus.emitEventWithPersist({
            type: "NodeWaitingApproval",
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            attempt: attemptNo,
            timestampMs: suspendedAtMs,
          }),
        );
      }
      throw effectiveError;
    }
    if (aborted) {
      const currentAttempt = await Effect.runPromise(adapter.getAttempt(runId, desc.nodeId, desc.iteration, attemptNo));
      if (currentAttempt?.state === "cancelled") return;
      await waitForHeartbeatWriteDrain();
      await flushHeartbeat(true);
      taskCompleted = true;
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
          if (computeToolContext) {
            yield* computeToolContext.failPendingToolCallsEffect(effectiveError, cancelledAtMs, {
              inTransaction: true,
            });
          }
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
        "bridge-managed compute task execution cancelled",
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
    const currentAttempt = await Effect.runPromise(adapter.getAttempt(runId, desc.nodeId, desc.iteration, attemptNo));
    if (currentAttempt?.state === "cancelled") return;
    await waitForHeartbeatWriteDrain();
    await flushHeartbeat(true);
    taskCompleted = true;
    logError(
      "bridge-managed compute task execution failed",
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
        if (computeToolContext) {
          yield* computeToolContext.failPendingToolCallsEffect(effectiveError, failedAtMs, { inTransaction: true });
        }
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
    taskCompleted = true;
    heartbeatClosed = true;
    if (heartbeatWriteTimer) {
      clearTimeout(heartbeatWriteTimer);
      heartbeatWriteTimer = undefined;
    }
    if (removeTaskToolAbortForwarder) {
      removeTaskToolAbortForwarder();
    }
    removeAbortForwarder();
  }
};

export const __computeTaskBridgeInternals = {
  TASK_HEARTBEAT_MAX_PAYLOAD_BYTES,
  TASK_HEARTBEAT_THROTTLE_MS,
  TASK_HEARTBEAT_TIMEOUT_CHECK_MS,
  TOOL_ABORT_GRACE_MS,
  heartbeatTimeoutReasonFromAbort,
  isAbortError,
  isHeartbeatPayloadValidationError,
  linkEffectAbortSignal,
  parseAttemptHeartbeatData,
  serializeHeartbeatPayload,
  validateHeartbeatValue,
};
