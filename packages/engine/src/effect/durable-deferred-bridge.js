// @smithers-type-exports-begin
/** @typedef {import("./ApprovalDurableDeferredResolution.ts").ApprovalDurableDeferredResolution} ApprovalDurableDeferredResolution */
/** @typedef {import("./WaitForEventDurableDeferredResolution.ts").WaitForEventDurableDeferredResolution} WaitForEventDurableDeferredResolution */
// @smithers-type-exports-end

import * as DurableDeferred from "effect/unstable/workflow/DurableDeferred";
import { resolve as resolvePath } from "node:path";
import { Effect, Exit, Schema } from "effect";
import { updateAsyncExternalWaitPending } from "@smthrs/observability/metrics";
import {
  normalizeWaitForEventCorrelationId,
  parseWaitForEventAttemptSnapshot,
  parseWaitForEventOptionalFiniteNumber,
} from "@smthrs/db/waitForEventAttempt";
/**
 * @typedef {{ _tag: "Complete"; exit: Exit.Exit<any, any>; } | { _tag: "Pending"; }} BridgeDeferredResult
 */
/** @typedef {import("@smthrs/db/adapter").SmithersDb} _SmithersDb */
/** @typedef {import("@smthrs/db/waitForEventAttempt").WaitForEventAttemptSnapshot} WaitForEventAttemptSnapshot */
/**
 * @typedef {{ signalName: string; correlationId: string | null; payloadJson: string; seq: number; receivedAtMs: number; }} WaitForEventSignalInput
 */

const adapterNamespaces = new WeakMap();
let nextAdapterNamespace = 0;
/**
 * @param {_SmithersDb} adapter
 * @returns {string}
 */
const getAdapterNamespace = (adapter) => {
  const filename = adapter?.db?.$client?.filename;
  if (typeof filename === "string" && filename.length > 0 && filename !== ":memory:") {
    return `sqlite:${resolvePath(filename)}`;
  }
  const existing = adapterNamespaces.get(adapter);
  if (existing) {
    return existing;
  }
  const created = `adapter-${++nextAdapterNamespace}`;
  adapterNamespaces.set(adapter, created);
  return created;
};
const approvalDurableDeferredSuccessSchema = Schema.Struct({
  approved: Schema.Boolean,
  // `note` is omitted entirely when no note was provided; if a string was
  // provided, preserve it exactly (including the empty string).
  note: Schema.optional(Schema.String),
  decidedBy: Schema.NullOr(Schema.String),
  decisionJson: Schema.NullOr(Schema.String),
  autoApproved: Schema.Boolean,
});
const waitForEventDurableDeferredSuccessSchema = Schema.Struct({
  signalName: Schema.String,
  correlationId: Schema.NullOr(Schema.String),
  payloadJson: Schema.String,
  seq: Schema.Number,
  receivedAtMs: Schema.Number,
});
// The wait-for-event attempt-meta parser is shared with the db adapter's
// `findRunsAwaitingEvent` — the single implementation lives in
// `@smthrs/db/waitForEventAttempt` (imported above). Local
// aliases keep this module's exported internals stable.
const normalizeCorrelationId = normalizeWaitForEventCorrelationId;
const parseOptionalFiniteNumber = parseWaitForEventOptionalFiniteNumber;
/**
 * @param {WaitForEventAttemptSnapshot} snapshot
 * @param {WaitForEventSignalInput} signal
 * @returns {string}
 */
function buildResolvedWaitForEventMetaJson(snapshot, signal) {
  const waitForEvent =
    snapshot.meta.waitForEvent &&
    typeof snapshot.meta.waitForEvent === "object" &&
    !Array.isArray(snapshot.meta.waitForEvent)
      ? snapshot.meta.waitForEvent
      : {};
  return JSON.stringify({
    ...snapshot.meta,
    kind: typeof snapshot.meta.kind === "string" ? snapshot.meta.kind : "wait-for-event",
    waitForEvent: {
      ...waitForEvent,
      signalName: snapshot.signalName,
      correlationId: snapshot.correlationId,
      waitAsync: snapshot.waitAsync,
      resolvedSignalSeq: signal.seq,
      receivedAtMs: signal.receivedAtMs,
    },
  });
}
async function decrementAsyncEventWaitPending(updatePending = updateAsyncExternalWaitPending) {
  try {
    await Effect.runPromise(updatePending("event", -1));
  } catch {}
}
/**
 * @param {_SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {WaitForEventSignalInput} signal
 */
