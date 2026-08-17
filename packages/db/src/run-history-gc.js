import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { Effect } from "effect";
import { POSTGRES, quoteIdentifier } from "./dialect.js";

const TERMINAL_RUN_STATUSES = new Set(["finished", "failed", "cancelled", "canceled", "continued"]);
const TERMINAL_STATUS_SQL = "'finished', 'failed', 'cancelled', 'canceled', 'continued'";
const DEFAULT_CHUNK_SIZE = 250;
const DEFAULT_SNAPSHOT_BATCH_SIZE = 5;

// These rows are owned by one run and have a literal run_id column. Keep this
// list explicit: memory rows merely carry provenance and must outlive retention.
const RUN_OWNED_TABLES = [
  // Delete content references before their owning attempt/snapshot rows so
  // ref-count triggers can reclaim unreferenced payloads deterministically.
  "_smithers_agent_checkpoints",
  "_smithers_agent_processes",
  "_smithers_alerts",
  "_smithers_approvals",
  "_smithers_attempts",
  "_smithers_branches",
  "_smithers_events",
  "_smithers_frames",
  "_smithers_human_requests",
  "_smithers_node_diffs",
  "_smithers_output_provenance",
  "_smithers_ralph",
  "_smithers_rewind_leases",
  "_smithers_run_usage",
  "_smithers_sandboxes",
  "_smithers_scorers",
  "_smithers_signals",
  "_smithers_snapshot_payload_refs",
  "_smithers_snapshots",
  "_smithers_steers",
  "_smithers_time_travel_audit",
  "_smithers_tool_call_archive",
  "_smithers_tool_calls",
  "_smithers_vcs_tags",
  "_smithers_workspace_checkpoints",
  "_smithers_workspace_states",
  // Nodes are last because they identify user output tables.
  "_smithers_nodes",
];

/** @param {number} value @param {string} label */
function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

