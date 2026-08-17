/**
 * Resolve which snapshot node keys a fork flips back to `pending`.
 *
 * Contract: **only the nodes the caller names are reset.** A fork never expands
 * the set to downstream dependents — reset `A` and a finished `B` that consumed
 * `A`'s output stays finished in the child, carrying the parent's output. A
 * caller that wants `B` re-run must name `B` too.
 *
 * That narrowness is deliberate, not a missing feature. The snapshot rows a
 * fork reads carry no dependency edges (`NodeSnapshot.ts` is `nodeId`,
 * `iteration`, `state`, `lastAttempt`, `outputTable`, `label`), and a fork may
 * target an *edited* workflow whose edges differ from the parent's, so the
 * parent graph is not authoritative either. Dependent expansion lives on the
 * paths that hold the evidence for it: `timeTravel` and `retryTask` opt in via
 * `resetDependents` and derive the set from persisted node + attempt rows.
 *
 * Each entry of `resetNodeIds` is matched independently, and is either:
 * - a base `nodeId` — resets every iteration of that node; or
 * - a fully-qualified `nodeId::iteration` key — resets exactly that iteration,
 *   used only when the entry matched no base id.
 *
 * Entries that match nothing are ignored.
 *
 * @param {Record<string, unknown>} nodes snapshot nodes keyed `nodeId::iteration`
 * @param {string[]} resetNodeIds
 * @returns {string[]} snapshot keys to reset
 */
export function expandResetSet(nodes, resetNodeIds) {
  if (resetNodeIds.length === 0) return [];
  /** @type {Map<string, string[]>} */
  const keysByBaseId = new Map();
  for (const key of Object.keys(nodes)) {
    const baseId = key.split("::")[0];
    const bucket = keysByBaseId.get(baseId);
    if (bucket) bucket.push(key);
    else keysByBaseId.set(baseId, [key]);
  }
  const result = new Set();
  for (const id of resetNodeIds) {
    const byBaseId = keysByBaseId.get(id);
    if (byBaseId) {
      for (const key of byBaseId) result.add(key);
    } else if (nodes[id]) {
      result.add(id);
    }
  }
  return [...result];
}
