import { createHash } from "node:crypto";

const LEGACY_PROVENANCE_VERSION = 1;
const PROVENANCE_VERSION = 2;
const CAPTURE_NODES_PER_QUERY = 200;
export const MAX_SNAPSHOT_CHECKPOINT_BYTES = 16 * 1024 * 1024;
export const MAX_SNAPSHOT_CHECKPOINT_PROVENANCE_BYTES = 64 * 1024 * 1024;
export const MAX_SNAPSHOT_CHECKPOINT_ATTEMPT_BYTES = 16 * 1024 * 1024;
export const MAX_SNAPSHOT_CHECKPOINT_ATTEMPTS = 100_000;
export const MAX_SNAPSHOT_CHECKPOINT_REFS = 100_000;

const ATTEMPT_TEXT_TUPLE_INDEXES = [7, 8, 9, 11, 12, 13];

function assertWithinLimit(value, limit, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > limit) {
    throw new Error(`Snapshot agent checkpoint ${label} exceeds limit ${limit}`);
  }
}

/**
 * Capture the attempt rows and checkpoint bytes that a snapshot can observe.
 * This data lives inside the content-addressed snapshot payload, so later
 * attempt reuse and checkpoint GC cannot invalidate an older frame.
 *
 * Tuples keep the payload bounded to the snapshot-visible lineage while
 * avoiding repeated object keys for potentially large histories.
 */
