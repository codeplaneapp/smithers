// @smithers-type-exports-begin
/** @typedef {import("./EventSourceTypes.ts").EventSource} EventSource */
/** @typedef {import("./EventSourceTypes.ts").EventBatch} EventBatch */
/** @typedef {import("./EventSourceTypes.ts").EventSourceItem} EventSourceItem */
/** @typedef {import("./EventSourceTypes.ts").MakePollingSourceOptions} MakePollingSourceOptions */
/** @typedef {import("./EventSourceTypes.ts").MakeWebhookSourceOptions} MakeWebhookSourceOptions */
/** @typedef {import("./EventSourceTypes.ts").PollResult} PollResult */
/** @typedef {import("./EventSourceTypes.ts").WebhookRequest} WebhookRequest */
/** @typedef {import("./EventSourceTypes.ts").WebhookSource} WebhookSource */
// @smithers-type-exports-end

import { Effect, Queue, Ref, Schedule, Stream } from "effect";
import { decodeExternalEvent } from "./ExternalEvent.js";
import { IntegrationError } from "./IntegrationError.js";

const DEFAULT_WEBHOOK_CAPACITY = 256;
const WEBHOOK_END = Symbol("smithers.integration.webhook.end");

/**
 * Build a Queue-backed webhook EventSource. Ingress code calls
 * `offer(request)` per incoming HTTP request: the request is verified
 * (`invalid-signature` failure on mismatch), decoded into ExternalEvents, and
 * enqueued; the returned `source.events` stream feeds the delivery pipeline.
 * `shutdown` atomically closes ingress and appends EOS after every accepted
 * event, allowing the stream to drain in FIFO order and complete naturally.
 *
 * @param {MakeWebhookSourceOptions} options
 * @returns {Effect.Effect<WebhookSource, never>}
 */
export function makeWebhookSource(options) {
  const { id, capacity = DEFAULT_WEBHOOK_CAPACITY, verify, decode } = options;
  return Effect.gen(function* () {
    // Reserve one internal slot for EOS. Public event capacity remains
    // exactly `capacity`, so close never waits behind a full event queue.
    /** @type {Queue.Queue<import("./ExternalEventTypes.ts").ExternalEvent | typeof WEBHOOK_END>} */
    const queue = yield* Queue.bounded(capacity + 1);
    const offerLock = yield* Effect.makeSemaphore(1);
    let closed = false;
    /** @type {EventSource} */
    const source = {
      id,
      events: Stream.fromQueue(queue).pipe(
        Stream.takeWhile((item) => item !== WEBHOOK_END),
        Stream.map((item) => /** @type {import("./ExternalEventTypes.ts").ExternalEvent} */ (item)),
      ),
    };
    /**
     * @param {WebhookRequest} request
     */
    const offer = (request) =>
      Effect.gen(function* () {
        if (verify) {
          const verified = yield* Effect.try({
            try: () => verify(request),
            catch: (cause) =>
              new IntegrationError(
                "invalid-signature",
                `Webhook signature verification threw for source "${id}".`,
                { sourceId: id },
                { cause },
              ),
          });
          if (!verified) {
            return yield* Effect.fail(
              new IntegrationError("invalid-signature", `Webhook signature verification failed for source "${id}".`, {
                sourceId: id,
              }),
            );
          }
        }
        const decoded = yield* Effect.try({
          try: () => decode(request),
          catch: (cause) =>
            new IntegrationError(
              "decode-failed",
              `Webhook payload decode failed for source "${id}".`,
              { sourceId: id },
              { cause },
            ),
        });
        const candidates = Array.isArray(decoded) ? decoded : [decoded];
        const events = [];
        for (const candidate of candidates) {
          events.push(
            yield* decodeExternalEvent(candidate).pipe(
              Effect.mapError(
                (cause) =>
                  new IntegrationError(
                    "decode-failed",
                    `Webhook decoder produced an invalid ExternalEvent for source "${id}".`,
                    { sourceId: id },
                    { cause },
                  ),
              ),
            ),
          );
        }
        return yield* offerLock.withPermits(1)(
          Effect.gen(function* () {
            if (closed) {
              return yield* Effect.fail(
                new IntegrationError("queue-closed", `Webhook source "${id}" is shut down.`, { sourceId: id }),
              );
            }
            // Serialize producers so the capacity check and batch offer are
            // atomic relative to other webhook requests. Consumers can only
            // free capacity between these operations.
            const queued = Math.max(yield* Queue.size(queue), 0);
            if (events.length > capacity - queued) {
              return yield* Effect.fail(
                new IntegrationError(
                  "queue-full",
                  `Webhook source "${id}" does not have capacity for the event batch.`,
                  {
                    sourceId: id,
                    capacity,
                    queued,
                    requested: events.length,
                  },
                ),
              );
            }
            const accepted = yield* Queue.offerAll(queue, events);
            if (!accepted) {
              return yield* Effect.fail(
                new IntegrationError("queue-full", `Webhook source "${id}" rejected the event batch.`, {
                  sourceId: id,
                  capacity,
                  requested: events.length,
                }),
              );
            }
            return { accepted: events.length };
          }),
        );
      });
    const shutdown = offerLock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (closed) {
            return;
          }
          closed = true;
          yield* Queue.offer(queue, WEBHOOK_END);
        }),
      ),
    );
    return { source, offer, shutdown };
  });
}

/**
 * Build a polling EventSource: repeatedly runs `poll(cursor)` on `schedule`
 * (first poll immediately) and emits an acknowledged batch. The returned
 * cursor reaches the CursorStore only after delivery acknowledges that batch.
 *
 * @param {MakePollingSourceOptions} options
 * @returns {EventSource}
 */
export function makePollingSource(options) {
  const { id, poll, schedule = Schedule.spaced("5 seconds"), cursorStore } = options;
  const events = Stream.unwrap(
    Effect.gen(function* () {
      const initial = cursorStore ? yield* cursorStore.get(id) : undefined;
      const cursorRef = yield* Ref.make(initial ?? null);
      const pollOnce = Effect.gen(function* () {
        const cursor = yield* Ref.get(cursorRef);
        const result = yield* poll(cursor);
        const polled = result?.events ?? [];
        const proposedCursor = result?.cursor;
        const ack =
          proposedCursor !== undefined && proposedCursor !== cursor
            ? Effect.gen(function* () {
                // Durable state moves first. Interruption between these writes
                // can only cause a safe re-poll; the inverse can skip events.
                if (cursorStore) {
                  yield* cursorStore.set(id, proposedCursor);
                }
                yield* Ref.set(cursorRef, proposedCursor);
              })
            : Effect.void;
        /** @type {EventBatch} */
        const batch = {
          _tag: "EventBatch",
          events: polled,
          ...(proposedCursor !== undefined ? { proposedCursor } : {}),
          ack,
        };
        return batch;
      });
      return Stream.repeatEffectWithSchedule(pollOnce, schedule);
    }),
  );
  return { id, events };
}
