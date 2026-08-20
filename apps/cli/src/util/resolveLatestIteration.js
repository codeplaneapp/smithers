/**
 * Resolve which loop iteration a node-scoped command should read when the
 * caller gave no `--iteration`.
 *
 * A loop node keeps one row per iteration. Picking the numerically highest one
 * reads the round the engine just started, which has no output or diff yet, so
 * a finished round's data disappears the moment the next round is queued.
 * Prefer the newest iteration that reached a terminal state, and fall back to
 * the highest iteration when none has.
 *
 * @param {{ listNodeIterations(runId: string, nodeId: string): Promise<Array<Record<string, unknown>> | null | undefined> }} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @returns {Promise<number | null>}
 */
export async function resolveLatestIteration(adapter, runId, nodeId) {
  try {
    const iterations = await adapter.listNodeIterations(runId, nodeId);
    if (!Array.isArray(iterations) || iterations.length === 0) return null;
    return selectLatestIteration(iterations);
  } catch {
    return null;
  }
}

/**
 * The selection itself, for callers that already hold the node rows.
 *
 * @param {Array<Record<string, unknown>>} iterations
 * @returns {number}
 */
export function selectLatestIteration(iterations) {
  let highest = 0;
  /** @type {number | null} */
  let newestSettled = null;
  for (const row of iterations) {
    const iteration = typeof row?.iteration === "number" ? row.iteration : 0;
    if (iteration > highest) highest = iteration;
    if (isSettled(row) && (newestSettled === null || iteration > newestSettled)) {
      newestSettled = iteration;
    }
  }
  return newestSettled ?? highest;
}

/**
 * A node row carries data worth reading once it stops running. `failed` and
 * `cancelled` count: their rows explain what went wrong, and hiding them behind
 * an in-flight retry is the same defect as hiding a finished round.
 *
 * @param {Record<string, unknown> | null | undefined} row
 * @returns {boolean}
 */
function isSettled(row) {
  const status = typeof row?.status === "string" ? row.status.trim().toLowerCase() : "";
  return status === "finished" || status === "succeeded" || status === "failed" || status === "cancelled";
}