export async function captureAgentCheckpointProvenance(adapter, runId, nodes) {
  const targetMap = new Map();
  for (const node of nodes
    .filter(
      (node) =>
        node &&
        typeof node.nodeId === "string" &&
        Number.isInteger(node.iteration) &&
        Number.isInteger(node.lastAttempt) &&
        node.lastAttempt >= 0,
    )
    .map((node) => [node.nodeId, node.iteration, node.lastAttempt])) {
    targetMap.set(JSON.stringify(node.slice(0, 2)), node);
  }
  const targets = [...targetMap.values()];
  const attempts = [];
  const checkpoints = [];
  const contentsByHash = new Map();
  const horizonRows = [];
  let visibleAttemptCount = 0;
  let visibleAttemptBytes = 0;
  let visibleCheckpointCount = 0;
  let visibleCheckpointBytes = 0;
  for (let offset = 0; offset < targets.length; offset += CAPTURE_NODES_PER_QUERY) {
    const chunk = targets.slice(offset, offset + CAPTURE_NODES_PER_QUERY);
    const valuesSql = chunk.map(() => "(?, CAST(? AS BIGINT), CAST(? AS BIGINT))").join(", ");
    const params = [...chunk.flat(), runId];
    const attemptTextBytes =
      adapter.internalStorage.dialect === "postgres"
        ? `octet_length(COALESCE(attempt.heartbeat_data_json, '')) +
         octet_length(COALESCE(attempt.error_json, '')) +
         octet_length(COALESCE(attempt.jj_pointer, '')) +
         octet_length(COALESCE(attempt.meta_json, '')) +
         octet_length(COALESCE(attempt.response_text, '')) +
         octet_length(COALESCE(attempt.jj_cwd, ''))`
        : `length(CAST(COALESCE(attempt.heartbeat_data_json, '') AS BLOB)) +
         length(CAST(COALESCE(attempt.error_json, '') AS BLOB)) +
         length(CAST(COALESCE(attempt.jj_pointer, '') AS BLOB)) +
         length(CAST(COALESCE(attempt.meta_json, '') AS BLOB)) +
         length(CAST(COALESCE(attempt.response_text, '') AS BLOB)) +
         length(CAST(COALESCE(attempt.jj_cwd, '') AS BLOB))`;
    const attemptStats = await adapter.internalStorage.queryOne(
      `WITH target(node_id, iteration, last_attempt) AS (VALUES ${valuesSql})
       SELECT COUNT(*) AS count, COALESCE(SUM(${attemptTextBytes}), 0) AS bytes,
              COALESCE(MAX(${attemptTextBytes}), 0) AS max_bytes
         FROM _smithers_attempts attempt
         JOIN target
           ON target.node_id = attempt.node_id
          AND target.iteration = attempt.iteration
        WHERE attempt.run_id = ?
          AND attempt.attempt <= target.last_attempt`,
      params,
    );
    visibleAttemptCount += Number(attemptStats?.count ?? 0);
    visibleAttemptBytes += Number(attemptStats?.bytes ?? 0);
    assertWithinLimit(visibleAttemptCount, MAX_SNAPSHOT_CHECKPOINT_ATTEMPTS, "attempt count");
    assertWithinLimit(visibleAttemptBytes, MAX_SNAPSHOT_CHECKPOINT_PROVENANCE_BYTES, "attempt text bytes");
    assertWithinLimit(
      Number(attemptStats?.maxBytes ?? attemptStats?.max_bytes ?? 0),
      MAX_SNAPSHOT_CHECKPOINT_ATTEMPT_BYTES,
      "attempt text size",
    );
    const checkpointTextBytes =
      adapter.internalStorage.dialect === "postgres"
        ? "octet_length(content.checkpoint_json)"
        : "length(CAST(content.checkpoint_json AS BLOB))";
    const checkpointStats = await adapter.internalStorage.queryOne(
      `WITH target(node_id, iteration, last_attempt) AS (VALUES ${valuesSql})
       SELECT COUNT(*) AS count, COALESCE(MAX(${checkpointTextBytes}), 0) AS max_bytes,
              COALESCE(SUM(CASE WHEN content.size_bytes <> ${checkpointTextBytes} THEN 1 ELSE 0 END), 0)
                AS size_mismatches
         FROM _smithers_agent_checkpoints checkpoint
         JOIN target
           ON target.node_id = checkpoint.node_id
          AND target.iteration = checkpoint.iteration
          AND checkpoint.attempt <= target.last_attempt
         JOIN _smithers_agent_checkpoint_contents content
           ON content.content_hash = checkpoint.content_hash
        WHERE checkpoint.run_id = ?`,
      params,
    );
    visibleCheckpointCount += Number(checkpointStats?.count ?? 0);
    assertWithinLimit(visibleCheckpointCount, MAX_SNAPSHOT_CHECKPOINT_REFS, "reference count");
    assertWithinLimit(
      Number(checkpointStats?.maxBytes ?? checkpointStats?.max_bytes ?? 0),
      MAX_SNAPSHOT_CHECKPOINT_BYTES,
      "content size",
    );
    if (Number(checkpointStats?.sizeMismatches ?? checkpointStats?.size_mismatches ?? 0) > 0) {
      throw new Error("Snapshot agent checkpoint content is corrupt: size metadata mismatch");
    }
    const attemptRows = await adapter.internalStorage.queryAll(
      `WITH target(node_id, iteration, last_attempt) AS (VALUES ${valuesSql})
       SELECT attempt.*
         FROM _smithers_attempts attempt
         JOIN target
           ON target.node_id = attempt.node_id
          AND target.iteration = attempt.iteration
        WHERE attempt.run_id = ?
          AND attempt.attempt <= target.last_attempt
        ORDER BY attempt.node_id, attempt.iteration, attempt.attempt${
          adapter.internalStorage.dialect === "postgres" ? " FOR SHARE OF attempt" : ""
        }`,
      params,
      { booleanColumns: ["cached"] },
    );
    for (const row of attemptRows) {
      attempts.push([
        row.nodeId ?? row.node_id,
        Number(row.iteration),
        Number(row.attempt),
        row.state,
        Number(row.startedAtMs ?? row.started_at_ms),
        (row.finishedAtMs ?? row.finished_at_ms) == null ? null : Number(row.finishedAtMs ?? row.finished_at_ms),
        (row.heartbeatAtMs ?? row.heartbeat_at_ms) == null ? null : Number(row.heartbeatAtMs ?? row.heartbeat_at_ms),
        row.heartbeatDataJson ?? row.heartbeat_data_json ?? null,
        row.errorJson ?? row.error_json ?? null,
        row.jjPointer ?? row.jj_pointer ?? null,
        Boolean(row.cached),
        row.metaJson ?? row.meta_json ?? null,
        row.responseText ?? row.response_text ?? null,
        row.jjCwd ?? row.jj_cwd ?? null,
      ]);
    }
    const checkpointRows = await adapter.internalStorage.queryAll(
      `WITH target(node_id, iteration, last_attempt) AS (VALUES ${valuesSql})
       SELECT checkpoint.*, content.checkpoint_json, content.size_bytes,
              content.created_at_ms AS content_created_at_ms
         FROM _smithers_agent_checkpoints checkpoint
         JOIN target
           ON target.node_id = checkpoint.node_id
          AND target.iteration = checkpoint.iteration
          AND checkpoint.attempt <= target.last_attempt
         JOIN _smithers_agent_checkpoint_contents content
           ON content.content_hash = checkpoint.content_hash
        WHERE checkpoint.run_id = ?
        ORDER BY checkpoint.node_id, checkpoint.iteration, checkpoint.attempt, checkpoint.sequence${
          adapter.internalStorage.dialect === "postgres" ? " FOR SHARE OF checkpoint, content" : ""
        }`,
      params,
    );
    const sequences = new Map();
    for (const row of checkpointRows) {
      const nodeId = row.nodeId ?? row.node_id;
      const iteration = Number(row.iteration);
      const attempt = Number(row.attempt);
      const sequence = Number(row.sequence);
      const checkpointJson = row.checkpointJson ?? row.checkpoint_json;
      const contentHash = row.contentHash ?? row.content_hash;
      const sizeBytes = Number(row.sizeBytes ?? row.size_bytes);
      if (
        typeof checkpointJson !== "string" ||
        Buffer.byteLength(checkpointJson, "utf8") !== sizeBytes ||
        createHash("sha256").update(checkpointJson).digest("hex") !== contentHash
      ) {
        throw new Error(`Snapshot agent checkpoint content is corrupt: ${contentHash}`);
      }
      sequences.set(JSON.stringify([nodeId, iteration, attempt]), sequence);
      checkpoints.push([
        nodeId,
        iteration,
        attempt,
        sequence,
        contentHash,
        row.codec,
        Number(row.version),
        row.agentId ?? row.agent_id ?? null,
        row.purpose,
        Number(row.createdAtMs ?? row.created_at_ms),
      ]);
      const contentTuple = [
        contentHash,
        checkpointJson,
        sizeBytes,
        Number(row.contentCreatedAtMs ?? row.content_created_at_ms),
      ];
      const priorContent = contentsByHash.get(contentHash);
      if (priorContent && JSON.stringify(priorContent) !== JSON.stringify(contentTuple)) {
        throw new Error(`Snapshot agent checkpoint content metadata conflicts for ${contentHash}`);
      }
      if (!priorContent) {
        contentsByHash.set(contentHash, contentTuple);
        visibleCheckpointBytes += sizeBytes;
        assertWithinLimit(visibleCheckpointBytes, MAX_SNAPSHOT_CHECKPOINT_PROVENANCE_BYTES, "content bytes");
        assertWithinLimit(
          visibleAttemptBytes + visibleCheckpointBytes,
          MAX_SNAPSHOT_CHECKPOINT_PROVENANCE_BYTES,
          "materialized bytes",
        );
      }
    }
    for (const [nodeId, iteration, lastAttempt] of chunk) {
      horizonRows.push([
        nodeId,
        iteration,
        lastAttempt,
        sequences.get(JSON.stringify([nodeId, iteration, lastAttempt])) ?? -1,
      ]);
    }
  }
  const provenance = {
    version: PROVENANCE_VERSION,
    attempts,
    checkpoints,
    contents: [...contentsByHash.values()],
  };
  assertWithinLimit(
    Buffer.byteLength(JSON.stringify(provenance), "utf8"),
    MAX_SNAPSHOT_CHECKPOINT_PROVENANCE_BYTES,
    "encoded bytes",
  );
  const captured = {
    horizons: { version: 1, attempts: horizonRows },
    provenance,
  };
  // Revalidate the materialized rows, not only the aggregate preflight. This
  // closes races between the stats and row reads and keeps capture and parse
  // limits symmetric.
  parseAgentCheckpointProvenance({ __smithersAgentCheckpointProvenance: provenance });
  return captured;
}

