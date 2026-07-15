import { EventBatch as EventBatch$1, EventSource as EventSource$1, EventSourceItem as EventSourceItem$1, MakePollingSourceOptions as MakePollingSourceOptions$1, MakeWebhookSourceOptions as MakeWebhookSourceOptions$1, PollResult as PollResult$1, WebhookRequest as WebhookRequest$1, WebhookSource as WebhookSource$1 } from './EventSourceTypes.js';
import { Effect } from 'effect';
import './CursorStoreTypes.js';
import '@smithers-orchestrator/errors/SmithersError';
import './ExternalEventTypes.js';

/**
 * Build a Queue-backed webhook EventSource. Ingress code calls
 * `offer(request)` per incoming HTTP request: the request is verified
 * (`invalid-signature` failure on mismatch), decoded into ExternalEvents, and
 * enqueued; the returned `source.events` stream feeds the delivery pipeline.
 *
 * @param {MakeWebhookSourceOptions} options
 * @returns {Effect.Effect<WebhookSource, never>}
 */
declare function makeWebhookSource(options: MakeWebhookSourceOptions): Effect.Effect<WebhookSource, never>;
/**
 * Build a polling EventSource: repeatedly runs `poll(cursor)` on `schedule`
 * (first poll immediately) and emits an acknowledged batch. The returned
 * cursor reaches the CursorStore only after delivery acknowledges that batch.
 *
 * @param {MakePollingSourceOptions} options
 * @returns {EventSource}
 */
declare function makePollingSource(options: MakePollingSourceOptions): EventSource;
type EventSource = EventSource$1;
type EventBatch = EventBatch$1;
type EventSourceItem = EventSourceItem$1;
type MakePollingSourceOptions = MakePollingSourceOptions$1;
type MakeWebhookSourceOptions = MakeWebhookSourceOptions$1;
type PollResult = PollResult$1;
type WebhookRequest = WebhookRequest$1;
type WebhookSource = WebhookSource$1;

export { type EventBatch, type EventSource, type EventSourceItem, type MakePollingSourceOptions, type MakeWebhookSourceOptions, type PollResult, type WebhookRequest, type WebhookSource, makePollingSource, makeWebhookSource };
