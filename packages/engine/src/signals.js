import { Effect } from "effect";
import { bridgeSignalResolve } from "./effect/durable-deferred-bridge.js";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { normalizeWaitForEventCorrelationId } from "@smithers-orchestrator/db/waitForEventAttempt";
/** @typedef {import("./SignalRunOptions.ts").SignalRunOptions} SignalRunOptions */

/**
 * @param {string} signalName
 * @returns {string}
 */
function normalizeSignalName(signalName) {
  const normalized = signalName.trim();
  if (!normalized) {
    throw new SmithersError("INVALID_INPUT", "Signal name must be a non-empty string.", { signalName });
  }
  return normalized;
}
/**
 * @param {unknown} payload
 * @returns {string}
 */
function serializeSignalPayload(payload) {
  try {
    const payloadJson = JSON.stringify(payload ?? null);
    if (payloadJson === undefined) {
      throw new Error("Signal payload serialized to undefined.");
    }
    return payloadJson;
  } catch (error) {
    throw new SmithersError("INVALID_INPUT", "Signal payload must be valid JSON-serializable data.", undefined, {
      cause: error,
    });
  }
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} signalName
 * @param {unknown} payload
 * @param {SignalRunOptions} [options]
 * @returns {Effect.Effect<{ runId: string; seq: number; signalName: string; correlationId: string | null; receivedAtMs: number }, SmithersError, never>}
 */
export function signalRun(adapter, runId, signalName, payload, options = {}) {
  const normalizedSignalName = normalizeSignalName(signalName);
  const normalizedCorrelationId = normalizeWaitForEventCorrelationId(options.correlationId);
  const payloadJson = serializeSignalPayload(payload);
  const receivedAtMs = options.timestampMs ?? nowMs();
  return Effect.gen(function* () {
    const run = yield* adapter.getRun(runId);
    if (!run) {
      throw new SmithersError("RUN_NOT_FOUND", `Run not found: ${runId}`, {
        runId,
      });
    }
    const seq = yield* adapter.insertSignalWithNextSeq({
      runId,
      signalName: normalizedSignalName,
      correlationId: normalizedCorrelationId,
      payloadJson,
      receivedAtMs,
      receivedBy: options.receivedBy ?? null,
    });
    const delivered = {
      runId,
      seq,
      signalName: normalizedSignalName,
      correlationId: normalizedCorrelationId,
      receivedAtMs,
    };
    const descendants =
      typeof adapter.listRunDescendants === "function"
        ? yield* adapter.listRunDescendants(runId)
        : [{ runId, parentRunId: run.parentRunId ?? null, depth: 0 }];
    for (const target of descendants) {
      const targetRunId = target.runId;
      if (targetRunId !== runId) {
        const targetRun = yield* adapter.getRun(targetRunId);
        if (!targetRun || ["finished", "continued", "failed", "cancelled"].includes(targetRun.status)) {
          continue;
        }
      }
      const targetSeq =
        targetRunId === runId
          ? delivered.seq
          : yield* adapter.insertSignalWithNextSeq({
              runId: targetRunId,
              signalName: normalizedSignalName,
              correlationId: normalizedCorrelationId,
              payloadJson,
              receivedAtMs,
              receivedBy: options.receivedBy ?? null,
            });
      yield* Effect.promise(() =>
        bridgeSignalResolve(adapter, targetRunId, {
          signalName: delivered.signalName,
          correlationId: normalizedCorrelationId,
          payloadJson,
          seq: targetSeq,
          receivedAtMs: delivered.receivedAtMs,
        }),
      );
    }
    return delivered;
  }).pipe(
    Effect.annotateLogs({
      runId,
      signalName: normalizedSignalName,
      correlationId: normalizedCorrelationId,
    }),
    Effect.withLogSpan("signal:send"),
  );
}
