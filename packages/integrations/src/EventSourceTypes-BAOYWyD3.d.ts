import * as effect from 'effect';
import { Effect, Stream } from 'effect';
import { SmithersError } from '@smithers-orchestrator/errors/SmithersError';

/**
 * Durable persistence seam for polling-source cursors. The db-backed
 * implementation (`makeDbCursorStore`) rides `_smithers_integration_cursors`.
 */
type CursorStore = {
    get: (sourceId: string) => Effect.Effect<string | null | undefined, SmithersError>;
    set: (sourceId: string, cursor: string | null) => Effect.Effect<void, SmithersError>;
};

/**
 * A normalized event received from an external service (webhook delivery or
 * polling result) before it is fanned out to waiting runs via `signalRun`.
 */
type ExternalEvent = {
    /** Source id that produced the event (e.g. `github`, `telegram`, a generic webhook source id). */
    source: string;
    /** Smithers signal name, `integration:<service>:<event>` by convention. */
    eventName: string;
    /** Correlation id used to target waiting runs (null = match waits without one). */
    correlationId: string | null;
    /** JSON-serializable payload delivered as the signal payload. */
    payload: unknown;
    /** Provider-stable delivery id used for redelivery dedupe. */
    dedupeKey: string;
    /** When the event was received (Unix epoch ms). */
    receivedAtMs: number;
};

/**
 * A process-wide source of external events. `events` is the (possibly
 * infinite) stream the IntegrationRuntime drains into the delivery pipeline.
 */
type EventSource = {
    id: string;
    events: Stream.Stream<ExternalEvent, SmithersError>;
};
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

export type { CursorStore as C, ExternalEvent as E, MakePollingSourceOptions as M, PollResult as P, WebhookRequest as W, EventSource as a, MakeWebhookSourceOptions as b, WebhookSource as c };
