/**
 * Build the signal name for an integration event:
 * `integration:<service>:<event>` (e.g. `integration:github:pull_request.opened`,
 * `integration:telegram:message`). The `event` segment may contain dots for
 * per-action variants but neither segment may contain `:`.
 * @param {string} service
 * @param {string} event
 * @returns {string}
 */
declare function integrationEventName(service: string, event: string): string;
/**
 * Predicate for the reserved `integration:` signal-name prefix.
 * @param {unknown} signalName
 * @returns {boolean}
 */
declare function isIntegrationSignalName(signalName: unknown): boolean;
/**
 * Parse an `integration:<service>:<event>` signal name back into its parts.
 * Returns `null` for non-integration names.
 * @param {string} signalName
 * @returns {{ service: string; event: string } | null}
 */
declare function parseIntegrationEventName(signalName: string): {
    service: string;
    event: string;
} | null;
/**
 * The `receivedBy` attribution stamped on signals delivered by an
 * integration source: `integration:<service>`.
 * @param {string} service
 * @returns {string}
 */
declare function integrationReceivedBy(service: string): string;
/**
 * Reserved prefix for integration-delivered signals. User signals must not
 * use it; every event delivered by an integration source does.
 */
declare const INTEGRATION_SIGNAL_PREFIX: "integration:";

export { INTEGRATION_SIGNAL_PREFIX, integrationEventName, integrationReceivedBy, isIntegrationSignalName, parseIntegrationEventName };
