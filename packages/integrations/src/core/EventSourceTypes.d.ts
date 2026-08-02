import { CursorStore } from './CursorStoreTypes.js';
import * as effect from 'effect';
import { Stream } from 'effect';
import { ExternalEvent } from './ExternalEventTypes.js';
import { SmithersError } from '@smthrs/errors/SmithersError';

/**
 * A process-wide source of external events. `events` is the (possibly
 * infinite) stream the IntegrationRuntime drains into the delivery pipeline.
 */
type EventSource = {
    id: string;
    events: Stream.Stream<EventSourceItem, SmithersError>;
};
/** One polling turn held behind a delivery acknowledgement. */
type EventBatch = {
    _tag: "EventBatch";
    events: readonly ExternalEvent[];
    /** Cursor proposed by this poll turn; undefined keeps the current cursor. */
    proposedCursor?: string | null;
    /** Persist the proposed cursor after every event is durably delivered. */
    ack: effect.Effect.Effect<void, SmithersError>;
};
/** Webhooks emit individual events; polling sources emit acknowledged batches. */
type EventSourceItem = ExternalEvent | EventBatch;
/**
 * The raw webhook request handed to a webhook source's `offer`: the
 * already-read raw body (needed for HMAC verification) plus headers.
 */
type WebhookRequest = {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
};
type MakeWebhookSourceOptions = {
    id: string;
    /** Bounded queue capacity between ingress and delivery. @default 256 */
    capacity?: number;
    /** Signature check; return false to reject with `invalid-signature`. */
    verify?: (request: WebhookRequest) => boolean;
    /** Decode a verified request into one or more ExternalEvents. */
    decode: (request: WebhookRequest) => ExternalEvent | ExternalEvent[];
};
type WebhookSource = {
    source: EventSource;
    /** Verify + decode + enqueue a webhook request; resolves with the accepted count. */
    offer: (request: WebhookRequest) => effect.Effect.Effect<{
        accepted: number;
    }, SmithersError>;
    /**
     * Atomically reject new offers and append EOS after accepted events.
     * Idempotent; the event stream drains in FIFO order before completing.
     */
    shutdown: effect.Effect.Effect<void>;
};
type PollResult = {
    events: ExternalEvent[];
    /** Next cursor to persist; omit/undefined to keep the current cursor. */
    cursor?: string | null;
};
type MakePollingSourceOptions = {
    id: string;
    /** One poll turn: given the current cursor, fetch new events + next cursor. */
    poll: (cursor: string | null) => effect.Effect.Effect<PollResult, SmithersError>;
    /** Poll cadence. @default Schedule.spaced("5 seconds") */
    schedule?: effect.Schedule.Schedule<unknown>;
    /** Durable cursor persistence (e.g. `makeDbCursorStore(adapter)`). */
    cursorStore?: CursorStore;
};

export type { EventBatch, EventSource, EventSourceItem, MakePollingSourceOptions, MakeWebhookSourceOptions, PollResult, WebhookRequest, WebhookSource };
