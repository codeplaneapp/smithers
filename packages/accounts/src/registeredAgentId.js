const PREFIX = "smithers-account:";

/**
 * Stable agent id for an agent instance backed by a registered account, so
 * usage attribution (`smithers usage`, `inspect --pool`) can map attempts back
 * to the account label. Canonical home of the `smithers-account:` prefix; the
 * CLI's `registered-agent-id.js` re-exports it.
 *
 * @param {string} label
 * @returns {string}
 */
export function registeredAgentId(label) {
  return `${PREFIX}${label}`;
}

/**
 * Inverse of {@link registeredAgentId}: extract the account label from an
 * agent id, or `undefined` when the id is not account-backed.
 *
 * @param {unknown} agentId
 * @returns {string | undefined}
 */
export function registeredAgentLabel(agentId) {
  if (typeof agentId !== "string" || !agentId.startsWith(PREFIX)) return undefined;
  const label = agentId.slice(PREFIX.length);
  return label || undefined;
}
