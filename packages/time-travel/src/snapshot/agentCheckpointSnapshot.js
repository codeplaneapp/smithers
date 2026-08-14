import { parseAgentCheckpointHorizons, agentCheckpointHorizonKey } from "./agentCheckpointHorizons.js";
import {
  materializeAgentCheckpointReferences,
  MAX_SNAPSHOT_CHECKPOINT_PROVENANCE_BYTES,
  parseAgentCheckpointProvenance,
} from "./agentCheckpointProvenance.js";

function nodeKey(nodeId, iteration) {
  return JSON.stringify([nodeId, iteration]);
}

/**
 * Parse and cross-check the private checkpoint metadata embedded in a snapshot.
 * Missing properties retain compatibility with legacy snapshots. A property
 * that is present must be valid; corruption must never downgrade to a live-row
 * or timestamp fallback.
 *
 * @param {unknown} outputs
 * @param {unknown[]} nodes
 * @param {number | null | undefined} snapshotCreatedAtMs
 */
export function parseAgentCheckpointSnapshot(outputs, nodes, snapshotCreatedAtMs) {
  const provenance = parseAgentCheckpointProvenance(outputs);
  const horizons = parseAgentCheckpointHorizons(outputs);
  if (provenance === null && horizons === null) {
    return { mode: "legacy", provenance: null, horizons: null };
  }

  if (!Array.isArray(nodes)) {
    throw new Error("Snapshot agent checkpoint node provenance is corrupt");
  }
  const nodeLimits = new Map();
  for (const node of nodes) {
    if (!node || typeof node !== "object" || typeof node.nodeId !== "string") continue;
    const iteration = Number(node.iteration);
    const lastAttempt = node.lastAttempt ?? node.last_attempt;
    if (!Number.isSafeInteger(iteration) || iteration < 0) {
      throw new Error("Snapshot agent checkpoint node provenance is corrupt");
    }
    if (lastAttempt == null) continue;
    if (!Number.isSafeInteger(lastAttempt) || lastAttempt < 0) {
      throw new Error("Snapshot agent checkpoint node provenance is corrupt");
    }
    const key = nodeKey(node.nodeId, iteration);
    if (nodeLimits.has(key)) {
      throw new Error(`Snapshot agent checkpoint node provenance has duplicate key ${key}`);
    }
    nodeLimits.set(key, lastAttempt);
  }

  if (provenance) {
    for (const tuple of provenance.attempts) {
      const limit = nodeLimits.get(nodeKey(tuple[0], tuple[1]));
      if (limit === undefined || tuple[2] > limit) {
        throw new Error(
          `Snapshot agent checkpoint attempt is outside the node horizon: ${JSON.stringify(tuple.slice(0, 3))}`,
        );
      }
      if (
        (tuple[5] !== null && tuple[5] < tuple[4]) ||
        (tuple[6] !== null && tuple[6] < tuple[4]) ||
        (Number.isSafeInteger(snapshotCreatedAtMs) && tuple[4] > snapshotCreatedAtMs)
      ) {
        throw new Error(
          `Snapshot agent checkpoint attempt timestamps are outside the snapshot horizon: ${JSON.stringify(tuple.slice(0, 3))}`,
        );
      }
    }
    const attemptsByKey = new Map(provenance.attempts.map((tuple) => [JSON.stringify(tuple.slice(0, 3)), tuple]));
    for (const tuple of materializeAgentCheckpointReferences(provenance)) {
      const attempt = attemptsByKey.get(JSON.stringify(tuple.slice(0, 3)));
      if (
        !attempt ||
        tuple[9] < attempt[4] ||
        tuple[12] > tuple[9] ||
        (Number.isSafeInteger(snapshotCreatedAtMs) && tuple[9] > snapshotCreatedAtMs)
      ) {
        throw new Error(
          `Snapshot agent checkpoint reference timestamps are outside the snapshot horizon: ${JSON.stringify(tuple.slice(0, 4))}`,
        );
      }
    }
  }

  const checkpointSequenceByAttempt = new Map();
  for (const tuple of provenance?.checkpoints ?? []) {
    const key = agentCheckpointHorizonKey(tuple[0], tuple[1], tuple[2]);
    checkpointSequenceByAttempt.set(key, Math.max(checkpointSequenceByAttempt.get(key) ?? -1, tuple[3]));
  }

  if (horizons) {
    if (horizons.size !== nodeLimits.size) {
      throw new Error("Snapshot agent checkpoint horizons do not cover the snapshot node set");
    }
    for (const [key, sequence] of horizons) {
      const [nodeId, iteration, attempt] = JSON.parse(key);
      const limit = nodeLimits.get(nodeKey(nodeId, iteration));
      if (limit === undefined || attempt !== limit) {
        throw new Error(`Snapshot agent checkpoint horizon is outside the node set: ${key}`);
      }
      if (provenance) {
        const expected = checkpointSequenceByAttempt.get(key) ?? -1;
        if (sequence !== expected) {
          throw new Error(`Snapshot agent checkpoint horizon disagrees with provenance: ${key}`);
        }
      }
    }
  }

  const privateMetadata = {
    ...(provenance ? { __smithersAgentCheckpointProvenance: provenance } : {}),
    ...(horizons
      ? {
          __smithersAgentCheckpointHorizons: {
            version: 1,
            attempts: [...horizons].map(([key, sequence]) => [...JSON.parse(key), sequence]),
          },
        }
      : {}),
  };
  if (Buffer.byteLength(JSON.stringify(privateMetadata), "utf8") > MAX_SNAPSHOT_CHECKPOINT_PROVENANCE_BYTES) {
    throw new Error(
      `Snapshot agent checkpoint materialized bytes exceeds limit ${MAX_SNAPSHOT_CHECKPOINT_PROVENANCE_BYTES}`,
    );
  }

  return {
    mode: provenance ? "exact" : "horizon",
    provenance,
    horizons,
  };
}

/** Return the exact attempt key set represented by parsed provenance. */
export function agentCheckpointAttemptKeys(provenance) {
  return new Set(provenance?.attempts.map((tuple) => JSON.stringify(tuple.slice(0, 3))) ?? []);
}

/** Derive the captured sequence for one attempt from exact provenance. */
export function agentCheckpointSequenceHorizon(provenance, nodeId, iteration, attempt) {
  let sequence = -1;
  for (const tuple of provenance?.checkpoints ?? []) {
    if (tuple[0] === nodeId && tuple[1] === iteration && tuple[2] === attempt) {
      sequence = Math.max(sequence, tuple[3]);
    }
  }
  return sequence;
}

export { agentCheckpointHorizonKey };
