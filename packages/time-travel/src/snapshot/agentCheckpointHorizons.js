const HORIZON_VERSION = 1;
const CAPTURE_TUPLES_PER_QUERY = 250;

/** @param {string} nodeId @param {number} iteration @param {number} attempt */
export function agentCheckpointHorizonKey(nodeId, iteration, attempt) {
  return JSON.stringify([nodeId, iteration, attempt]);
}

/**
 * Capture only the attempt retained by each snapshot node. Older attempts are
 * write-fenced once a newer attempt exists; newer attempts are removed by
 * rewind/reset. Tuples keep this private metadata proportional to snapshot
 * nodes rather than checkpoint history.
 */
export async function captureAgentCheckpointHorizons(adapter, runId, nodes) {
  const targets = nodes
    .filter(
      (node) =>
        node &&
        typeof node.nodeId === "string" &&
        Number.isInteger(node.iteration) &&
        Number.isInteger(node.lastAttempt) &&
        node.lastAttempt >= 0,
    )
    .map((node) => [node.nodeId, node.iteration, node.lastAttempt]);
  if (targets.length === 0) return { version: HORIZON_VERSION, attempts: [] };
  const rows = [];
  for (let offset = 0; offset < targets.length; offset += CAPTURE_TUPLES_PER_QUERY) {
    const chunk = targets.slice(offset, offset + CAPTURE_TUPLES_PER_QUERY);
    const valuesSql = chunk.map(() => "(?, CAST(? AS BIGINT), CAST(? AS BIGINT))").join(", ");
    rows.push(
      ...(await adapter.internalStorage.queryAll(
        `WITH target(node_id, iteration, attempt) AS (VALUES ${valuesSql})
         SELECT target.node_id, target.iteration, target.attempt,
                COALESCE(MAX(checkpoint.sequence), -1) AS sequence
           FROM target
           LEFT JOIN _smithers_agent_checkpoints checkpoint
             ON checkpoint.run_id = ?
            AND checkpoint.node_id = target.node_id
            AND checkpoint.iteration = target.iteration
            AND checkpoint.attempt = target.attempt
          GROUP BY target.node_id, target.iteration, target.attempt
          ORDER BY target.node_id, target.iteration, target.attempt`,
        [...chunk.flat(), runId],
      )),
    );
  }
  return {
    version: HORIZON_VERSION,
    attempts: rows.map((row) => [
      row.nodeId ?? row.node_id,
      Number(row.iteration),
      Number(row.attempt),
      Number(row.sequence),
    ]),
  };
}

/** Return null for legacy snapshots that need timestamp filtering. */
export function parseAgentCheckpointHorizons(outputs) {
  const encoded = outputs?.__smithersAgentCheckpointHorizons;
  if (
    !encoded ||
    typeof encoded !== "object" ||
    encoded.version !== HORIZON_VERSION ||
    !Array.isArray(encoded.attempts)
  ) {
    return null;
  }
  const horizons = new Map();
  for (const tuple of encoded.attempts) {
    if (!Array.isArray(tuple) || tuple.length !== 4) return null;
    const [nodeId, iteration, attempt, sequence] = tuple;
    if (
      typeof nodeId !== "string" ||
      !Number.isInteger(iteration) ||
      !Number.isInteger(attempt) ||
      !Number.isInteger(sequence)
    )
      return null;
    horizons.set(agentCheckpointHorizonKey(nodeId, iteration, attempt), sequence);
  }
  return horizons;
}
