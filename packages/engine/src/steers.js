import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { trackEvent } from "@smithers-orchestrator/observability/metrics";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";

/** Hard cap on steer message length; a steer is a short instruction. */
const STEER_MESSAGE_MAX_LENGTH = 20_000;

/**
 * @param {unknown} message
 * @returns {string}
 */
function normalizeSteerMessage(message) {
  if (typeof message !== "string") {
    throw new SmithersError("INVALID_INPUT", "Steer message must be a string.", { message });
  }
  const trimmed = message.trim();
  if (!trimmed) {
    throw new SmithersError("INVALID_INPUT", "Steer message must be a non-empty string.");
  }
  if (message.length > STEER_MESSAGE_MAX_LENGTH) {
    throw new SmithersError("INVALID_INPUT", `Steer message exceeds ${STEER_MESSAGE_MAX_LENGTH} characters.`, {
      length: message.length,
    });
  }
  return message;
}

/**
 * Queue a fire-and-forget steer against a running node. The message is
 * consumed into the node's next agent `generate()` call (first start, retry
 * attempt, or loop iteration). Mirrors how approvals emit their run-stream event
 * out-of-process: the durable row and `SteerQueued` event are committed in one
 * adapter transaction so mirrors (herdr, gateway subscribers) cannot observe a
 * consumed steer before its queued event, and an event failure cannot strand an
 * orphan inbox row.
 *
 * Delivery is best-effort at-most-once at the generate() boundary: the engine
 * marks a steer consumed just before generate(), so a crash in the narrow window
 * before the attempt's conversation is durably persisted (streaming checkpoint /
 * post-generate) may drop a consumed steer rather than re-deliver it.
 * Publication is idempotent on `steerId`: the insert's RETURNING verdict owns
 * event publication, so a retried enqueue with the same explicit steerId leaves
 * one durable row and one SteerQueued event.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {string} message
 * @param {{ author?: string | null; timestampMs?: number; steerId?: string }} [options]
 * @returns {Effect.Effect<{ steerId: string; runId: string; nodeId: string; message: string; author: string | null; createdAtMs: number }, SmithersError, never>}
 */
export function enqueueSteer(adapter, runId, nodeId, message, options = {}) {
  const normalizedMessage = normalizeSteerMessage(message);
  if (typeof nodeId !== "string" || nodeId.trim() === "") {
    throw new SmithersError("INVALID_INPUT", "Steer nodeId must be a non-empty string.", { runId });
  }
  const createdAtMs = options.timestampMs ?? nowMs();
  const author = options.author ?? null;
  const steerId = options.steerId ?? `steer-${randomUUID()}`;
  return Effect.gen(function* () {
    const event = {
      type: "SteerQueued",
      runId,
      nodeId,
      steerId,
      message: normalizedMessage,
      ...(author ? { author } : {}),
      timestampMs: createdAtMs,
    };
    const inserted = yield* adapter.enqueueSteerWithEvent(
      {
        steerId,
        runId,
        nodeId,
        message: normalizedMessage,
        author,
        createdAtMs,
        status: "queued",
      },
      {
        runId,
        timestampMs: createdAtMs,
        type: "SteerQueued",
        payloadJson: JSON.stringify(event),
      },
      { requireActiveTarget: true },
    );
    if (inserted) yield* trackEvent(/** @type {any} */ (event));
    return { steerId, runId, nodeId, message: normalizedMessage, author, createdAtMs };
  }).pipe(Effect.annotateLogs({ runId, nodeId, steerId }), Effect.withLogSpan("steer:enqueue"));
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} expiredAtMs
 * @returns {Effect.Effect<unknown[], unknown>}
 */
function expireQueuedSteersEffect(adapter, runId, expiredAtMs) {
  return Effect.gen(function* () {
    const persistedEvents = [];
    const queued = (yield* adapter.listSteers(runId)).filter((steer) => steer.status === "queued");
    for (const steer of queued) {
      yield* adapter.markSteerExpired(steer.steerId, expiredAtMs);
      const event = {
        type: "SteerExpired",
        runId,
        nodeId: steer.nodeId,
        steerId: steer.steerId,
        timestampMs: expiredAtMs,
      };
      yield* adapter.insertEventWithNextSeq({
        runId,
        timestampMs: expiredAtMs,
        type: event.type,
        payloadJson: JSON.stringify(event),
      });
      persistedEvents.push(event);
    }
    return persistedEvents;
  });
}

/**
 * Emit events whose database rows were already committed by the surrounding
 * terminal transaction.
 *
 * @param {{ emitEventWithPersist: (event: unknown) => Effect.Effect<void, unknown> }} eventBus
 * @param {unknown[]} events
 */
async function emitPersistedEvents(eventBus, events) {
  for (const event of events) {
    const committedBus = /** @type {{
     *   emitAndTrack?: (event: unknown) => Effect.Effect<void, unknown>;
     *   persistLog?: (event: unknown) => Effect.Effect<void, unknown>;
     * }} */ (eventBus);
    if (typeof committedBus.emitAndTrack === "function") {
      await Effect.runPromise(committedBus.emitAndTrack(event));
      if (typeof committedBus.persistLog === "function") {
        await Effect.runPromise(Effect.ignore(committedBus.persistLog(event)));
      }
    } else {
      await Effect.runPromise(eventBus.emitEventWithPersist(event));
    }
  }
}

/**
 * Expire every still-queued steer for a run. Called when a run reaches a
 * terminal state (finished/failed): at that point every node has reached
 * terminal with no further generate call, so any un-consumed steer can never
 * apply. This is the deterministic, loop-safe expiry point — a per-node
 * NodeFinished hook would prematurely expire steers destined for a `<Loop>`
 * node's next iteration (same nodeId, higher iteration), which has not run yet.
 *
 * The steer mutations and their `SteerExpired` rows commit atomically, then
 * the committed events are published through the run's in-process event bus.
 *
 * @param {SmithersDb} adapter
 * @param {{ emitEventWithPersist: (event: unknown) => Effect.Effect<void, unknown> }} eventBus
 * @param {string} runId
 * @param {number} [timestampMs]
 * @returns {Promise<void>}
 */
export async function expireQueuedSteersForRun(adapter, eventBus, runId, timestampMs) {
  const expiredAtMs = timestampMs ?? nowMs();
  const persistedEvents = await adapter.withTransaction(
    "expire queued steers",
    expireQueuedSteersEffect(adapter, runId, expiredAtMs),
  );
  await emitPersistedEvents(eventBus, persistedEvents);
}
