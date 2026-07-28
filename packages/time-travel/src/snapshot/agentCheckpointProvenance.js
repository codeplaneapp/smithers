import { createHash } from "node:crypto";

const PROVENANCE_VERSION = 1;
const CAPTURE_NODES_PER_QUERY = 200;
export const MAX_SNAPSHOT_CHECKPOINT_BYTES = 16 * 1024 * 1024;
export const MAX_SNAPSHOT_CHECKPOINT_PROVENANCE_BYTES = 64 * 1024 * 1024;
export const MAX_SNAPSHOT_CHECKPOINT_ATTEMPT_BYTES = 16 * 1024 * 1024;
export const MAX_SNAPSHOT_CHECKPOINT_ATTEMPTS = 100_000;
export const MAX_SNAPSHOT_CHECKPOINT_REFS = 100_000;

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
  const attempts = [];
  const checkpoints = [];
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
       SELECT COUNT(*) AS count, COALESCE(SUM(${checkpointTextBytes}), 0) AS bytes,
              COALESCE(MAX(${checkpointTextBytes}), 0) AS max_bytes,
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
    visibleCheckpointBytes += Number(checkpointStats?.bytes ?? 0);
    assertWithinLimit(visibleCheckpointCount, MAX_SNAPSHOT_CHECKPOINT_REFS, "reference count");
    assertWithinLimit(visibleCheckpointBytes, MAX_SNAPSHOT_CHECKPOINT_PROVENANCE_BYTES, "content bytes");
    assertWithinLimit(
      visibleAttemptBytes + visibleCheckpointBytes,
      MAX_SNAPSHOT_CHECKPOINT_PROVENANCE_BYTES,
      "materialized bytes",
    );
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
        ORDER BY attempt.node_id, attempt.iteration, attempt.attempt`,
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
        ORDER BY checkpoint.node_id, checkpoint.iteration, checkpoint.attempt, checkpoint.sequence`,
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
        checkpointJson,
        sizeBytes,
        Number(row.contentCreatedAtMs ?? row.content_created_at_ms),
      ]);
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
  const provenance = { version: PROVENANCE_VERSION, attempts, checkpoints };
  assertWithinLimit(
    Buffer.byteLength(JSON.stringify(provenance), "utf8"),
    MAX_SNAPSHOT_CHECKPOINT_PROVENANCE_BYTES,
    "encoded bytes",
  );
  return {
    horizons: { version: 1, attempts: horizonRows },
    provenance,
  };
}

/** @param {unknown} outputs */
export function parseAgentCheckpointProvenance(outputs) {
  const encoded = outputs?.__smithersAgentCheckpointProvenance;
  if (
    !encoded ||
    typeof encoded !== "object" ||
    encoded.version !== PROVENANCE_VERSION ||
    !Array.isArray(encoded.attempts) ||
    !Array.isArray(encoded.checkpoints)
  )
    return null;
  assertWithinLimit(encoded.attempts.length, MAX_SNAPSHOT_CHECKPOINT_ATTEMPTS, "attempt count");
  assertWithinLimit(encoded.checkpoints.length, MAX_SNAPSHOT_CHECKPOINT_REFS, "reference count");
  assertWithinLimit(
    Buffer.byteLength(JSON.stringify(encoded), "utf8"),
    MAX_SNAPSHOT_CHECKPOINT_PROVENANCE_BYTES,
    "encoded bytes",
  );
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
  }
  let checkpointBytes = 0;
  for (const tuple of encoded.checkpoints) {
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 13 ||
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
      typeof tuple[10] !== "string" ||
      !isNonnegativeSafeInteger(tuple[11]) ||
      !isNonnegativeSafeInteger(tuple[12])
    ) {
      throw new Error("Snapshot agent checkpoint reference provenance is corrupt");
    }
    const sizeBytes = Buffer.byteLength(tuple[10], "utf8");
    if (
      sizeBytes !== tuple[11] ||
      sizeBytes > MAX_SNAPSHOT_CHECKPOINT_BYTES ||
      createHash("sha256").update(tuple[10]).digest("hex") !== tuple[4]
    ) {
      throw new Error(`Snapshot agent checkpoint content is corrupt: ${tuple[4]}`);
    }
    checkpointBytes += sizeBytes;
    assertWithinLimit(checkpointBytes, MAX_SNAPSHOT_CHECKPOINT_PROVENANCE_BYTES, "content bytes");
  }
  return encoded;
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
