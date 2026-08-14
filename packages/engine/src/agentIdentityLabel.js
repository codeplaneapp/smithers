/**
 * Stable identity of an agent within one run.
 *
 * The engine records this label on every attempt as `agentMeta.agentId`, and
 * the run-wide breaker keys on it. A chain index cannot serve as the key: the
 * same engine sits at different positions in different nodes' chains, so an
 * index-keyed breaker on one node says nothing about the next node.
 *
 * @param {{ id?: unknown; constructor?: { name?: unknown } } | null | undefined} agent
 * @returns {string | null}
 */
export function agentIdentityLabel(agent) {
  if (!agent) return null;
  if (typeof agent.id === "string" && agent.id.length > 0) return agent.id;
  const constructorName = agent.constructor?.name;
  return typeof constructorName === "string" && constructorName.length > 0 ? constructorName : null;
}