/** @param {unknown} outputs */
export function parseAgentCheckpointProvenance(outputs) {
  if (
    !outputs ||
    typeof outputs !== "object" ||
    !Object.prototype.hasOwnProperty.call(outputs, "__smithersAgentCheckpointProvenance")
  ) {
    return null;
  }
  const encoded = outputs?.__smithersAgentCheckpointProvenance;
  const isLegacy = encoded?.version === LEGACY_PROVENANCE_VERSION;
  const isSeparated = encoded?.version === PROVENANCE_VERSION && Array.isArray(encoded?.contents);
  if (
    !encoded ||
    typeof encoded !== "object" ||
    (!isLegacy && !isSeparated) ||
    !Array.isArray(encoded.attempts) ||
    !Array.isArray(encoded.checkpoints)
  ) {
    throw new Error("Snapshot agent checkpoint provenance envelope is corrupt");
  }
  assertWithinLimit(encoded.attempts.length, MAX_SNAPSHOT_CHECKPOINT_ATTEMPTS, "attempt count");
  assertWithinLimit(encoded.checkpoints.length, MAX_SNAPSHOT_CHECKPOINT_REFS, "reference count");
  assertWithinLimit(
    Buffer.byteLength(JSON.stringify(encoded), "utf8"),
    MAX_SNAPSHOT_CHECKPOINT_PROVENANCE_BYTES,
    "encoded bytes",
  );
  const attemptKeys = new Set();
  let attemptBytes = 0;
  for (const tuple of encoded.attempts) {
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 14 ||
      typeof tuple[0] !== "string" ||
      !Number.isSafeInteger(tuple[1]) ||
      tuple[1] < 0 ||
      !Number.isSafeInteger(tuple[2]) ||
      tuple[2] <= 0 ||
      typeof tuple[3] !== "string" ||
      !isNonnegativeSafeInteger(tuple[4]) ||
      !isNullableNonnegativeSafeInteger(tuple[5]) ||
      !isNullableNonnegativeSafeInteger(tuple[6]) ||
      !isNullableString(tuple[7]) ||
      !isNullableString(tuple[8]) ||
      !isNullableString(tuple[9]) ||
      typeof tuple[10] !== "boolean" ||
      !isNullableString(tuple[11]) ||
      !isNullableString(tuple[12]) ||
      !isNullableString(tuple[13])
    ) {
      throw new Error("Snapshot agent checkpoint attempt provenance is corrupt");
    }
    const key = JSON.stringify(tuple.slice(0, 3));
    if (attemptKeys.has(key)) {
      throw new Error(`Snapshot agent checkpoint attempt provenance has duplicate key ${key}`);
    }
    attemptKeys.add(key);
    const tupleBytes = ATTEMPT_TEXT_TUPLE_INDEXES.reduce(
      (total, index) => total + (typeof tuple[index] === "string" ? Buffer.byteLength(tuple[index], "utf8") : 0),
      0,
    );
    assertWithinLimit(tupleBytes, MAX_SNAPSHOT_CHECKPOINT_ATTEMPT_BYTES, "attempt text size");
    attemptBytes += tupleBytes;
    assertWithinLimit(attemptBytes, MAX_SNAPSHOT_CHECKPOINT_PROVENANCE_BYTES, "attempt text bytes");
  }
  let checkpointBytes = 0;
  const checkpointKeys = new Set();
  const contents = new Map();
  if (isSeparated) {
    assertWithinLimit(encoded.contents.length, MAX_SNAPSHOT_CHECKPOINT_REFS, "content count");
    for (const tuple of encoded.contents) {
      if (
        !Array.isArray(tuple) ||
        tuple.length !== 4 ||
        typeof tuple[0] !== "string" ||
        !/^[0-9a-f]{64}$/.test(tuple[0]) ||
        typeof tuple[1] !== "string" ||
        !isNonnegativeSafeInteger(tuple[2]) ||
        !isNonnegativeSafeInteger(tuple[3])
      ) {
        throw new Error("Snapshot agent checkpoint content provenance is corrupt");
      }
      const sizeBytes = Buffer.byteLength(tuple[1], "utf8");
      if (
        sizeBytes !== tuple[2] ||
        sizeBytes > MAX_SNAPSHOT_CHECKPOINT_BYTES ||
        createHash("sha256").update(tuple[1]).digest("hex") !== tuple[0]
      ) {
        throw new Error(`Snapshot agent checkpoint content is corrupt: ${tuple[0]}`);
      }
      if (contents.has(tuple[0])) {
        throw new Error(`Snapshot agent checkpoint content provenance has duplicate hash ${tuple[0]}`);
      }
      contents.set(tuple[0], tuple);
      checkpointBytes += sizeBytes;
      assertWithinLimit(checkpointBytes, MAX_SNAPSHOT_CHECKPOINT_PROVENANCE_BYTES, "content bytes");
      assertWithinLimit(attemptBytes + checkpointBytes, MAX_SNAPSHOT_CHECKPOINT_PROVENANCE_BYTES, "materialized bytes");
    }
  }
  const referencedHashes = new Set();
  for (const tuple of encoded.checkpoints) {
    if (
      !Array.isArray(tuple) ||
      tuple.length !== (isLegacy ? 13 : 10) ||
      typeof tuple[0] !== "string" ||
      !Number.isSafeInteger(tuple[1]) ||
      tuple[1] < 0 ||
      !Number.isSafeInteger(tuple[2]) ||
      tuple[2] <= 0 ||
      !isNonnegativeSafeInteger(tuple[3]) ||
      typeof tuple[4] !== "string" ||
      !/^[0-9a-f]{64}$/.test(tuple[4]) ||
      typeof tuple[5] !== "string" ||
      tuple[5].length === 0 ||
      !Number.isSafeInteger(tuple[6]) ||
      tuple[6] <= 0 ||
      !isNullableString(tuple[7]) ||
      typeof tuple[8] !== "string" ||
      !isNonnegativeSafeInteger(tuple[9]) ||
      (isLegacy &&
        (typeof tuple[10] !== "string" || !isNonnegativeSafeInteger(tuple[11]) || !isNonnegativeSafeInteger(tuple[12])))
    ) {
      throw new Error("Snapshot agent checkpoint reference provenance is corrupt");
    }
    if (isLegacy) {
      const sizeBytes = Buffer.byteLength(tuple[10], "utf8");
      if (
        sizeBytes !== tuple[11] ||
        sizeBytes > MAX_SNAPSHOT_CHECKPOINT_BYTES ||
        createHash("sha256").update(tuple[10]).digest("hex") !== tuple[4]
      ) {
        throw new Error(`Snapshot agent checkpoint content is corrupt: ${tuple[4]}`);
      }
      const contentMetadata = JSON.stringify([tuple[10], tuple[11], tuple[12]]);
      const priorContentMetadata = contents.get(tuple[4]);
      if (priorContentMetadata !== undefined && priorContentMetadata !== contentMetadata) {
        throw new Error(`Snapshot agent checkpoint content metadata conflicts for ${tuple[4]}`);
      }
      if (priorContentMetadata === undefined) {
        contents.set(tuple[4], contentMetadata);
        checkpointBytes += sizeBytes;
        assertWithinLimit(checkpointBytes, MAX_SNAPSHOT_CHECKPOINT_PROVENANCE_BYTES, "content bytes");
        assertWithinLimit(
          attemptBytes + checkpointBytes,
          MAX_SNAPSHOT_CHECKPOINT_PROVENANCE_BYTES,
          "materialized bytes",
        );
      }
    } else if (!contents.has(tuple[4])) {
      throw new Error(`Snapshot agent checkpoint reference content is missing: ${tuple[4]}`);
    }
    const attemptKey = JSON.stringify(tuple.slice(0, 3));
    if (!attemptKeys.has(attemptKey)) {
      throw new Error(`Snapshot agent checkpoint reference has no attempt provenance: ${attemptKey}`);
    }
    const checkpointKey = JSON.stringify(tuple.slice(0, 4));
    if (checkpointKeys.has(checkpointKey)) {
      throw new Error(`Snapshot agent checkpoint reference provenance has duplicate key ${checkpointKey}`);
    }
    checkpointKeys.add(checkpointKey);
    referencedHashes.add(tuple[4]);
  }
  if (isSeparated) {
    for (const contentHash of contents.keys()) {
      if (!referencedHashes.has(contentHash)) {
        throw new Error(`Snapshot agent checkpoint content is unreferenced: ${contentHash}`);
      }
    }
  }
  return encoded;
}

/** Materialize reference tuples for persistence and timestamp validation. */
export function materializeAgentCheckpointReferences(provenance) {
  if (provenance.version === LEGACY_PROVENANCE_VERSION) return provenance.checkpoints;
  const contents = new Map(provenance.contents.map((tuple) => [tuple[0], tuple]));
  return provenance.checkpoints.map((tuple) => {
    const content = contents.get(tuple[4]);
    if (!content) throw new Error(`Snapshot agent checkpoint reference content is missing: ${tuple[4]}`);
    return [...tuple, content[1], content[2], content[3]];
  });
}

function isNonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNullableNonnegativeSafeInteger(value) {
  return value === null || isNonnegativeSafeInteger(value);
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}
