import { EventSource as EventSource$1 } from './EventSourceTypes.js';
import { ExternalEvent as ExternalEvent$1 } from './ExternalEventTypes.js';
import * as _smthrs_db_adapter from '@smthrs/db/adapter';
import * as _smthrs_errors_SmithersError from '@smthrs/errors/SmithersError';
import { Effect } from 'effect';
import './CursorStoreTypes.js';

/**
 * Deliver ONE external event: dedupe against
 * `_smithers_integration_deliveries`, find runs parked on
 * `WaitForEvent(eventName, correlationId)`, and `signalRun` each with
 * `receivedBy: "integration:<source>"`. The ledger claim completes only after
 * every matched run is signaled. A typed per-run failure does not block later
 * matches, but it fails the event after fanout so polling cannot ack.
 *
 * @param {SmithersDb} adapter
 * @param {ExternalEvent} event
 * @param {{ onDelivery?: (result: { runIds: string[] }) => Effect.Effect<unknown, import("@smthrs/errors/SmithersError").SmithersError> }} [options]
 * @returns {Effect.Effect<{ deduped: boolean; runIds: string[]; action?: unknown }, import("@smthrs/errors/SmithersError").SmithersError>}
 */
declare function deliverEvent(adapter: SmithersDb, event: ExternalEvent, options?: {
    onDelivery?: (result: {
        runIds: string[];
    }) => Effect.Effect<unknown, _smthrs_errors_SmithersError.SmithersError>;
}): Effect.Effect<{
    deduped: boolean;
    runIds: string[];
    action?: unknown;
}, _smthrs_errors_SmithersError.SmithersError>;
/**
 * Drain an EventSource into the delivery pipeline. Poll batches are delivered
 * sequentially and acknowledged only after every event completes; an
 * incomplete batch propagates to IntegrationRuntime supervision so its cursor
 * stays uncommitted. Individual webhook events preserve the historical
 * catch/log/continue behavior so later queued items are still attempted. A
 * failed webhook claim remains retryable, but queue acceptance does not
 * guarantee that the provider will send another copy.
 *
 * @param {SmithersDb} adapter
 * @param {EventSource} source
 * @returns {Effect.Effect<void, import("@smthrs/errors/SmithersError").SmithersError>}
 */
declare function deliverEvents(adapter: SmithersDb, source: EventSource): Effect.Effect<void, _smthrs_errors_SmithersError.SmithersError>;
type SmithersDb = _smthrs_db_adapter.SmithersDb;
type ExternalEvent = ExternalEvent$1;
type EventSource = EventSource$1;

export { type EventSource, type ExternalEvent, type SmithersDb, deliverEvent, deliverEvents };