/** @param {unknown} value */
function numeric(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

/** @param {string} nodesJson @param {string} outputsJson @param {string} ralphJson @param {string} inputJson */
function snapshotContentHash(nodesJson, outputsJson, ralphJson, inputJson) {
  return createHash("sha256")
    .update(`{"nodes":${nodesJson},"outputs":${outputsJson},"ralph":${ralphJson},"input":${inputJson}}`)
    .digest("hex");
}

/** @param {import("./adapter.js").SmithersDb} adapter @param {string} label @param {() => Promise<any>} operation */
function inTransaction(adapter, label, operation) {
  return adapter.withTransaction(label, Effect.promise(operation));
}

/** @param {ReturnType<import("./sql-message-storage.js").getSqlMessageStorage>} storage */
async function legacySnapshotInventory(storage) {
  const byteLength =
    storage.dialect === POSTGRES
      ? "octet_length(nodes_json) + octet_length(outputs_json) + octet_length(ralph_json) + octet_length(input_json)"
      : "length(CAST(nodes_json AS BLOB)) + length(CAST(outputs_json AS BLOB)) + length(CAST(ralph_json AS BLOB)) + length(CAST(input_json AS BLOB))";
  const row = await storage.queryOne(
    `SELECT COUNT(*) AS row_count, COALESCE(SUM(${byteLength}), 0) AS inline_bytes
       FROM _smithers_snapshots
      WHERE nodes_json <> '' OR outputs_json <> '' OR ralph_json <> '' OR input_json <> ''`,
  );
  return { rows: numeric(row?.rowCount), inlineBytes: numeric(row?.inlineBytes) };
}

/**
 * Incrementally move legacy inline snapshot payloads into content-addressed
 * storage. Each page is its own transaction, so interruption leaves only
 * complete compact rows and a later invocation resumes from inline rows.
 *
 * @param {import("./adapter.js").SmithersDb} adapter
 * @param {{ batchSize?: number; dryRun?: boolean; maxBatches?: number; signal?: AbortSignal }} [options]
 */
export async function compactLegacySnapshots(adapter, options = {}) {
  const storage = adapter.internalStorage;
  const batchSize = positiveInteger(options.batchSize ?? DEFAULT_SNAPSHOT_BATCH_SIZE, "snapshot batch size");
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
  if (!(maxBatches === Number.POSITIVE_INFINITY || (Number.isSafeInteger(maxBatches) && maxBatches >= 0))) {
    throw new Error("maxBatches must be a nonnegative integer");
  }
  if (options.dryRun) {
    const inventory = await legacySnapshotInventory(storage);
    return {
      dryRun: true,
      migratedRows: 0,
      clearedInlineBytes: 0,
      batches: 0,
      remainingRows: inventory.rows,
      remainingInlineBytes: inventory.inlineBytes,
      interrupted: false,
    };
  }

  let migratedRows = 0;
  let clearedInlineBytes = 0;
  let batches = 0;
  /** @type {{ runId: string; frameNo: number } | null} */
  let cursor = null;
  let completed = false;
  while (batches < maxBatches && !options.signal?.aborted) {
    const result = await inTransaction(adapter, "compact legacy snapshots", async () => {
      const afterCursor = cursor === null ? "" : " AND (run_id > ? OR (run_id = ? AND frame_no > ?))";
      const params = cursor === null ? [batchSize] : [cursor.runId, cursor.runId, cursor.frameNo, batchSize];
      const lock = storage.dialect === POSTGRES ? " FOR UPDATE" : "";
      const rows = await storage.queryAll(
        `SELECT run_id, frame_no, nodes_json, outputs_json, ralph_json, input_json, content_hash
           FROM _smithers_snapshots
          WHERE (nodes_json <> '' OR outputs_json <> '' OR ralph_json <> '' OR input_json <> '')
          ${afterCursor}
          ORDER BY run_id, frame_no
          LIMIT ?${lock}`,
        params,
      );
      let bytes = 0;
      for (const row of rows) {
        const nodesJson = String(row.nodesJson);
        const outputsJson = String(row.outputsJson);
        const ralphJson = String(row.ralphJson);
        const inputJson = String(row.inputJson);
        const contentHash = String(row.contentHash);
        const computedHash = snapshotContentHash(nodesJson, outputsJson, ralphJson, inputJson);
        if (computedHash !== contentHash) {
          throw new Error(
            `Legacy snapshot content hash mismatch for ${String(row.runId)} frame ${String(row.frameNo)}: expected ${contentHash}, computed ${computedHash}`,
          );
        }
        await storage.execute(
          `INSERT INTO _smithers_snapshot_contents
             (content_hash, nodes_json, outputs_json, ralph_json, input_json, ref_count)
           VALUES (?, ?, ?, ?, ?, 0)
           ON CONFLICT (content_hash) DO NOTHING`,
          [contentHash, nodesJson, outputsJson, ralphJson, inputJson],
        );
        const stored = await storage.queryOne(
          `SELECT nodes_json, outputs_json, ralph_json, input_json
             FROM _smithers_snapshot_contents WHERE content_hash = ? LIMIT 1`,
          [contentHash],
        );
        if (
          !stored ||
          stored.nodesJson !== nodesJson ||
          stored.outputsJson !== outputsJson ||
          stored.ralphJson !== ralphJson ||
          stored.inputJson !== inputJson
        ) {
          throw new Error(`Snapshot content hash collision or corruption: ${contentHash}`);
        }
        // The reference trigger requires a compact parent. Both writes are in
        // this transaction, so readers see either the old inline row or the
        // complete content-addressed row, never the state between them.
        await storage.execute(
          `UPDATE _smithers_snapshots
              SET nodes_json = '', outputs_json = '', ralph_json = '', input_json = ''
            WHERE run_id = ? AND frame_no = ?`,
          [row.runId, row.frameNo],
        );
        await storage.execute(
          `INSERT INTO _smithers_snapshot_payload_refs (run_id, frame_no, content_hash)
           VALUES (?, ?, ?)
           ON CONFLICT (run_id, frame_no) DO NOTHING`,
          [row.runId, row.frameNo, contentHash],
        );
        const reference = await storage.queryOne(
          `SELECT content_hash FROM _smithers_snapshot_payload_refs WHERE run_id = ? AND frame_no = ? LIMIT 1`,
          [row.runId, row.frameNo],
        );
        if (reference?.contentHash !== contentHash) {
          throw new Error(`Snapshot content reference mismatch for ${String(row.runId)} frame ${String(row.frameNo)}`);
        }
        bytes +=
          Buffer.byteLength(nodesJson) +
          Buffer.byteLength(outputsJson) +
          Buffer.byteLength(ralphJson) +
          Buffer.byteLength(inputJson);
      }
      const last = rows.at(-1);
      return {
        rows: rows.length,
        bytes,
        cursor: last ? { runId: String(last.runId), frameNo: numeric(last.frameNo) } : null,
      };
    });
    if (result.rows === 0) {
      completed = true;
      break;
    }
    migratedRows += result.rows;
    clearedInlineBytes += result.bytes;
    batches++;
    cursor = result.cursor;
    // Give the control plane and signal handlers a scheduling point between
    // write transactions instead of immediately reacquiring SQLite's lock.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return {
    dryRun: false,
    migratedRows,
    clearedInlineBytes,
    batches,
    remainingRows: completed ? 0 : null,
    remainingInlineBytes: completed ? 0 : null,
    interrupted: !completed,
  };
}

/** @param {ReturnType<import("./sql-message-storage.js").getSqlMessageStorage>} storage @param {string} table */
async function tableHasRunId(storage, table) {
  if (storage.dialect === POSTGRES) {
    const row = await storage.queryOne(
      `SELECT 1 AS found FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ? AND column_name = 'run_id' LIMIT 1`,
      [table],
    );
    return Boolean(row);
  }
  const row = await storage.queryOne(`SELECT 1 AS found FROM pragma_table_info(?) WHERE name = 'run_id' LIMIT 1`, [
    table,
  ]);
  return Boolean(row);
}

/** @param {ReturnType<import("./sql-message-storage.js").getSqlMessageStorage>} storage @param {string} runId */
async function outputTablesForRun(storage, runId) {
  const rows = await storage.queryAll(
    "SELECT DISTINCT output_table FROM _smithers_nodes WHERE run_id = ? AND output_table IS NOT NULL ORDER BY output_table",
    [runId],
  );
  const tables = [];
  for (const row of rows) {
    const table = String(row.outputTable);
    if (!table.startsWith("_smithers_") && (await tableHasRunId(storage, table))) tables.push(table);
  }
  return tables;
}

/** @param {unknown} status @param {unknown} finishedAtMs @param {number} cutoffMs */
function isEligible(status, finishedAtMs, cutoffMs) {
  return (
    TERMINAL_RUN_STATUSES.has(String(status).toLowerCase()) &&
    numeric(finishedAtMs) > 0 &&
    numeric(finishedAtMs) < cutoffMs
  );
}

/** @param {ReturnType<import("./sql-message-storage.js").getSqlMessageStorage>} storage @param {number} cutoffMs */
async function dryRunCandidates(storage, cutoffMs) {
  const rows = await storage.queryAll(
    "SELECT run_id, parent_run_id, status, finished_at_ms FROM _smithers_runs ORDER BY finished_at_ms, run_id",
  );
  const byParent = new Map();
  for (const row of rows) {
    if (row.parentRunId == null) continue;
    const children = byParent.get(String(row.parentRunId)) ?? [];
    children.push(row);
    byParent.set(String(row.parentRunId), children);
  }
  const memo = new Map();
  const removable = (row, visiting = new Set()) => {
    const runId = String(row.runId);
    if (memo.has(runId)) return memo.get(runId);
    if (visiting.has(runId) || !isEligible(row.status, row.finishedAtMs, cutoffMs)) return false;
    const next = new Set(visiting).add(runId);
    const result = (byParent.get(runId) ?? []).every((child) => removable(child, next));
    memo.set(runId, result);
    return result;
  };
  return rows.filter((row) => removable(row));
}

/** @param {Record<string, number>} target @param {string} table @param {number} count */
function addCount(target, table, count) {
  if (count > 0) target[table] = (target[table] ?? 0) + count;
}

/**
 * Count or delete one bounded page while rechecking terminal status and age in
 * the same statement. SQLite uses rowid and PostgreSQL uses ctid.
 * @param {import("./adapter.js").SmithersDb} adapter
 * @param {string} table
 * @param {string} runColumn
 * @param {string} runId
 * @param {number} cutoffMs
 * @param {number} chunkSize
 */
async function deleteChunk(adapter, table, runColumn, runId, cutoffMs, chunkSize) {
  const storage = adapter.internalStorage;
  const locator = storage.dialect === POSTGRES ? "ctid" : "rowid";
  const quotedTable = quoteIdentifier(table);
  const quotedColumn = quoteIdentifier(runColumn);
  return inTransaction(adapter, `retain run history ${runId}`, async () => {
    const rows = await storage.queryAll(
      `DELETE FROM ${quotedTable}
        WHERE ${locator} IN (
          SELECT ${locator} FROM ${quotedTable} WHERE ${quotedColumn} = ? LIMIT ?
        )
          AND EXISTS (
            SELECT 1 FROM _smithers_runs r
             WHERE r.run_id = ?
               AND r.status IN (${TERMINAL_STATUS_SQL})
               AND r.finished_at_ms IS NOT NULL
               AND r.finished_at_ms > 0
               AND r.finished_at_ms < ?
          )
        RETURNING 1 AS removed`,
      [runId, chunkSize, runId, cutoffMs],
    );
    return rows.length;
  });
}

/** @param {ReturnType<import("./sql-message-storage.js").getSqlMessageStorage>} storage @param {string} table @param {string} column @param {string} runId */
async function countRows(storage, table, column, runId) {
  const row = await storage.queryOne(
    `SELECT COUNT(*) AS row_count FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = ?`,
    [runId],
  );
  return numeric(row?.rowCount);
}

/**
 * Remove terminal run history older than an explicit cutoff. There is no
 * implicit retention default; callers must opt in by passing cutoffMs.
 *
 * @param {import("./adapter.js").SmithersDb} adapter
 * @param {{ cutoffMs: number; dryRun?: boolean; chunkSize?: number; maxRuns?: number; signal?: AbortSignal }} options
 * @returns {Promise<{
 *   enabled: true;
 *   dryRun: boolean;
 *   cutoffMs: number;
 *   removedRuns: Array<{ runId: string; status: unknown; finishedAtMs: number }>;
 *   rowsByTable: Record<string, number>;
 *   interrupted: boolean;
 * }>}
 */
export async function retainRunHistory(adapter, options) {
  if (!Number.isFinite(options?.cutoffMs)) throw new Error("cutoffMs is required for database retention");
  const cutoffMs = options.cutoffMs;
  const chunkSize = positiveInteger(options.chunkSize ?? DEFAULT_CHUNK_SIZE, "retention chunk size");
  const maxRuns = options.maxRuns ?? Number.POSITIVE_INFINITY;
  if (!(maxRuns === Number.POSITIVE_INFINITY || (Number.isSafeInteger(maxRuns) && maxRuns >= 0))) {
    throw new Error("maxRuns must be a nonnegative integer");
  }
  const storage = adapter.internalStorage;
  const rowsByTable = {};
  const removedRuns = [];

  if (options.dryRun) {
    const candidates = await dryRunCandidates(storage, cutoffMs);
    for (const run of candidates.slice(0, maxRuns)) {
      const runId = String(run.runId);
      for (const table of await outputTablesForRun(storage, runId)) {
        addCount(rowsByTable, table, await countRows(storage, table, "run_id", runId));
      }
      for (const table of RUN_OWNED_TABLES) {
        addCount(rowsByTable, table, await countRows(storage, table, "run_id", runId));
      }
      addCount(
        rowsByTable,
        "_smithers_eval_cases",
        await countRows(storage, "_smithers_eval_cases", "eval_run_id", runId),
      );
      addCount(rowsByTable, "_smithers_runs", 1);
      removedRuns.push({ runId, status: run.status, finishedAtMs: numeric(run.finishedAtMs) });
    }
    return { enabled: true, dryRun: true, cutoffMs, removedRuns, rowsByTable, interrupted: false };
  }

  while (removedRuns.length < maxRuns && !options.signal?.aborted) {
    // Absolute leaves only: deleting a parent would break a retained child's
    // ancestry. Once an eligible leaf is removed, its parent can become the
    // next candidate in this same invocation.
    const candidate = await storage.queryOne(
      `SELECT r.run_id, r.status, r.finished_at_ms
         FROM _smithers_runs r
        WHERE r.status IN (${TERMINAL_STATUS_SQL})
          AND r.finished_at_ms IS NOT NULL
          AND r.finished_at_ms > 0
          AND r.finished_at_ms < ?
          AND NOT EXISTS (SELECT 1 FROM _smithers_runs child WHERE child.parent_run_id = r.run_id)
        ORDER BY r.finished_at_ms, r.run_id
        LIMIT 1`,
      [cutoffMs],
    );
    if (!candidate) break;
    const runId = String(candidate.runId);
    const tables = [
      ...(await outputTablesForRun(storage, runId)).map((table) => [table, "run_id"]),
      ...RUN_OWNED_TABLES.map((table) => [table, "run_id"]),
      ["_smithers_eval_cases", "eval_run_id"],
    ];
    for (const [table, column] of tables) {
      while (!options.signal?.aborted) {
        const count = await deleteChunk(adapter, table, column, runId, cutoffMs, chunkSize);
        addCount(rowsByTable, table, count);
        if (count < chunkSize) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (options.signal?.aborted) break;
    }
    if (options.signal?.aborted) break;
    const deleted = await inTransaction(adapter, `delete retained run ${runId}`, async () =>
      storage.queryAll(
        `DELETE FROM _smithers_runs
          WHERE run_id = ?
            AND status IN (${TERMINAL_STATUS_SQL})
            AND finished_at_ms IS NOT NULL
            AND finished_at_ms > 0
            AND finished_at_ms < ?
            AND NOT EXISTS (SELECT 1 FROM _smithers_runs child WHERE child.parent_run_id = ?)
          RETURNING run_id`,
        [runId, cutoffMs, runId],
      ),
    );
    if (deleted.length === 0) break;
    addCount(rowsByTable, "_smithers_runs", 1);
    removedRuns.push({ runId, status: candidate.status, finishedAtMs: numeric(candidate.finishedAtMs) });
    adapter.clearFrameCacheForRun(runId);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return {
    enabled: true,
    dryRun: false,
    cutoffMs,
    removedRuns,
    rowsByTable,
    interrupted: Boolean(options.signal?.aborted || removedRuns.length >= maxRuns),
  };
}