async function markWaitForEventResolved(adapter, runId, nodeId, iteration, signal) {
  const attempts = await Effect.runPromise(adapter.listAttempts(runId, nodeId, iteration));
  const waitingAttempt = attempts.find((attempt) => attempt.state === "waiting-event") ?? attempts[0];
  const snapshot = parseWaitForEventAttemptSnapshot(waitingAttempt?.metaJson);
  if (!waitingAttempt || !snapshot || snapshot.resolvedSignalSeq !== undefined) {
    return;
  }
  await Effect.runPromise(
    adapter.updateAttempt(runId, nodeId, iteration, waitingAttempt.attempt, {
      metaJson: buildResolvedWaitForEventMetaJson(snapshot, signal),
    }),
  );
  if (snapshot.waitAsync) {
    await decrementAsyncEventWaitPending();
  }
}
/**
 * Upper bound on cached durable-deferred resolutions. Resolutions can arrive
 * just before a run is cancelled and never be consumed, so this cap prevents
 * the module-level cache from growing without limit in a long-running gateway.
 * Exported for tests.
 * @type {number}
 */
export const DEFERRED_RESOLUTIONS_MAX = 4096;
/**
 * Insertion-ordered LRU cache of resolved durable deferreds keyed by execution
 * id. A plain `Map` preserves insertion order, so the least-recently-used
 * entry is always the first key.
 * @type {Map<string, Exit.Exit<any, any>>}
 */
const deferredResolutions = new Map();
/**
 * Stores a resolution, evicting least-recently-used entries beyond the cap.
 * @param {string} executionId
 * @param {Exit.Exit<any, any>} exit
 * @returns {void}
 */
const setDeferredResolution = (executionId, exit) => {
  deferredResolutions.delete(executionId);
  deferredResolutions.set(executionId, exit);
  while (deferredResolutions.size > DEFERRED_RESOLUTIONS_MAX) {
    const oldest = deferredResolutions.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    deferredResolutions.delete(oldest);
  }
};
/**
 * Current number of cached durable-deferred resolutions. Exported for tests.
 * @returns {number}
 */
export const deferredResolutionsSize = () => deferredResolutions.size;
/**
 * @template Success, Error
 * @param {string} executionId
 * @param {DurableDeferred.DurableDeferred<Success, Error>} _deferred
 * @returns {Promise<BridgeDeferredResult>}
 */
const awaitBridgeDeferred = async (executionId, _deferred) => {
  const exit = deferredResolutions.get(executionId);
  if (!exit) {
    return { _tag: "Pending" };
  }
  deferredResolutions.delete(executionId);
  return { _tag: "Complete", exit };
};
/**
 * @template Success, Error
 * @param {string} executionId
 * @param {DurableDeferred.DurableDeferred<Success, Error>} _deferred
 * @param {Exit.Exit<Success["Type"], Error["Type"]>} exit
 */
const resolveBridgeDeferred = async (executionId, _deferred, exit) => {
  setDeferredResolution(executionId, exit);
};
/**
 * @param {_SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @returns {string}
 */
export const makeDurableDeferredBridgeExecutionId = (adapter, runId, nodeId, iteration) =>
  ["smithers-durable-deferred-bridge", getAdapterNamespace(adapter), runId, nodeId, String(iteration)].join(":");
/**
 * @param {string} nodeId
 */
export const makeApprovalDurableDeferred = (nodeId) =>
  DurableDeferred.make(`approval:${nodeId}`, {
    success: approvalDurableDeferredSuccessSchema,
  });
