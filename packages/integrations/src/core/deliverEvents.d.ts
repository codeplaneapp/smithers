import { EventSource as EventSource$1 } from './EventSourceTypes.js';
import { ExternalEvent as ExternalEvent$1 } from './ExternalEventTypes.js';
import * as _smithers_orchestrator_db_adapter from '@smithers-orchestrator/db/adapter';
import * as _smithers_orchestrator_errors_SmithersError from '@smithers-orchestrator/errors/SmithersError';
import { Effect } from 'effect';
import './CursorStoreTypes.js';

/**
 * Deliver ONE external event: dedupe against
 * `_smithers_integration_deliveries`, find runs parked on
 * `WaitForEvent(eventName, correlationId)`, and `signalRun` each with
 * `receivedBy: "integration:<source>"`. Per-run failures are retried then
 * logged — they never fail the returned effect, so the source stream lives on.
 *
 * @param {SmithersDb} adapter
 * @param {ExternalEvent} event
 * @returns {Effect.Effect<{ deduped: boolean; runIds: string[] }, import("@smithers-orchestrator/errors/SmithersError").SmithersError>}
 */
declare function deliverEvent(adapter: SmithersDb, event: ExternalEvent): Effect.Effect<{
    deduped: boolean;
    runIds: string[];
}, _smithers_orchestrator_errors_SmithersError.SmithersError>;
/**
 * Drain an EventSource into the delivery pipeline. Per-event delivery errors
 * are logged and swallowed so a single bad event never kills the stream; a
 * stream-level error (e.g. a failing poll) surfaces to the caller, which is
 * expected to retry/restart (see IntegrationRuntime's supervision).
 *
 * @param {SmithersDb} adapter
 * @param {EventSource} source
 * @returns {Effect.Effect<void, import("@smithers-orchestrator/errors/SmithersError").SmithersError>}
 */
declare function deliverEvents(adapter: SmithersDb, source: EventSource): Effect.Effect<void, _smithers_orchestrator_errors_SmithersError.SmithersError>;
type SmithersDb = _smithers_orchestrator_db_adapter.SmithersDb;
type ExternalEvent = ExternalEvent$1;
type EventSource = EventSource$1;

export { type EventSource, type ExternalEvent, type SmithersDb, deliverEvent, deliverEvents };
