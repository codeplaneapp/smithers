const SQLITE_BIND_BUDGET = 800;
const POSTGRES_BIND_BUDGET = 60_000;
const BATCH_PAYLOAD_BYTES = 16 * 1024 * 1024;

function bindBudget(storage) {
  return storage.dialect === "postgres" ? POSTGRES_BIND_BUDGET : SQLITE_BIND_BUDGET;
}

function utf8Bytes(value) {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}

function chunkRows(storage, rows, columnCount, rowBytes = () => 0, reservedBinds = 0) {
  const maxRows = Math.max(1, Math.floor((bindBudget(storage) - reservedBinds) / columnCount));
  const chunks = [];
  let current = [];
  let bytes = 0;
  for (const row of rows) {
    const nextBytes = rowBytes(row);
    if (current.length > 0 && (current.length >= maxRows || bytes + nextBytes > BATCH_PAYLOAD_BYTES)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += nextBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function valuesSql(rows, columns) {
  return rows.map(() => `(${Array.from({ length: columns }, () => "?").join(", ")})`).join(", ");
}

function attemptKeyValuesSql(storage, rows) {
  if (storage.dialect !== "postgres") return valuesSql(rows, 3);
  return rows.map(() => `(CAST(? AS TEXT), CAST(? AS BIGINT), CAST(? AS BIGINT))`).join(", ");
}

function attemptKeyRow(row) {
  return [row.nodeId, row.iteration, row.attempt];
}

function checkpointKeyRow(row) {
  return [row.nodeId, row.iteration, row.attempt, row.sequence];
}

function checkpointKeyValuesSql(storage, rows) {
  if (storage.dialect !== "postgres") return valuesSql(rows, 4);
  return rows.map(() => `(CAST(? AS TEXT), CAST(? AS BIGINT), CAST(? AS BIGINT), CAST(? AS BIGINT))`).join(", ");
}

/** Convert one V1 attempt tuple into the storage row used by rewind/fork. */
export function agentCheckpointAttemptRow(tuple, runId, metaJson = tuple[11]) {
  return {
    runId,
    nodeId: tuple[0],
    iteration: tuple[1],
    attempt: tuple[2],
    state: tuple[3],
    startedAtMs: tuple[4],
    finishedAtMs: tuple[5],
    heartbeatAtMs: tuple[6],
    heartbeatDataJson: tuple[7],
    errorJson: tuple[8],
    jjPointer: tuple[9],
    cached: tuple[10],
    metaJson,
    responseText: tuple[12],
    jjCwd: tuple[13],
  };
}

/** Convert one V1 checkpoint tuple into a materializable reference row. */
export function agentCheckpointReferenceRow(tuple, runId) {
  return {
    runId,
    nodeId: tuple[0],
    iteration: tuple[1],
    attempt: tuple[2],
    sequence: tuple[3],
    contentHash: tuple[4],
    codec: tuple[5],
    version: tuple[6],
    agentId: tuple[7],
    purpose: tuple[8],
    createdAtMs: tuple[9],
    checkpointJson: tuple[10],
    sizeBytes: tuple[11],
    contentCreatedAtMs: tuple[12],
  };
}

async function deleteRefsMissingFromSnapshot(storage, runId, attempts, checkpoints) {
  const scopes = [...new Map(attempts.map((row) => [JSON.stringify(attemptKeyRow(row)), attemptKeyRow(row)])).values()];
  const desired = new Map(checkpoints.map((row) => [JSON.stringify(checkpointKeyRow(row)), row.contentHash]));
  const stale = [];
  for (const chunk of chunkRows(storage, scopes, 3, undefined, 1)) {
    const rows = await storage.queryAll(
      `WITH scoped(node_id, iteration, attempt) AS (VALUES ${attemptKeyValuesSql(storage, chunk)})
       SELECT checkpoint.node_id, checkpoint.iteration, checkpoint.attempt,
              checkpoint.sequence, checkpoint.content_hash
         FROM _smithers_agent_checkpoints checkpoint
         JOIN scoped
           ON scoped.node_id = checkpoint.node_id
          AND scoped.iteration = checkpoint.iteration
          AND scoped.attempt = checkpoint.attempt
        WHERE checkpoint.run_id = ?
        ORDER BY checkpoint.node_id, checkpoint.iteration, checkpoint.attempt, checkpoint.sequence${
          storage.dialect === "postgres" ? " FOR UPDATE OF checkpoint" : ""
        }`,
      [...chunk.flat(), runId],
    );
    for (const row of rows) {
      const key = [row.nodeId ?? row.node_id, Number(row.iteration), Number(row.attempt), Number(row.sequence)];
      if (desired.get(JSON.stringify(key)) !== (row.contentHash ?? row.content_hash)) stale.push(key);
    }
  }
  for (const chunk of chunkRows(storage, stale, 4, undefined, 1)) {
    await storage.execute(
      `WITH doomed(node_id, iteration, attempt, sequence) AS (VALUES ${checkpointKeyValuesSql(storage, chunk)})
       DELETE FROM _smithers_agent_checkpoints
        WHERE run_id = ?
          AND EXISTS (
            SELECT 1 FROM doomed
             WHERE doomed.node_id = _smithers_agent_checkpoints.node_id
               AND doomed.iteration = _smithers_agent_checkpoints.iteration
               AND doomed.attempt = _smithers_agent_checkpoints.attempt
               AND doomed.sequence = _smithers_agent_checkpoints.sequence
          )`,
      [...chunk.flat(), runId],
    );
  }
}

/** Delete explicit attempt primary keys in conservative VALUES batches. */
export async function deleteAgentCheckpointAttemptsByKeys(adapter, runId, keys) {
  const storage = adapter.internalStorage;
  const unique = [...new Map(keys.map((key) => [JSON.stringify(key), key])).values()];
  for (const chunk of chunkRows(storage, unique, 3, undefined, 1)) {
    await storage.execute(
      `WITH doomed(node_id, iteration, attempt) AS (VALUES ${attemptKeyValuesSql(storage, chunk)})
       DELETE FROM _smithers_attempts
        WHERE run_id = ?
          AND EXISTS (
            SELECT 1 FROM doomed
             WHERE doomed.node_id = _smithers_attempts.node_id
               AND doomed.iteration = _smithers_attempts.iteration
               AND doomed.attempt = _smithers_attempts.attempt
          )`,
      [...chunk.flat(), runId],
    );
  }
}

async function upsertAttempts(storage, attempts) {
  const columns = 15;
  const rowBytes = (row) =>
    utf8Bytes(row.heartbeatDataJson) +
    utf8Bytes(row.errorJson) +
    utf8Bytes(row.jjPointer) +
    utf8Bytes(row.metaJson) +
    utf8Bytes(row.responseText) +
    utf8Bytes(row.jjCwd);
  for (const chunk of chunkRows(storage, attempts, columns, rowBytes)) {
    const params = chunk.flatMap((row) => [
      row.runId,
      row.nodeId,
      row.iteration,
      row.attempt,
      row.state,
      row.startedAtMs,
      row.finishedAtMs,
      row.heartbeatAtMs,
      row.heartbeatDataJson,
      row.errorJson,
      row.jjPointer,
      row.cached,
      row.metaJson,
      row.responseText,
      row.jjCwd,
    ]);
    await storage.execute(
      `INSERT INTO _smithers_attempts
         (run_id, node_id, iteration, attempt, state, started_at_ms, finished_at_ms,
          heartbeat_at_ms, heartbeat_data_json, error_json, jj_pointer, cached,
          meta_json, response_text, jj_cwd)
       VALUES ${valuesSql(chunk, columns)}
       ON CONFLICT (run_id, node_id, iteration, attempt) DO UPDATE SET
         state = excluded.state,
         started_at_ms = excluded.started_at_ms,
         finished_at_ms = excluded.finished_at_ms,
         heartbeat_at_ms = excluded.heartbeat_at_ms,
         heartbeat_data_json = excluded.heartbeat_data_json,
         error_json = excluded.error_json,
         jj_pointer = excluded.jj_pointer,
         cached = excluded.cached,
         meta_json = excluded.meta_json,
         response_text = excluded.response_text,
         jj_cwd = excluded.jj_cwd`,
      params,
    );
  }
}

async function materializeAndLockContents(storage, checkpoints) {
  const byHash = new Map();
  for (const row of checkpoints) {
    if (typeof row.checkpointJson === "string") {
      byHash.set(row.contentHash, {
        contentHash: row.contentHash,
        checkpointJson: row.checkpointJson,
        sizeBytes: row.sizeBytes,
        createdAtMs: row.contentCreatedAtMs,
      });
    }
  }
  const contents = [...byHash.values()].sort((a, b) => a.contentHash.localeCompare(b.contentHash));
  const locked = new Set();
  for (const chunk of chunkRows(storage, contents, 4, (row) => utf8Bytes(row.checkpointJson))) {
    const params = chunk.flatMap((row) => [row.contentHash, row.checkpointJson, row.sizeBytes, row.createdAtMs]);
    let stored;
    if (storage.dialect === "postgres") {
      // PostgreSQL locks a conflicting row even when the DO UPDATE predicate
      // is false, but does not create a new tuple version. This preserves the
      // collector/publication serialization point without generating a dead
      // immutable-content tuple for every fork or rewind.
      await storage.execute(
        `INSERT INTO _smithers_agent_checkpoint_contents
           (content_hash, checkpoint_json, size_bytes, created_at_ms)
         VALUES ${valuesSql(chunk, 4)}
         ON CONFLICT (content_hash) DO UPDATE
         SET checkpoint_json = excluded.checkpoint_json
         WHERE FALSE`,
        params,
      );
      stored = await storage.queryAll(
        `SELECT content_hash, checkpoint_json, size_bytes
           FROM _smithers_agent_checkpoint_contents
          WHERE content_hash IN (${chunk.map(() => "?").join(", ")})
          ORDER BY content_hash FOR KEY SHARE`,
        chunk.map((row) => row.contentHash),
      );
    } else {
      await storage.execute(
        `INSERT INTO _smithers_agent_checkpoint_contents
           (content_hash, checkpoint_json, size_bytes, created_at_ms)
         VALUES ${valuesSql(chunk, 4)}
         ON CONFLICT (content_hash) DO NOTHING`,
        params,
      );
      stored = await storage.queryAll(
        `SELECT content_hash, checkpoint_json, size_bytes
           FROM _smithers_agent_checkpoint_contents
          WHERE content_hash IN (${chunk.map(() => "?").join(", ")})
          ORDER BY content_hash`,
        chunk.map((row) => row.contentHash),
      );
    }
    const expected = new Map(chunk.map((row) => [row.contentHash, row]));
    for (const row of stored) {
      const contentHash = row.contentHash ?? row.content_hash;
      const wanted = expected.get(contentHash);
      if (
        !wanted ||
        (row.checkpointJson ?? row.checkpoint_json) !== wanted.checkpointJson ||
        Number(row.sizeBytes ?? row.size_bytes) !== wanted.sizeBytes
      ) {
        throw new Error(`Checkpoint content hash collision or corruption: ${contentHash}`);
      }
      locked.add(contentHash);
    }
    if (stored.length !== chunk.length) {
      throw new Error("Checkpoint content materialization did not return every requested hash");
    }
  }

  const remaining = [...new Set(checkpoints.map((row) => row.contentHash))].filter((hash) => !locked.has(hash)).sort();
  for (const chunk of chunkRows(storage, remaining, 1)) {
    const rows = await storage.queryAll(
      `SELECT content_hash
         FROM _smithers_agent_checkpoint_contents
        WHERE content_hash IN (${chunk.map(() => "?").join(", ")})
        ORDER BY content_hash${storage.dialect === "postgres" ? " FOR KEY SHARE" : ""}`,
      chunk,
    );
    if (rows.length !== chunk.length) {
      throw new Error("Checkpoint content referenced by legacy snapshot is missing");
    }
  }
}

async function upsertCheckpointRefs(storage, checkpoints) {
  const columns = 11;
  for (const chunk of chunkRows(storage, checkpoints, columns)) {
    const params = chunk.flatMap((row) => [
      row.runId,
      row.nodeId,
      row.iteration,
      row.attempt,
      row.sequence,
      row.contentHash,
      row.codec,
      row.version,
      row.agentId,
      row.purpose,
      row.createdAtMs,
    ]);
    await storage.execute(
      `INSERT INTO _smithers_agent_checkpoints
         (run_id, node_id, iteration, attempt, sequence, content_hash,
          codec, version, agent_id, purpose, created_at_ms)
       VALUES ${valuesSql(chunk, columns)}
       ON CONFLICT (run_id, node_id, iteration, attempt, sequence) DO UPDATE SET
         content_hash = excluded.content_hash,
         codec = excluded.codec,
         version = excluded.version,
         agent_id = excluded.agent_id,
         purpose = excluded.purpose,
         created_at_ms = excluded.created_at_ms`,
      params,
    );
  }
}

/**
 * Restore/copy attempt rows, content, and references with bounded SQL calls.
 * The caller owns the surrounding transaction.
 */
export async function persistAgentCheckpointRows(adapter, input) {
  const storage = adapter.internalStorage;
  if (input.replaceCheckpointRefs === true) {
    await deleteRefsMissingFromSnapshot(storage, input.runId, input.attempts, input.checkpoints);
  }
  await upsertAttempts(storage, input.attempts);
  await materializeAndLockContents(storage, input.checkpoints);
  await upsertCheckpointRefs(storage, input.checkpoints);
}

export const AGENT_CHECKPOINT_SQLITE_BIND_BUDGET = SQLITE_BIND_BUDGET;
