// @smithers-type-exports-begin
/** @typedef {import("./IntegrationRuntimeTypes.ts").IntegrationRuntime} IntegrationRuntime */
/** @typedef {import("./IntegrationRuntimeTypes.ts").MakeIntegrationRuntimeOptions} MakeIntegrationRuntimeOptions */
// @smithers-type-exports-end

import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime, Option, Schedule } from "effect";
import { logError, logInfo } from "@smithers-orchestrator/observability/logging";
import { deliverEvents } from "./deliverEvents.js";
import { IntegrationError } from "./IntegrationError.js";
import { makeWebhookSource } from "./EventSource.js";

// Restart back-off for crashed source streams: exponential from 1s, capped at
// a 30s spacing, retrying forever (an integration source should never die).
const SOURCE_RESTART_SCHEDULE = Schedule.union(Schedule.exponential("1 second"), Schedule.spaced("30 seconds"));

/**
 * Start the process-wide integration runtime: forks one supervised delivery
 * fiber per event source (webhook + polling) and exposes a promise-based
 * `handleWebhook` seam for the node HTTP server, plus a graceful `shutdown`.
 * Shutdown drains accepted webhook events before interrupting polling and
 * arbitrary sources. Fibers run on a dedicated ManagedRuntime so none leak.
 *
 * @param {MakeIntegrationRuntimeOptions} options
 * @returns {IntegrationRuntime}
 */
export function makeIntegrationRuntime(options) {
    const { adapter, sources = [], webhookSources = [] } = options;
    const runtime = ManagedRuntime.make(Layer.empty);
    /** @type {Map<string, (request: import("./EventSourceTypes.ts").WebhookRequest) => Effect.Effect<{ accepted: number }, import("@smithers-orchestrator/errors/SmithersError").SmithersError>>} */
    const webhookOffers = new Map();
    /** @type {Effect.Effect<void>[]} */
    const webhookShutdowns = [];
    /** @type {import("effect/Fiber").RuntimeFiber<void, never>[]} */
    const webhookFibers = [];
    /** @type {import("effect/Fiber").RuntimeFiber<void, never>[]} */
    const sourceFibers = [];
    /**
   * @param {import("./EventSourceTypes.ts").EventSource} source
   */
    const supervise = (source) => deliverEvents(adapter, source).pipe(Effect.tapError((error) => Effect.sync(() => {
        logError("integration source stream failed; restarting", {
            sourceId: source.id,
            error: error instanceof Error ? error.message : String(error),
        }, "integrations:runtime");
    })), Effect.retry(SOURCE_RESTART_SCHEDULE), Effect.catchAll(() => Effect.void));
    for (const config of webhookSources) {
        if (webhookOffers.has(config.id)) {
            throw new IntegrationError("invalid-config", `Duplicate webhook source id "${config.id}".`, { sourceId: config.id });
        }
        const webhook = runtime.runSync(makeWebhookSource(config));
        webhookOffers.set(config.id, webhook.offer);
        webhookShutdowns.push(webhook.shutdown);
        webhookFibers.push(runtime.runFork(supervise(webhook.source)));
    }
    for (const source of sources) {
        sourceFibers.push(runtime.runFork(supervise(source)));
    }
    logInfo("integration runtime started", {
        webhookSourceCount: webhookOffers.size,
        sourceCount: sources.length,
    }, "integrations:runtime");
    let shutdownPromise = null;
    let shuttingDown = false;
    return {
        hasWebhookSource: (sourceId) => webhookOffers.has(sourceId),
        handleWebhook: (sourceId, request) => {
            const offer = webhookOffers.get(sourceId);
            if (!offer) {
                return Promise.reject(new IntegrationError("unknown-source", `Unknown webhook source: ${sourceId}`, { sourceId }));
            }
            if (shuttingDown) {
                return Promise.reject(new IntegrationError("queue-closed", `Webhook source "${sourceId}" is shut down.`, { sourceId }));
            }
            // Reject with the RAW typed error (IntegrationError), not the
            // FiberFailure wrapper `runPromise` would throw, so HTTP ingress
            // can map `reason` → status.
            return runtime.runPromiseExit(offer(request)).then((exit) => {
                if (Exit.isSuccess(exit)) {
                    return exit.value;
                }
                const failure = Cause.failureOption(exit.cause);
                throw Option.isSome(failure)
                    ? failure.value
                    : Cause.squash(exit.cause);
            });
        },
        shutdown: () => {
            if (!shutdownPromise) {
                shuttingDown = true;
                shutdownPromise = (async () => {
                    try {
                        // Establish every webhook EOS concurrently, then wait for
                        // accepted events to drain without interrupting delivery.
                        await runtime.runPromise(Effect.all(webhookShutdowns, {
                            concurrency: "unbounded",
                            discard: true,
                        }));
                        await runtime.runPromise(Effect.gen(function* () {
                            const exits = yield* Effect.all(webhookFibers.map((fiber) => Fiber.await(fiber)), {
                                concurrency: "unbounded",
                            });
                            for (const exit of exits) {
                                if (Exit.isFailure(exit)) {
                                    return yield* Effect.failCause(exit.cause);
                                }
                            }
                        }));
                    }
                    finally {
                        // Polling and arbitrary sources have no finite EOS
                        // contract. Stop them only after webhook drain completes.
                        try {
                            await runtime.runPromise(Fiber.interruptAll(sourceFibers));
                        }
                        finally {
                            await runtime.dispose();
                            logInfo("integration runtime stopped", {}, "integrations:runtime");
                        }
                    }
                })();
            }
            return shutdownPromise;
        },
    };
}
