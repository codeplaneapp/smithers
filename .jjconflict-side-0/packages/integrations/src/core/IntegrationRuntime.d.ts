import { IntegrationRuntime as IntegrationRuntime$1, MakeIntegrationRuntimeOptions as MakeIntegrationRuntimeOptions$1 } from './IntegrationRuntimeTypes.js';
import '@smithers-orchestrator/db/adapter';
import './EventSourceTypes.js';
import './CursorStoreTypes.js';
import 'effect';
import '@smithers-orchestrator/errors/SmithersError';
import './ExternalEventTypes.js';

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
declare function makeIntegrationRuntime(options: MakeIntegrationRuntimeOptions): IntegrationRuntime;
type IntegrationRuntime = IntegrationRuntime$1;
type MakeIntegrationRuntimeOptions = MakeIntegrationRuntimeOptions$1;

export { type IntegrationRuntime, type MakeIntegrationRuntimeOptions, makeIntegrationRuntime };