/**
 * @param {string} nodeId
 */
export const makeWaitForEventDurableDeferred = (nodeId) =>
  DurableDeferred.make(`wait-for-event:${nodeId}`, {
    success: waitForEventDurableDeferredSuccessSchema,
  });
/**
 * @param {_SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 */
export const awaitApprovalDurableDeferred = (adapter, runId, nodeId, iteration) =>
  awaitBridgeDeferred(
    makeDurableDeferredBridgeExecutionId(adapter, runId, nodeId, iteration),
    makeApprovalDurableDeferred(nodeId),
  );
/**
 * @param {_SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 */
export const awaitWaitForEventDurableDeferred = (adapter, runId, nodeId, iteration) =>
  awaitBridgeDeferred(
    makeDurableDeferredBridgeExecutionId(adapter, runId, nodeId, iteration),
    makeWaitForEventDurableDeferred(nodeId),
  );
/**
 * @param {_SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {{ approved: boolean; note?: string | null; decidedBy?: string | null; decisionJson?: string | null; autoApproved?: boolean; }} resolution
 */
export const bridgeApprovalResolve = async (adapter, runId, nodeId, iteration, resolution) => {
  await resolveBridgeDeferred(
    makeDurableDeferredBridgeExecutionId(adapter, runId, nodeId, iteration),
    makeApprovalDurableDeferred(nodeId),
    Exit.succeed({
      approved: resolution.approved,
      // Only carry a `note` when a string was provided; omitting the key keeps
      // note-less decisions valid against optional string schemas.
      ...(typeof resolution.note === "string" ? { note: resolution.note } : {}),
      decidedBy: resolution.decidedBy ?? null,
      decisionJson: resolution.decisionJson ?? null,
      autoApproved: resolution.autoApproved ?? false,
    }),
  );
};
/**
 * @param {_SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {WaitForEventSignalInput} signal
 */
export const bridgeWaitForEventResolve = async (adapter, runId, nodeId, iteration, signal) => {
  await markWaitForEventResolved(adapter, runId, nodeId, iteration, signal);
  await resolveBridgeDeferred(
    makeDurableDeferredBridgeExecutionId(adapter, runId, nodeId, iteration),
    makeWaitForEventDurableDeferred(nodeId),
    Exit.succeed({
      signalName: signal.signalName,
      correlationId: normalizeCorrelationId(signal.correlationId),
      payloadJson: signal.payloadJson,
      seq: signal.seq,
      receivedAtMs: signal.receivedAtMs,
    }),
  );
};
/**
 * @param {_SmithersDb} adapter
 * @param {string} runId
 * @param {WaitForEventSignalInput} signal
 */
export const bridgeSignalResolve = async (adapter, runId, signal) => {
  const nodes = await Effect.runPromise(adapter.listNodes(runId));
  const normalizedCorrelationId = normalizeCorrelationId(signal.correlationId);
  for (const node of nodes) {
    if (node.state !== "waiting-event") continue;
    const iteration = node.iteration ?? 0;
    const attempts = await Effect.runPromise(adapter.listAttempts(runId, node.nodeId, iteration));
    const waitingAttempt = attempts.find((attempt) => attempt.state === "waiting-event") ?? attempts[0];
    if (!waitingAttempt) continue;
    const snapshot = parseWaitForEventAttemptSnapshot(waitingAttempt.metaJson);
    if (!snapshot) continue;
    if (snapshot.signalName !== signal.signalName) continue;
    if (snapshot.correlationId !== normalizedCorrelationId) continue;
    await bridgeWaitForEventResolve(adapter, runId, node.nodeId, iteration, signal);
  }
};
export const __durableDeferredBridgeInternals = {
  buildResolvedWaitForEventMetaJson,
  decrementAsyncEventWaitPending,
  getAdapterNamespace,
  markWaitForEventResolved,
  normalizeCorrelationId,
  parseOptionalFiniteNumber,
  parseWaitForEventAttemptSnapshot,
};
