/** @typedef {import("./SidecarDelta.ts").SidecarDelta} SidecarDelta */

/**
 * @typedef {Record<string, unknown> & {
 *   nodeId?: string,
 *   node_id?: string,
 *   scorerId?: string,
 *   scorer_id?: string,
 *   score?: number,
 *   scoredAtMs?: number,
 *   scored_at_ms?: number,
 * }} RowLike
 */

/**
 * @typedef {object} ComputeSidecarDeltaOptions
 * @property {string} primaryNodeId
 * @property {string} sidecarNodeId
 * @property {string} [scorerId]
 */

/** @param {RowLike} row */
function getNodeId(row) {
  return typeof row.nodeId === "string" ? row.nodeId : typeof row.node_id === "string" ? row.node_id : undefined;
}

/** @param {RowLike} row */
function getScorerId(row) {
  return typeof row.scorerId === "string"
    ? row.scorerId
    : typeof row.scorer_id === "string"
      ? row.scorer_id
      : undefined;
}

/** @param {RowLike} row */
function getScoredAtMs(row) {
  const value = row.scoredAtMs ?? row.scored_at_ms;
  return typeof value === "number" ? value : 0;
}

/** @param {RowLike | undefined} row */
function getScore(row) {
  return typeof row?.score === "number" ? row.score : null;
}

/**
 * @param {RowLike[]} rows
 * @param {string} nodeId
 * @param {string} [scorerId]
 */
function latestMatching(rows, nodeId, scorerId) {
  return rows
    .filter((row) => getNodeId(row) === nodeId && (!scorerId || getScorerId(row) === scorerId))
    .sort((a, b) => getScoredAtMs(b) - getScoredAtMs(a))[0];
}

/**
 * @param {RowLike[]} rows
 * @param {ComputeSidecarDeltaOptions} opts
 * @returns {SidecarDelta}
 */
export function computeSidecarDelta(rows, opts) {
  const primaryScore = getScore(latestMatching(rows, opts.primaryNodeId, opts.scorerId));
  const sidecarScore = getScore(latestMatching(rows, opts.sidecarNodeId, opts.scorerId));
  const delta = primaryScore == null || sidecarScore == null ? null : Number((primaryScore - sidecarScore).toFixed(12));
  return {
    primaryScore,
    sidecarScore,
    delta,
    cheaperWins: primaryScore != null && sidecarScore != null && sidecarScore >= primaryScore,
  };
}
