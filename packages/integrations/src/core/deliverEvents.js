import { Effect, Schedule, Stream } from "effect";
import { signalRun } from "@smithers-orchestrator/engine/signals";
import { logError, logInfo } from "@smithers-orchestrator/observability/logging";

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./ExternalEvent.ts").ExternalEvent} ExternalEvent */
/** @typedef {import("./EventSource.ts").EventSource} EventSource */

// Per-run delivery retry: transient db/signal failures back off exponentially,
// bounded so one poisoned run cannot stall the source stream.
const SIGNAL_RETRY_SCHEDULE = Schedule.intersect(Schedule.exponential("200 millis"), Schedule.recurs(3));

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
export function deliverEvent(adapter, event) {
    return Effect.gen(function* () {
        const inserted = yield* adapter.insertIntegrationDeliveryIfNew({
            sourceId: event.source,
            dedupeKey: event.dedupeKey,
            eventName: event.eventName,
            receivedAtMs: event.receivedAtMs,
        });
        if (!inserted) {
            logInfo("integration event deduped", {
                sourceId: event.source,
                eventName: event.eventName,
                dedupeKey: event.dedupeKey,
            }, "integrations:deliver");
            return { deduped: true, runIds: [] };
        }
        const runIds = yield* adapter.findRunsAwaitingEvent(event.eventName, event.correlationId);
        const delivered = [];
        for (const runId of runIds) {
            const outcome = yield* Effect.suspend(() => signalRun(adapter, runId, event.eventName, event.payload ?? null, {
                correlationId: event.correlationId ?? undefined,
                receivedBy: `integration:${event.source}`,
                timestampMs: event.receivedAtMs,
            })).pipe(Effect.retry(SIGNAL_RETRY_SCHEDULE), Effect.map(() => runId), Effect.catchAll((error) => Effect.sync(() => {
                logError("integration signal delivery failed", {
                    sourceId: event.source,
                    eventName: event.eventName,
                    runId,
                    error: error instanceof Error ? error.message : String(error),
                }, "integrations:deliver");
                return null;
            })));
            if (outcome) {
                delivered.push(outcome);
            }
        }
        logInfo("integration event delivered", {
            sourceId: event.source,
            eventName: event.eventName,
            correlationId: event.correlationId ?? null,
            matchedRunCount: runIds.length,
            deliveredCount: delivered.length,
        }, "integrations:deliver");
        return { deduped: false, runIds: delivered };
    }).pipe(Effect.annotateLogs({
        sourceId: event.source,
        eventName: event.eventName,
    }), Effect.withLogSpan("integrations:deliver"));
}

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
export function deliverEvents(adapter, source) {
    return Stream.runForEach(source.events, (event) => deliverEvent(adapter, event).pipe(Effect.catchAll((error) => Effect.sync(() => {
        logError("integration event delivery failed", {
            sourceId: source.id,
            eventName: event.eventName,
            error: error instanceof Error ? error.message : String(error),
        }, "integrations:deliver");
    }))));
}
