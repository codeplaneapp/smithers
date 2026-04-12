/**
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @returns {string}
 */
export function buildHumanRequestId(runId, nodeId, iteration) {
  return `human:${runId}:${nodeId}:${iteration}`;
}
