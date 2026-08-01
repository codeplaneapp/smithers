const PREFIX = "smithers-account:";

/** @param {string} label */
export function registeredAgentId(label) {
  return `${PREFIX}${label}`;
}

/** @param {unknown} agentId */
export function registeredAgentLabel(agentId) {
  if (typeof agentId !== "string" || !agentId.startsWith(PREFIX)) return undefined;
  const label = agentId.slice(PREFIX.length);
  return label || undefined;
}
