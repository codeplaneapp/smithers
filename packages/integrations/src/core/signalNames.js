import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

/**
 * Reserved prefix for integration-delivered signals. User signals must not
 * use it; every event delivered by an integration source does.
 */
export const INTEGRATION_SIGNAL_PREFIX = "integration:";

/**
 * @param {string} value
 * @param {string} label
 * @returns {string}
 */
function requireSegment(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new SmithersError("INVALID_INPUT", `Integration signal ${label} must be a non-empty string.`, {
      [label]: value,
    });
  }
  if (normalized.includes(":")) {
    throw new SmithersError("INVALID_INPUT", `Integration signal ${label} must not contain ":".`, { [label]: value });
  }
  return normalized;
}

/**
 * Build the signal name for an integration event:
 * `integration:<service>:<event>` (e.g. `integration:github:pull_request.opened`,
 * `integration:telegram:message`). The `event` segment may contain dots for
 * per-action variants but neither segment may contain `:`.
 * @param {string} service
 * @param {string} event
 * @returns {string}
 */
export function integrationEventName(service, event) {
  const normalizedService = requireSegment(service, "service");
  const normalizedEvent = requireSegment(event, "event");
  return `${INTEGRATION_SIGNAL_PREFIX}${normalizedService}:${normalizedEvent}`;
}

/**
 * Predicate for the reserved `integration:` signal-name prefix.
 * @param {unknown} signalName
 * @returns {boolean}
 */
export function isIntegrationSignalName(signalName) {
  return typeof signalName === "string" && signalName.startsWith(INTEGRATION_SIGNAL_PREFIX);
}

/**
 * Parse an `integration:<service>:<event>` signal name back into its parts.
 * Returns `null` for non-integration names.
 * @param {string} signalName
 * @returns {{ service: string; event: string } | null}
 */
export function parseIntegrationEventName(signalName) {
  if (!isIntegrationSignalName(signalName)) {
    return null;
  }
  const rest = signalName.slice(INTEGRATION_SIGNAL_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) {
    return null;
  }
  return {
    service: rest.slice(0, separator),
    event: rest.slice(separator + 1),
  };
}

/**
 * The `receivedBy` attribution stamped on signals delivered by an
 * integration source: `integration:<service>`.
 * @param {string} service
 * @returns {string}
 */
export function integrationReceivedBy(service) {
  return `${INTEGRATION_SIGNAL_PREFIX}${requireSegment(service, "service")}`;
}
