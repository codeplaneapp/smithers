import * as _smithers_orchestrator_db_adapter from '@smithers-orchestrator/db/adapter';
import { WebhookRequest, EventSource, MakeWebhookSourceOptions } from './EventSourceTypes.js';
import './CursorStoreTypes.js';
import 'effect';
import '@smithers-orchestrator/errors/SmithersError';
import './ExternalEventTypes.js';

/**
 * Options for `makeIntegrationRuntime`. `sources` are self-driving streams
 * (e.g. polling sources); `webhookSources` are webhook source configs the
 * runtime constructs internally so `handleWebhook(sourceId, request)` can
 * route incoming HTTP deliveries to them.
 */
type MakeIntegrationRuntimeOptions = {
    adapter: _smithers_orchestrator_db_adapter.SmithersDb;
    sources?: EventSource[];
    webhookSources?: MakeWebhookSourceOptions[];
};
/**
 * A running integration runtime: one supervised delivery fiber per source,
 * a promise-based webhook entrypoint for the node HTTP server, and a
 * graceful shutdown.
 */
type IntegrationRuntime = {
    /** True when a webhook source with this id is registered. */
    hasWebhookSource: (sourceId: string) => boolean;
    /**
     * Verify + enqueue a webhook delivery. Rejects with an IntegrationError
     * whose `reason` is `unknown-source` (404), `invalid-signature` (401), or
     * `decode-failed` (400).
     */
    handleWebhook: (sourceId: string, request: WebhookRequest) => Promise<{
        accepted: number;
    }>;
    /** Interrupt all source fibers and dispose the runtime. Idempotent. */
    shutdown: () => Promise<void>;
};

export type { IntegrationRuntime, MakeIntegrationRuntimeOptions };
