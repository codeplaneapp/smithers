/** @typedef {import("@smithers-orchestrator/graph").TaskDescriptor} TaskDescriptor */

/**
 * `state.descriptors` holds exactly one entry per nodeId — the CURRENT
 * iteration — keyed by nodeId. There is no per-iteration history here, so
 * this is a keyed lookup only: a stale-iteration lookup intentionally
 * returns undefined. Callers that need a prior failed iteration's
 * descriptor use the separate `failureDescriptors` map instead.
 *
 * @param {Map<string, TaskDescriptor>} descriptors
 * @param {string} nodeId
 * @param {number} [iteration]
 * @returns {TaskDescriptor | undefined}
 */
export function findDescriptor(descriptors, nodeId, iteration) {
  const descriptor = descriptors.get(nodeId);
  return descriptor && (iteration == null || descriptor.iteration === iteration) ? descriptor : undefined;
}
