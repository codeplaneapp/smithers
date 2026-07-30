import { randomUUID } from "node:crypto";
import { Effect, Exit, Schedule, Stream } from "effect";
import { signalRun } from "@smithers-orchestrator/engine/signals";
import { logError, logInfo } from "@smithers-orchestrator/observability/logging";
import { IntegrationError } from "./IntegrationError.js";

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./ExternalEventTypes.ts").ExternalEvent} ExternalEvent */
/** @typedef {import("./EventSourceTypes.ts").EventSource} EventSource */

// Per-run delivery retry: transient db/signal failures back off exponentially,
// bounded so one poisoned run cannot stall the source stream.
const SIGNAL_RETRY_SCHEDULE = Schedule.exponential("200 millis").pipe(Schedule.upTo({ times: 3 }));
const CLAIM_LEASE_DURATION_MS = 30_000;
const CLAIM_HEARTBEAT_SCHEDULE = Schedule.spaced("10 seconds");

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
 * @returns {Effect.Effect<{ deduped: boolean; runIds: string[] }, import("@smithers-orchestrator/errors/SmithersError").SmithersError>}
 */
export function deliverEvent(adapter, event) {
  return Effect.gen(function* () {
    const ownerToken = randomUUID();
    const claimRow = {
      sourceId: event.source,
      dedupeKey: event.dedupeKey,
      eventName: event.eventName,
      receivedAtMs: event.receivedAtMs,
    };
    const claim = yield* adapter.claimIntegrationDelivery(claimRow, {
      ownerToken,
      leaseDurationMs: CLAIM_LEASE_DURATION_MS,
    });
    if (claim.status === "completed") {
      logInfo(
        "integration event deduped",
        {
          sourceId: event.source,
          eventName: event.eventName,
          dedupeKey: event.dedupeKey,
        },
        "integrations:deliver",
      );
      return { deduped: true, runIds: [] };
    }
    if (claim.status === "busy") {
      return yield* Effect.fail(
        new IntegrationError(
          "delivery-failed",
          `Integration delivery is already claimed for source "${event.source}".`,
          {
            sourceId: event.source,
            dedupeKey: event.dedupeKey,
            leaseExpiresAtMs: claim.leaseExpiresAtMs,
          },
        ),
      );
    }
    const canonicalEvent = { ...event, receivedAtMs: claim.receivedAtMs };
    const renewClaim = Effect.suspend(() =>
      adapter.renewIntegrationDeliveryClaim(
        event.source,
        event.dedupeKey,
        ownerToken,
        Date.now(),
        CLAIM_LEASE_DURATION_MS,
      ),
    ).pipe(
      Effect.flatMap((renewed) =>
        renewed
          ? Effect.void
          : Effect.fail(
              new IntegrationError(
                "delivery-failed",
                `Integration delivery claim was lost for source "${event.source}".`,
                {
                  sourceId: event.source,
                  dedupeKey: event.dedupeKey,
                },
              ),
            ),
      ),
    );
    const delivery = Effect.gen(function* () {
      const runIds = yield* adapter.findRunsAwaitingEvent(canonicalEvent.eventName, canonicalEvent.correlationId);
      const fanout = Effect.gen(function* () {
        const delivered = [];
        /** @type {Array<{ runId: string; error: import("@smithers-orchestrator/errors/SmithersError").SmithersError }>} */
        const failures = [];
        for (const runId of runIds) {
          yield* renewClaim;
          const outcome = yield* Effect.suspend(() =>
            signalRun(adapter, runId, canonicalEvent.eventName, canonicalEvent.payload ?? null, {
              correlationId: canonicalEvent.correlationId ?? undefined,
              receivedBy: `integration:${canonicalEvent.source}`,
              timestampMs: canonicalEvent.receivedAtMs,
            }),
          ).pipe(
            Effect.retry(SIGNAL_RETRY_SCHEDULE),
            Effect.map(() => runId),
            Effect.catch((error) =>
              Effect.sync(() => {
                logError(
                  "integration signal delivery failed",
                  {
                    sourceId: canonicalEvent.source,
                    eventName: canonicalEvent.eventName,
                    runId,
                    error: error instanceof Error ? error.message : String(error),
                  },
                  "integrations:deliver",
                );
                failures.push({ runId, error });
                return null;
              }),
            ),
          );
          if (outcome !== null) {
            delivered.push(outcome);
          }
        }
        const firstFailure = failures[0];
        if (firstFailure) {
          return yield* Effect.fail(firstFailure.error);
        }
        return delivered;
      });
      const heartbeat = Effect.repeat(renewClaim, CLAIM_HEARTBEAT_SCHEDULE).pipe(Effect.flatMap(() => Effect.never));
      const delivered = yield* Effect.raceFirst(fanout, heartbeat);
      const completed = yield* adapter.completeIntegrationDelivery(
        canonicalEvent.source,
        canonicalEvent.dedupeKey,
        ownerToken,
      );
      if (!completed) {
        return yield* Effect.fail(
          new IntegrationError(
            "delivery-failed",
            `Integration delivery claim could not be completed for source "${canonicalEvent.source}".`,
            {
              sourceId: canonicalEvent.source,
              dedupeKey: canonicalEvent.dedupeKey,
            },
          ),
        );
      }
      logInfo(
        "integration event delivered",
        {
          sourceId: canonicalEvent.source,
          eventName: canonicalEvent.eventName,
          correlationId: canonicalEvent.correlationId ?? null,
          matchedRunCount: runIds.length,
          deliveredCount: delivered.length,
        },
        "integrations:deliver",
      );
      return { deduped: false, runIds: delivered };
    });
    return yield* delivery.pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : adapter.releaseIntegrationDeliveryClaim(event.source, event.dedupeKey, ownerToken).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  logError(
                    "integration delivery claim release failed",
                    {
                      sourceId: event.source,
                      eventName: event.eventName,
                      error: error instanceof Error ? error.message : String(error),
                    },
                    "integrations:deliver",
                  );
                }),
              ),
            ),
      ),
    );
  }).pipe(
    Effect.annotateLogs({
      sourceId: event.source,
      eventName: event.eventName,
    }),
    Effect.withLogSpan("integrations:deliver"),
  );
}

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
 * @returns {Effect.Effect<void, import("@smithers-orchestrator/errors/SmithersError").SmithersError>}
 */
export function deliverEvents(adapter, source) {
  return Stream.runForEach(source.events, (item) => {
    if (!(item && "_tag" in item && item._tag === "EventBatch")) {
      return deliverEvent(adapter, item).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            logError(
              "integration event delivery failed",
              {
                sourceId: source.id,
                eventName: item.eventName,
                error: error instanceof Error ? error.message : String(error),
              },
              "integrations:deliver",
            );
          }),
        ),
      );
    }
    return Effect.gen(function* () {
      for (const event of item.events) {
        yield* deliverEvent(adapter, event);
      }
      yield* item.ack;
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          logError(
            "integration batch delivery failed",
            {
              sourceId: source.id,
              error: error instanceof Error ? error.message : String(error),
            },
            "integrations:deliver",
          );
        }),
      ),
    );
  });
}
