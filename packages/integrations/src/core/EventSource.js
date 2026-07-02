// @smithers-type-exports-begin
/** @typedef {import("./EventSource.ts").EventSource} EventSource */
/** @typedef {import("./EventSource.ts").MakePollingSourceOptions} MakePollingSourceOptions */
/** @typedef {import("./EventSource.ts").MakeWebhookSourceOptions} MakeWebhookSourceOptions */
/** @typedef {import("./EventSource.ts").PollResult} PollResult */
/** @typedef {import("./EventSource.ts").WebhookRequest} WebhookRequest */
/** @typedef {import("./EventSource.ts").WebhookSource} WebhookSource */
// @smithers-type-exports-end

import { Effect, Queue, Ref, Schedule, Stream } from "effect";
import { decodeExternalEvent } from "./ExternalEvent.js";
import { IntegrationError } from "./IntegrationError.js";

const DEFAULT_WEBHOOK_CAPACITY = 256;

/**
 * Build a Queue-backed webhook EventSource. Ingress code calls
 * `offer(request)` per incoming HTTP request: the request is verified
 * (`invalid-signature` failure on mismatch), decoded into ExternalEvents, and
 * enqueued; the returned `source.events` stream feeds the delivery pipeline.
 *
 * @param {MakeWebhookSourceOptions} options
 * @returns {Effect.Effect<WebhookSource, never>}
 */
export function makeWebhookSource(options) {
    const { id, capacity = DEFAULT_WEBHOOK_CAPACITY, verify, decode } = options;
    return Effect.gen(function* () {
        /** @type {Queue.Queue<import("./ExternalEvent.ts").ExternalEvent>} */
        const queue = yield* Queue.bounded(capacity);
        /** @type {EventSource} */
        const source = { id, events: Stream.fromQueue(queue) };
        /**
     * @param {WebhookRequest} request
     */
        const offer = (request) => Effect.gen(function* () {
            if (verify) {
                const verified = yield* Effect.try({
                    try: () => verify(request),
                    catch: (cause) => new IntegrationError("invalid-signature", `Webhook signature verification threw for source "${id}".`, { sourceId: id }, { cause }),
                });
                if (!verified) {
                    return yield* Effect.fail(new IntegrationError("invalid-signature", `Webhook signature verification failed for source "${id}".`, { sourceId: id }));
                }
            }
            const decoded = yield* Effect.try({
                try: () => decode(request),
                catch: (cause) => new IntegrationError("decode-failed", `Webhook payload decode failed for source "${id}".`, { sourceId: id }, { cause }),
            });
            const candidates = Array.isArray(decoded) ? decoded : [decoded];
            const events = [];
            for (const candidate of candidates) {
                events.push(yield* decodeExternalEvent(candidate).pipe(Effect.mapError((cause) => new IntegrationError("decode-failed", `Webhook decoder produced an invalid ExternalEvent for source "${id}".`, { sourceId: id }, { cause }))));
            }
            const accepted = yield* Queue.offerAll(queue, events).pipe(Effect.mapError(() => new IntegrationError("queue-closed", `Webhook source "${id}" is shut down.`, { sourceId: id })));
            if (!accepted) {
                return yield* Effect.fail(new IntegrationError("queue-closed", `Webhook source "${id}" rejected the event batch.`, { sourceId: id }));
            }
            return { accepted: events.length };
        });
        return { source, offer, shutdown: Queue.shutdown(queue) };
    });
}

/**
 * Build a polling EventSource: repeatedly runs `poll(cursor)` on `schedule`
 * (first poll immediately), persists the returned cursor through the
 * CursorStore, and emits the polled events one by one.
 *
 * @param {MakePollingSourceOptions} options
 * @returns {EventSource}
 */
export function makePollingSource(options) {
    const { id, poll, schedule = Schedule.spaced("5 seconds"), cursorStore } = options;
    const events = Stream.unwrap(Effect.gen(function* () {
        const initial = cursorStore ? yield* cursorStore.get(id) : undefined;
        const cursorRef = yield* Ref.make(initial ?? null);
        const pollOnce = Effect.gen(function* () {
            const cursor = yield* Ref.get(cursorRef);
            const result = yield* poll(cursor);
            const polled = result?.events ?? [];
            if (result && result.cursor !== undefined && result.cursor !== cursor) {
                yield* Ref.set(cursorRef, result.cursor);
                if (cursorStore) {
                    yield* cursorStore.set(id, result.cursor);
                }
            }
            return polled;
        });
        return Stream.repeatEffectWithSchedule(pollOnce, schedule).pipe(Stream.flatMap((batch) => Stream.fromIterable(batch)));
    }));
    return { id, events };
}
