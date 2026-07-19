import { Effect, Metric } from "effect";
import * as BunContext from "@effect/platform-bun/BunContext";
import { getJjPointer, revertToJjPointer } from "@smithers-orchestrator/vcs/jj";
import {
  rewindTotal,
  rewindRollbackTotal,
  rewindDurationMs,
  rewindFramesDeleted,
  rewindSandboxesReverted,
} from "@smithers-orchestrator/observability/metrics";
import { JUMP_RUN_ID_PATTERN } from "./JUMP_RUN_ID_PATTERN.js";
import { JUMP_MAX_FRAME_NO } from "./JUMP_MAX_FRAME_NO.js";
import { JumpToFrameError } from "./JumpToFrameError.js";
import { isRunLikelyLive } from "./isRunLikelyLive.js";
import { validateJumpRunId } from "./validateJumpRunId.js";
import { validateJumpFrameNo } from "./validateJumpFrameNo.js";
import { acquireRewindLock } from "./acquireRewindLock.js";
import { evaluateRewindRateLimit } from "./evaluateRewindRateLimit.js";
import { writeRewindAuditRow } from "./writeRewindAuditRow.js";
import { updateRewindAuditRow } from "./updateRewindAuditRow.js";
import { loadSnapshot } from "./snapshot/index.js";

export { JUMP_RUN_ID_PATTERN };
export { JUMP_MAX_FRAME_NO };
export { JumpToFrameError };
export { validateJumpRunId };
export { validateJumpFrameNo };

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/observability/SmithersEvent").SmithersEvent} SmithersEvent */
/** @typedef {import("./JumpResult.ts").JumpResult} JumpResult */
/** @typedef {import("./JumpToFrameInput.ts").JumpToFrameInput} JumpToFrameInput */
/** @typedef {import("./JumpStepName.ts").JumpStepName} JumpStepName */

const OUTPUT_TABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function asString(value) {
  return typeof value === "string" ? value : null;
}

/**
 * Portable SQL seam. Every rewind mutation runs through the adapter's
 * dialect-agnostic {@link SmithersDb.internalStorage} (the same layer the
 * adapter's own methods use), so rewind works on bun:sqlite, PostgreSQL, and
 * PGlite alike. `?` placeholders are rewritten to `$n` for PostgreSQL and
 * snake_case columns are returned camelCased by the storage layer.
 *
 * @param {SmithersDb} adapter
 * @returns {SmithersDb["internalStorage"]}
 */
function resolveStorage(adapter) {
  const storage = adapter?.internalStorage;
  if (!storage || typeof storage.execute !== "function") {
    throw new JumpToFrameError(
      "RewindFailed",
      "Rewind requires a SmithersDb backed by internalStorage; none was resolved from the adapter.",
    );
  }
  return storage;
}

/**
 * @param {string} identifier
 */
function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * @param {JumpToFrameInput["onLog"]} logger
 * @param {"info" | "warn" | "error"} level
 * @param {string} message
 * @param {Record<string, unknown>} [fields]
 */
async function emitLog(logger, level, message, fields = {}) {
  if (!logger) {
    return;
  }
  try {
    await logger(level, message, fields);
  } catch {
    // logging failures must never derail the RPC
  }
}

/**
 * Run a segment of work inside a tracing span. We deliberately attach the
 * span annotation via {@link Effect.withSpan} while preserving native JS
 * error identity: if the inner promise rejects we re-throw the original
 * error object so callers can match on `.code`, `.details`, etc. This
 * mirrors the pattern used by `getNodeOutputRoute`/`streamDevToolsRoute`.
 *
 * @template T
 * @param {string} spanName
 * @param {Record<string, unknown>} attrs
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withSpan(spanName, attrs, run) {
  /** @type {T | undefined} */
  let result;
  /** @type {unknown} */
  let captured = undefined;
  let failed = false;
  const effect = Effect.tryPromise({
    try: async () => {
      try {
        result = await run();
      } catch (error) {
        captured = error;
        failed = true;
      }
    },
    catch: (error) => error,
  }).pipe(Effect.withSpan(spanName, { attributes: attrs }));
  try {
    await Effect.runPromise(effect);
  } catch {
    // Swallow: the real thrown error is re-surfaced below so we preserve
    // the original Error object (and its `.code`).
  }
  if (failed) {
    throw captured;
  }
  return /** @type {T} */ (result);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeCaller(value) {
  if (typeof value !== "string") {
    return "unknown";
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 256) : "unknown";
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<{ frameNo: number; createdAtMs: number; xmlJson: string } | null>}
 */
async function readLatestFrame(adapter, runId) {
  const latest = await adapter.getLastFrame(runId);
  if (!latest) {
    return null;
  }
  return {
    frameNo: Number(latest.frameNo),
    createdAtMs: Number(latest.createdAtMs),
    xmlJson: String(latest.xmlJson ?? "{}"),
  };
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @returns {Promise<{ frameNo: number; createdAtMs: number; xmlJson: string } | null>}
 */
async function readFrameByNo(adapter, runId, frameNo) {
  const row = /** @type {Record<string, unknown> | undefined} */ (
    await resolveStorage(adapter).queryOne(
      `SELECT frame_no, created_at_ms, xml_json
         FROM _smithers_frames
        WHERE run_id = ? AND frame_no = ?
        LIMIT 1`,
      [runId, frameNo],
    )
  );
  if (!row) {
    return null;
  }
  return {
    frameNo: Number(row.frameNo),
    createdAtMs: Number(row.createdAtMs),
    xmlJson: String(row.xmlJson ?? "{}"),
  };
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @returns {Promise<{ found: boolean; nodes: Array<Record<string, unknown>>; outputs: Record<string, Array<Record<string, unknown>>> }>}
 */
async function readTargetSnapshotSets(adapter, runId, frameNo) {
  const row = await loadSnapshot(adapter, runId, frameNo);
  if (!row) return { found: false, nodes: [], outputs: {} };
  return {
    found: true,
    nodes: JSON.parse(row.nodesJson),
    outputs: JSON.parse(row.outputsJson),
  };
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} targetFrameNo
 */
async function countFramesAfter(adapter, runId, targetFrameNo) {
  const row = /** @type {Record<string, unknown> | undefined} */ (
    await resolveStorage(adapter).queryOne(
      `SELECT COUNT(*) AS count
         FROM _smithers_frames
        WHERE run_id = ? AND frame_no > ?`,
      [runId, targetFrameNo],
    )
  );
  return Number(row?.count ?? 0);
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} cutoffMs
 */
async function deleteAttemptsStartedAfter(adapter, runId, cutoffMs) {
  await resolveStorage(adapter).deleteWhere(
    "_smithers_attempts",
    "run_id = ? AND started_at_ms > ?",
    [runId, cutoffMs],
  );
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {Array<{ nodeId: string; iteration: number }>} nodeKeys
 * @param {number} nowMs
 */
async function resetNodesToPending(adapter, runId, nodeKeys, nowMs) {
  if (nodeKeys.length === 0) {
    return;
  }
  const storage = resolveStorage(adapter);
  for (const key of nodeKeys) {
    await storage.execute(
      `UPDATE _smithers_nodes
          SET state = ?,
              last_attempt = NULL,
              updated_at_ms = ?
        WHERE run_id = ?
          AND node_id = ?
          AND iteration = ?`,
      ["pending", nowMs, runId, key.nodeId, key.iteration],
    );
  }
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function readNodeOutputTableMap(adapter, runId) {
  const rows = await adapter.listNodes(runId);
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const row of rows) {
    if (typeof row?.nodeId !== "string") {
      continue;
    }
    const iteration = Number(row?.iteration ?? 0);
    const outputTable = asString(row?.outputTable);
    if (!outputTable || outputTable.length === 0) {
      continue;
    }
    map.set(`${row.nodeId}::${iteration}`, outputTable);
  }
  return map;
}

/**
 * @param {SmithersDb} adapter
 * @param {Array<{ tableName: string; nodeId: string; iteration: number }>} targets
 * @param {string} runId
 */
async function deleteOutputTargets(adapter, targets, runId) {
  if (targets.length === 0) {
    return 0;
  }
  const storage = resolveStorage(adapter);
  let deleted = 0;
  for (const target of targets) {
    if (!OUTPUT_TABLE_PATTERN.test(target.tableName)) {
      continue;
    }
    const tableSql = quoteIdentifier(target.tableName);
    try {
      const countRow = /** @type {Record<string, unknown> | undefined} */ (
        await storage.queryOne(
          `SELECT COUNT(*) AS count
             FROM ${tableSql}
            WHERE run_id = ? AND node_id = ? AND iteration = ?`,
          [runId, target.nodeId, target.iteration],
        )
      );
      deleted += Number(countRow?.count ?? 0);
      await storage.execute(
        `DELETE FROM ${tableSql}
          WHERE run_id = ? AND node_id = ? AND iteration = ?`,
        [runId, target.nodeId, target.iteration],
      );
    } catch (error) {
      const message = formatError(error);
      // SQLite: "no such table"; PostgreSQL: "relation ... does not exist".
      if (/no such table|does not exist/i.test(message)) {
        continue;
      }
      throw error;
    }
  }
  return deleted;
}

/** @param {SmithersDb} adapter @param {string} runId @param {Record<string, Array<Record<string, unknown>>>} snapshotOutputs */
async function restoreOutputSet(adapter, runId, snapshotOutputs) {
  const storage = resolveStorage(adapter);
  const physicalTableRows = adapter.internalStorage?.dialect === "postgres"
    ? await storage.queryAll("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name NOT LIKE '_smithers_%' ORDER BY table_name")
    : await storage.queryAll("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_smithers_%' ORDER BY name");
  const physicalTables = new Set(physicalTableRows.map((row) => asString(row.name)).filter(Boolean));
  const resolveTable = (name) => physicalTables.has(name) ? name : [...physicalTables].find((candidate) => candidate === name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
  const rowsByPhysical = new Map();
  for (const [name, rows] of Object.entries(snapshotOutputs)) {
    if (!Array.isArray(rows)) continue;
    const physical = resolveTable(name);
    if (physical) rowsByPhysical.set(physical, [...(rowsByPhysical.get(physical) ?? []), ...rows]);
  }
  const tables = await storage.queryAll(`SELECT DISTINCT output_table FROM _smithers_nodes WHERE run_id = ?`, [runId]);
  const tableNames = new Set(tables.map((entry) => {
    const name = asString(entry.outputTable ?? entry.output_table);
    return name ? (resolveTable(name) ?? name) : undefined;
  }).filter((name) => name && OUTPUT_TABLE_PATTERN.test(name)));
  for (const name of rowsByPhysical.keys()) if (OUTPUT_TABLE_PATTERN.test(name)) tableNames.add(name);
  let deleted = 0;
  for (const tableName of tableNames) {
    if (!(await adapter.hasPhysicalTable(tableName))) continue;
    const snapshotRows = rowsByPhysical.get(tableName) ?? [];
    const keep = new Set(snapshotRows.map((row) => `${row.nodeId ?? row.node_id}::${Number(row.iteration ?? 0)}`));
    let rows;
    try {
      rows = await storage.queryAll(`SELECT node_id, iteration FROM ${quoteIdentifier(tableName)} WHERE run_id = ?`, [runId]);
    } catch (error) {
      if (/no such table|does not exist/i.test(formatError(error))) continue;
      throw error;
    }
    const desired = new Map(snapshotRows.map((row) => [`${row.nodeId ?? row.node_id}::${Number(row.iteration ?? 0)}`, row]));
    for (const row of rows) {
      const key = `${row.nodeId ?? row.node_id}::${Number(row.iteration ?? 0)}`;
      if (!desired.has(key)) {
        await storage.execute(`DELETE FROM ${quoteIdentifier(tableName)} WHERE run_id = ? AND node_id = ? AND iteration = ?`, [runId, row.nodeId ?? row.node_id, Number(row.iteration ?? 0)]);
        deleted += 1;
      }
    }
    // Restore overwritten payloads as well as deletions. The snapshot is the
    // source of truth, so a post-target upsert cannot survive by sharing a key.
    for (const [key, row] of desired) {
      const [nodeId, iterationText] = key.split("::");
      const { __smithersProvenanceSeq: provenanceSeq, ...snapshotRow } = row;
      const values = { ...snapshotRow, runId, nodeId, iteration: Number(iterationText) };
      try {
        await storage.upsert(tableName, values, ["runId", "nodeId", "iteration"]);
        if (Number.isFinite(Number(provenanceSeq))) {
          await storage.upsert("_smithers_output_provenance", {
            runId,
            outputTable: tableName,
            nodeId,
            iteration: Number(iterationText),
            seq: Number(provenanceSeq),
          }, ["runId", "outputTable", "nodeId", "iteration"]);
        }
      } catch (error) {
        if (/no such table|does not exist/i.test(formatError(error))) continue;
        throw error;
      }
    }
  }
  const predicates = [];
  const params = [];
  for (const tableName of tableNames) for (const row of (rowsByPhysical.get(tableName) ?? [])) {
    predicates.push("(output_table = ? AND node_id = ? AND iteration = ?)");
    params.push(tableName, row.nodeId ?? row.node_id, Number(row.iteration ?? 0));
  }
  if (predicates.length) await storage.execute(`DELETE FROM _smithers_output_provenance WHERE run_id = ? AND NOT (${predicates.join(" OR ")})`, [runId, ...params]);
  else await storage.execute(`DELETE FROM _smithers_output_provenance WHERE run_id = ?`, [runId]);
  // Signals use the same run-local provenance clock. Snapshot output rows
  // carry the clock value through JSON, so the durable signal inbox is
  // rewound to the same horizon rather than leaking post-target events.
  const outputHorizon = Object.values(snapshotOutputs)
    .filter((rows) => Array.isArray(rows))
    .flatMap((rows) => rows)
    .map((row) => Number(row.__smithersProvenanceSeq))
    .filter(Number.isFinite)
    .reduce((max, seq) => Math.max(max, seq), -1);
  const horizon = Number.isFinite(Number(snapshotOutputs.__smithersSignalProvenanceHorizon))
    ? Number(snapshotOutputs.__smithersSignalProvenanceHorizon)
    : outputHorizon;
  await storage.execute(`DELETE FROM _smithers_signals WHERE run_id = ? AND seq > ?`, [runId, horizon]);
  return deleted;
}

/** Restore the exact node set represented by the target snapshot. */
async function restoreNodeSet(adapter, runId, snapshotNodes) {
  const storage = resolveStorage(adapter);
  const desired = new Map(snapshotNodes.map((node) => [`${node.nodeId ?? node.node_id}::${Number(node.iteration ?? 0)}`, node]));
  const current = await storage.queryAll(`SELECT node_id, iteration FROM _smithers_nodes WHERE run_id = ?`, [runId]);
  for (const node of current) {
    const key = `${node.nodeId ?? node.node_id}::${Number(node.iteration ?? 0)}`;
    if (!desired.has(key)) await storage.execute(`DELETE FROM _smithers_nodes WHERE run_id = ? AND node_id = ? AND iteration = ?`, [runId, node.nodeId ?? node.node_id, Number(node.iteration ?? 0)]);
  }
  for (const node of desired.values()) await storage.upsert("_smithers_nodes", {
    ...node,
    runId,
    updatedAtMs: Number(node.updatedAtMs ?? node.updated_at_ms ?? Date.now()),
  }, ["runId", "nodeId", "iteration"]);
}

/** Attempts are not part of the public snapshot; trim them to each target node's lastAttempt. */
async function restoreAttemptsToNodeSnapshot(adapter, runId, snapshotNodes) {
  const storage = resolveStorage(adapter);
  const limits = new Map(snapshotNodes.map((node) => [`${node.nodeId ?? node.node_id}::${Number(node.iteration ?? 0)}`, node.lastAttempt ?? node.last_attempt]));
  const attempts = await storage.queryAll(`SELECT node_id, iteration, attempt FROM _smithers_attempts WHERE run_id = ?`, [runId]);
  for (const attempt of attempts) {
    const key = `${attempt.nodeId ?? attempt.node_id}::${Number(attempt.iteration ?? 0)}`;
    const limit = limits.get(key);
    if (limit == null || Number(attempt.attempt) > Number(limit)) await storage.execute(`DELETE FROM _smithers_attempts WHERE run_id = ? AND node_id = ? AND iteration = ? AND attempt = ?`, [runId, attempt.nodeId ?? attempt.node_id, Number(attempt.iteration ?? 0), Number(attempt.attempt)]);
  }
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} nowMs
 * @param {string} reason
 */
async function markRunNeedsAttention(adapter, runId, nowMs, reason) {
  const payload = JSON.stringify({
    code: "RewindFailed",
    needsAttention: true,
    message: reason,
    timestampMs: nowMs,
  });
  try {
    await adapter.updateRun(runId, {
      status: "needs_attention",
      finishedAtMs: nowMs,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      errorJson: payload,
    });
    return;
  } catch {
    // Older status enums may not accept `needs_attention`; fall back while preserving intent in errorJson.
  }
  await adapter.updateRun(runId, {
    status: "failed",
    finishedAtMs: nowMs,
    heartbeatAtMs: null,
    runtimeOwnerId: null,
    errorJson: payload,
  });
}

/**
 * @param {string} pointer
 * @param {string | undefined} cwd
 */
async function defaultRevertToPointer(pointer, cwd) {
  return await Effect.runPromise(
    revertToJjPointer(pointer, cwd).pipe(Effect.provide(BunContext.layer)),
  );
}

/**
 * @param {string | undefined} cwd
 */
async function defaultGetCurrentPointer(cwd) {
  return await Effect.runPromise(
    getJjPointer(cwd).pipe(Effect.provide(BunContext.layer)),
  );
}

/**
 * @param {JumpToFrameInput["hooks"]} hooks
 * @param {"before" | "after"} stage
 * @param {JumpStepName} step
 */
async function runStepHook(hooks, stage, step) {
  if (!hooks) {
    return;
  }
  if (stage === "before" && hooks.beforeStep) {
    await hooks.beforeStep(step);
  }
  if (stage === "after" && hooks.afterStep) {
    await hooks.afterStep(step);
  }
}

/**
 * @param {Array<{ cwd: string; targetPointer: string; previousPointer: string | null }>} revertedSandboxes
 * @param {(pointer: string, cwd?: string) => Promise<{ success: boolean; error?: string }>} revertToPointerImpl
 * @returns {Promise<Array<{ cwd: string; error: string }>>}
 */
async function rollbackSandboxPointers(revertedSandboxes, revertToPointerImpl) {
  /** @type {Array<{ cwd: string; error: string }>} */
  const failures = [];
  for (let index = revertedSandboxes.length - 1; index >= 0; index -= 1) {
    const sandbox = revertedSandboxes[index];
    if (typeof sandbox.previousPointer !== "string" || sandbox.previousPointer.length === 0) {
      failures.push({ cwd: sandbox.cwd, error: "Missing pre-jump pointer." });
      continue;
    }
    const restored = await revertToPointerImpl(sandbox.previousPointer, sandbox.cwd);
    if (!restored.success) {
      failures.push({
        cwd: sandbox.cwd,
        error: restored.error ?? "Failed to restore sandbox pointer.",
      });
    }
  }
  return failures;
}

/** @typedef {import("@smithers-orchestrator/db").AttemptRow} AttemptRow */

/**
 * @param {ReadonlyArray<AttemptRow>} attemptsForRun
 * @param {ReadonlyArray<AttemptRow>} attemptsToDelete
 * @param {number} cutoffMs
 * @param {(cwd?: string) => Promise<string | null>} getCurrentPointerImpl
 * @returns {Promise<Array<{ cwd: string; targetPointer: string; previousPointer: string | null }>>}
 */
async function planSandboxReverts(
  attemptsForRun,
  attemptsToDelete,
  cutoffMs,
  getCurrentPointerImpl,
) {
  /** @type {Map<string, { cwd: string; targetPointer: string; previousPointer: string | null }>} */
  const byCwd = new Map();
  const affectedCwds = new Set(
    attemptsToDelete
      .map((attempt) => (typeof attempt?.jjCwd === "string" ? attempt.jjCwd : ""))
      .filter((cwd) => cwd.length > 0),
  );

  for (const cwd of affectedCwds) {
    const beforeAttempts = attemptsForRun.filter(
      (attempt) =>
        attempt?.jjCwd === cwd &&
        typeof attempt?.jjPointer === "string" &&
        attempt.jjPointer.length > 0 &&
        Number(attempt?.startedAtMs ?? -1) <= cutoffMs,
    );
    const targetAttempt = beforeAttempts[beforeAttempts.length - 1];
    if (!targetAttempt || typeof targetAttempt.jjPointer !== "string") {
      throw new JumpToFrameError(
        "UnsupportedSandbox",
        `Could not resolve a rewind pointer for sandbox cwd ${cwd}.`,
      );
    }
    const previousPointer = await getCurrentPointerImpl(cwd);
    byCwd.set(cwd, {
      cwd,
      targetPointer: targetAttempt.jjPointer,
      previousPointer,
    });
  }

  return [...byCwd.values()];
}

/**
 * Rewind a run to a previous frame and make it resumable from that point.
 *
 * @param {JumpToFrameInput} input
 * @returns {Promise<JumpResult>}
 */
export async function jumpToFrame(input) {
  const nowMs = input.nowMs ?? (() => Date.now());
  const startedAtMs = nowMs();
  const caller = normalizeCaller(input.caller);

  let runIdForAudit = typeof input.runId === "string" ? input.runId : "invalid-run-id";
  let fromFrameNoForAudit = -1;
  let toFrameNoForAudit = Number.isInteger(input.frameNo) ? Number(input.frameNo) : -1;
  /** @type {"success" | "failed" | "partial"} */
  let auditResult = "failed";

  /** @type {JumpResult | null} */
  let successResult = null;
  /** @type {JumpToFrameError | null} */
  let finalError = null;

  let lock = null;
  /** @type {number | null} */
  let auditRowId = null;
  let canWriteAudit = false;

  try {
    return await withSpan(
      "timetravel.jumpToFrame",
      {
        runId: typeof input.runId === "string" ? input.runId : "",
        caller,
        toFrameNo: typeof input.frameNo === "number" ? input.frameNo : -1,
      },
      async () => {
        const runId = validateJumpRunId(input.runId);
        const targetFrameNo = validateJumpFrameNo(input.frameNo);
        runIdForAudit = runId;
        toFrameNoForAudit = targetFrameNo;

        if (input.confirm !== true) {
          throw new JumpToFrameError(
            "ConfirmationRequired",
            "jumpToFrame is destructive; pass confirm: true to proceed.",
          );
        }

        lock = await withSpan(
          "timetravel.lock.acquire",
          { runId },
          async () => {
            const handle = await acquireRewindLock(input.adapter, runId);
            if (!handle) {
              throw new JumpToFrameError(
                "Busy",
                `Another jumpToFrame is already running for ${runId}.`,
              );
            }
            return handle;
          },
        );

        // The durable lease is held before any rewind state is loaded, so a
        // contender cannot plan mutations from a snapshot being invalidated.
        const run = await input.adapter.getRun(runId);
        if (!run) {
          throw new JumpToFrameError("RunNotFound", `Run not found: ${runId}`);
        }
        if (
          input.force !== true &&
          run.status === "running" &&
          isRunLikelyLive(run, nowMs())
        ) {
          throw new JumpToFrameError(
            "RunOwnerAlive",
            `Run ${runId} is still running (live owner or fresh heartbeat). Stop it before rewinding, or pass force: true.`,
            {
              details: {
                runId,
                runtimeOwnerId: run.runtimeOwnerId ?? null,
                heartbeatAtMs: run.heartbeatAtMs ?? null,
              },
            },
          );
        }
        canWriteAudit = true;

        const rateLimit = await evaluateRewindRateLimit({
          adapter: input.adapter,
          runId,
          caller,
          nowMs,
          maxPerWindow: input.rateLimit?.maxPerWindow,
          windowMs: input.rateLimit?.windowMs,
        });
        if (rateLimit.limited) {
          throw new JumpToFrameError(
            "RateLimited",
            `Rewind quota exceeded for ${runId}; max ${rateLimit.max} per ${Math.floor(
              rateLimit.windowMs / 60_000,
            )}m.`,
          );
        }

        // Durable in_progress audit row is written BEFORE any mutation so a
        // process kill leaves a marker for startup recovery.
        auditRowId = await withSpan(
          "timetravel.db.audit.insert",
          { runId, caller, state: "in_progress" },
          async () =>
            await writeRewindAuditRow(input.adapter, {
              runId,
              fromFrameNo: fromFrameNoForAudit,
              toFrameNo: targetFrameNo,
              caller,
              timestampMs: startedAtMs,
              result: "in_progress",
              durationMs: null,
            }),
        );

        const latestFrame = await readLatestFrame(input.adapter, runId);
        if (!latestFrame) {
          throw new JumpToFrameError("FrameOutOfRange", `Run ${runId} has no frames.`);
        }
        fromFrameNoForAudit = latestFrame.frameNo;

        if (targetFrameNo > latestFrame.frameNo) {
          throw new JumpToFrameError(
            "FrameOutOfRange",
            `frameNo must be between 0 and ${latestFrame.frameNo}.`,
          );
        }

        const targetFrame = await readFrameByNo(input.adapter, runId, targetFrameNo);
        if (!targetFrame) {
          throw new JumpToFrameError(
            "FrameOutOfRange",
            `Frame ${targetFrameNo} does not exist for run ${runId}.`,
          );
        }

        await emitLog(input.onLog, "info", "jumpToFrame started", {
          runId,
          fromFrameNo: latestFrame.frameNo,
          toFrameNo: targetFrameNo,
          caller,
        });

        if (targetFrameNo === latestFrame.frameNo) {
          auditResult = "success";
          successResult = {
            ok: true,
            newFrameNo: targetFrameNo,
            revertedSandboxes: 0,
            deletedFrames: 0,
            deletedAttempts: 0,
            invalidatedDiffs: 0,
            durationMs: Math.max(0, nowMs() - startedAtMs),
          };
          return successResult;
        }

        await runStepHook(input.hooks, "before", "snapshot-pre-jump");
        const attemptsForRun = await input.adapter.listAttemptsForRun(runId);
        const targetSnapshotSets = await readTargetSnapshotSets(input.adapter, runId, targetFrameNo);
        const attemptsToDelete = attemptsForRun.filter(
          (attempt) => Number(attempt?.startedAtMs ?? -1) > targetFrame.createdAtMs,
        );
        const getCurrentPointerImpl = input.getCurrentPointerImpl ?? defaultGetCurrentPointer;
        const revertToPointerImpl = input.revertToPointerImpl ?? defaultRevertToPointer;
        const sandboxPlan = await planSandboxReverts(
          attemptsForRun,
          attemptsToDelete,
          targetFrame.createdAtMs,
          getCurrentPointerImpl,
        );

        const reconcilerSnapshot = await withSpan(
          "timetravel.snapshot.preJump",
          { runId, sandboxes: sandboxPlan.length },
          async () =>
            input.captureReconcilerState ? await input.captureReconcilerState() : null,
        );
        await runStepHook(input.hooks, "after", "snapshot-pre-jump");

        /** @type {Array<{ cwd: string; targetPointer: string; previousPointer: string | null }>} */
        const revertedSandboxes = [];
        let paused = false;
        // Set true the instant the durable jump transaction commits. After that
        // point a failure (resume loop / hook) must NOT roll back sandboxes,
        // restore the reconciler, or mark the run failed: the rewind already
        // succeeded and is committed.
        let committed = false;

        try {
          await runStepHook(input.hooks, "before", "pause-event-loop");
          if (input.pauseRunLoop) {
            await input.pauseRunLoop();
          }
          paused = true;
          await runStepHook(input.hooks, "after", "pause-event-loop");

          await runStepHook(input.hooks, "before", "revert-sandboxes");
          for (const sandbox of sandboxPlan) {
            if (!(await lock.renew())) {
              throw new JumpToFrameError(
                "Busy",
                `Rewind lease ownership was lost for ${runId} before reverting sandboxes.`,
              );
            }
            const reverted = await withSpan(
              "timetravel.vcs.revert.target",
              { cwd: sandbox.cwd, pointer: sandbox.targetPointer },
              async () => revertToPointerImpl(sandbox.targetPointer, sandbox.cwd),
            );
            if (!reverted.success) {
              throw new JumpToFrameError(
                "VcsError",
                reverted.error ?? `Failed to revert sandbox cwd ${sandbox.cwd}.`,
                {
                  details: {
                    cwd: sandbox.cwd,
                    pointer: sandbox.targetPointer,
                  },
                },
              );
            }
            revertedSandboxes.push(sandbox);
          }
          await runStepHook(input.hooks, "after", "revert-sandboxes");

          const deletedFrames = await countFramesAfter(input.adapter, runId, targetFrameNo);
          const deletedAttempts = attemptsToDelete.length;

          const outputTableMap = await readNodeOutputTableMap(input.adapter, runId);
          /** @type {Map<string, { tableName: string; nodeId: string; iteration: number }>} */
          const outputTargetsMap = new Map();
          /** @type {Map<string, { nodeId: string; iteration: number }>} */
          const nodeResetMap = new Map();
          for (const attempt of attemptsToDelete) {
            const nodeId = asString(attempt?.nodeId);
            if (!nodeId) {
              continue;
            }
            const iteration = Number(attempt?.iteration ?? 0);
            const key = `${nodeId}::${iteration}`;
            nodeResetMap.set(key, { nodeId, iteration });
            const tableName = outputTableMap.get(key);
            if (!tableName) {
              continue;
            }
            outputTargetsMap.set(`${tableName}:${key}`, {
              tableName,
              nodeId,
              iteration,
            });
          }

          // Durable mutation: frames/attempts/outputs/diffs/reconciler/run-status/event
          // all commit together or roll back together. If the event insert throws
          // the frames truncation is reverted too, so DB is never left mutated
          // without an audit/event record.
          if (!(await lock.renew())) {
            throw new JumpToFrameError(
              "Busy",
              `Rewind lease ownership was lost for ${runId} before database mutation.`,
            );
          }
          const dbStats = await input.adapter.withTransaction(
                `jump to frame ${runId}:${targetFrameNo}`,
                Effect.gen(function* () {
                  // Fence the DB mutation with the lease row in this same
                  // transaction. PostgreSQL holds the updated row lock until
                  // commit, so an expiry-based takeover cannot begin while the
                  // destructive transaction is still running.
                  yield* Effect.promise(async () => {
                    const storage = resolveStorage(input.adapter);
                    const rows = await storage.queryAllRaw(
                      `UPDATE _smithers_rewind_leases
                          SET expires_at_ms = expires_at_ms
                        WHERE run_id = ?
                          AND owner_token = ?
                          AND expires_at_ms > ?
                      RETURNING owner_token`,
                      [runId, lock.ownerToken, Date.now()],
                    );
                    const ownerToken = rows[0]?.owner_token ?? rows[0]?.ownerToken;
                    if (ownerToken !== lock.ownerToken) {
                      throw new JumpToFrameError(
                        "Busy",
                        `Rewind lease ownership was lost for ${runId} during database mutation.`,
                      );
                    }
                  });

                  // Invalidate node-diff cache BEFORE we truncate frames /
                  // attempts: the adapter hook computes which diffs are beyond
                  // the target by looking at the frame/attempt join, and that
                  // only works while frames/attempts are still intact.
                  yield* Effect.promise(() =>
                    runStepHook(input.hooks, "before", "invalidate-diffs"),
                  );
                  const invalidatedDiffs = yield* input.adapter
                    .invalidateNodeDiffsAfterFrame(runId, targetFrameNo);
                  yield* Effect.promise(() =>
                    runStepHook(input.hooks, "after", "invalidate-diffs"),
                  );

                  yield* Effect.promise(() =>
                    runStepHook(input.hooks, "before", "truncate-frames"),
                  );
                  yield* input.adapter.deleteFramesAfter(runId, targetFrameNo);
                  // Snapshots and vcs-tags are keyed (run_id, frame_no) and are
                  // the fork/hydration source; truncate them atomically with the
                  // frames or fork/replay/timeline can read discarded state.
                  yield* input.adapter.deleteSnapshotsAfter(runId, targetFrameNo);
                  yield* input.adapter.deleteVcsTagsAfter(runId, targetFrameNo);
                  yield* Effect.promise(() =>
                    runStepHook(input.hooks, "after", "truncate-frames"),
                  );

                  yield* Effect.promise(() =>
                    runStepHook(input.hooks, "before", "truncate-attempts"),
                  );
                  yield* Effect.promise(() =>
                    deleteAttemptsStartedAfter(
                      input.adapter,
                      runId,
                      targetFrame.createdAtMs,
                    ),
                  );
                  yield* Effect.promise(() =>
                    runStepHook(input.hooks, "after", "truncate-attempts"),
                  );

                  yield* Effect.promise(() =>
                    runStepHook(input.hooks, "before", "truncate-outputs"),
                  );
                  if (!targetSnapshotSets.found) {
                    yield* Effect.logWarning("rewind using legacy heuristic because the target has no exact snapshot").pipe(Effect.annotateLogs({ runId, targetFrameNo }));
                  }
                  const deletedOutputs = yield* Effect.promise(() =>
                    targetSnapshotSets.found
                      ? restoreOutputSet(input.adapter, runId, targetSnapshotSets.outputs)
                      : deleteOutputTargets(input.adapter, [...outputTargetsMap.values()], runId),
                  );
                  if (targetSnapshotSets.found) {
                    yield* Effect.promise(() => restoreNodeSet(input.adapter, runId, targetSnapshotSets.nodes));
                    yield* Effect.promise(() => restoreAttemptsToNodeSnapshot(input.adapter, runId, targetSnapshotSets.nodes));
                  }
                  yield* Effect.promise(() =>
                    runStepHook(input.hooks, "after", "truncate-outputs"),
                  );

                  yield* Effect.promise(() =>
                    runStepHook(input.hooks, "before", "rebuild-reconciler"),
                  );
                  if (input.rebuildReconcilerState) {
                    yield* Effect.promise(() =>
                      input.rebuildReconcilerState?.(targetFrame.xmlJson),
                    );
                  }
                  yield* Effect.promise(() =>
                    runStepHook(input.hooks, "after", "rebuild-reconciler"),
                  );

                  if (!targetSnapshotSets.found) {
                    yield* Effect.promise(() => resetNodesToPending(input.adapter, runId, [...nodeResetMap.values()], nowMs()));
                  }

                  yield* input.adapter.updateRun(runId, {
                    status: "running",
                    finishedAtMs: null,
                    heartbeatAtMs: null,
                    runtimeOwnerId: null,
                    cancelRequestedAtMs: null,
                    hijackRequestedAtMs: null,
                    hijackTarget: null,
                    errorJson: null,
                  });

                  // Persist the TimeTravelJumped event inside the same
                  // transaction so frames/attempts truncation and audit/event
                  // rows commit atomically — there is no partial durable state.
                  const event = {
                    type: "TimeTravelJumped",
                    runId,
                    fromFrameNo: latestFrame.frameNo,
                    toFrameNo: targetFrameNo,
                    timestampMs: nowMs(),
                    caller,
                  };
                  // Insert the event row via raw SQL inside the enclosing
                  // transaction. We deliberately avoid `insertEventWithNextSeq`
                  // here because it opens its own transaction and would error
                  // out nested. internalStorage runs on the same connection as
                  // the open transaction, so this participates in the commit.
                  yield* Effect.promise(async () => {
                    const storage = resolveStorage(input.adapter);
                    const seqRow = /** @type {Record<string, unknown> | undefined} */ (
                      await storage.queryOne(
                        `SELECT COALESCE(MAX(seq), -1) + 1 AS seq
                           FROM _smithers_events
                          WHERE run_id = ?`,
                        [runId],
                      )
                    );
                    const seq = Number(seqRow?.seq ?? 0);
                    await storage.execute(
                      `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
                       VALUES (?, ?, ?, ?, ?)`,
                      [runId, seq, event.timestampMs, event.type, JSON.stringify(event)],
                    );
                    return seq;
                  });

                  return {
                    deletedFrames,
                    deletedAttempts,
                    deletedOutputs,
                    invalidatedDiffs,
                    event,
                  };
                }),
          );

          // The durable jump is committed. Mark success and build the result up
          // front so any post-commit failure below cannot discard the rewind.
          committed = true;
          auditResult = "success";
          successResult = {
            ok: true,
            newFrameNo: targetFrameNo,
            revertedSandboxes: sandboxPlan.length,
            deletedFrames: dbStats.deletedFrames,
            deletedAttempts: dbStats.deletedAttempts,
            invalidatedDiffs: dbStats.invalidatedDiffs,
            durationMs: Math.max(0, nowMs() - startedAtMs),
          };

          // In-memory broadcast is non-fatal: the durable event row is already
          // committed, so subscribers can reconcile from seq on reconnect.
          if (input.emitEvent) {
            try {
              await withSpan(
                "timetravel.eventbus.emit",
                { runId, type: "TimeTravelJumped" },
                async () =>
                  input.emitEvent?.(/** @type {SmithersEvent} */ (dbStats.event)),
              );
            } catch (emitError) {
              await emitLog(input.onLog, "warn", "jumpToFrame emit broadcast failed", {
                runId,
                caller,
                error: formatError(emitError),
              });
            }
          }

          await runStepHook(input.hooks, "before", "resume-event-loop");
          if (input.resumeRunLoop) {
            await input.resumeRunLoop();
          }
          paused = false;
          await runStepHook(input.hooks, "after", "resume-event-loop");

          await emitLog(input.onLog, "info", "jumpToFrame succeeded", {
            runId,
            caller,
            fromFrameNo: latestFrame.frameNo,
            toFrameNo: targetFrameNo,
            revertedSandboxes: sandboxPlan.length,
            deletedFrames: dbStats.deletedFrames,
            deletedAttempts: dbStats.deletedAttempts,
            deletedOutputs: dbStats.deletedOutputs,
            invalidatedDiffs: dbStats.invalidatedDiffs,
            durationMs: successResult.durationMs,
          });

          return successResult;
        } catch (error) {
          if (committed) {
            // The durable jump already committed. A post-commit failure (resume
            // loop or hook) must not revert sandboxes, restore the reconciler, or
            // mark the run failed. Resume best-effort, log, and return success.
            if (paused) {
              try {
                await input.resumeRunLoop?.();
              } catch (resumeError) {
                await emitLog(input.onLog, "warn", "jumpToFrame resume after commit failed", {
                  runId,
                  caller,
                  error: formatError(resumeError),
                });
              }
            }
            await emitLog(input.onLog, "warn", "jumpToFrame post-commit step failed", {
              runId,
              caller,
              error: formatError(error),
            });
            return /** @type {JumpResult} */ (successResult);
          }
          const rollbackSandboxErrors = await rollbackSandboxPointers(
            revertedSandboxes,
            revertToPointerImpl,
          );
          let rollbackReconcilerError = null;
          if (input.restoreReconcilerState) {
            try {
              await input.restoreReconcilerState(reconcilerSnapshot);
            } catch (restoreError) {
              rollbackReconcilerError = formatError(restoreError);
            }
          }

          if (paused) {
            try {
              await input.resumeRunLoop?.();
            } catch (resumeError) {
              rollbackSandboxErrors.push({
                cwd: "<event-loop>",
                error: formatError(resumeError),
              });
            }
          }

          if (rollbackSandboxErrors.length > 0 || rollbackReconcilerError) {
            auditResult = "partial";
            const now = nowMs();
            const reason = [
              `rollback sandbox failures=${rollbackSandboxErrors.length}`,
              rollbackReconcilerError ? `reconciler=${rollbackReconcilerError}` : null,
            ]
              .filter(Boolean)
              .join("; ");
            await markRunNeedsAttention(
              input.adapter,
              runId,
              now,
              reason || "Rewind rollback was partial.",
            );
            finalError = new JumpToFrameError(
              "RewindFailed",
              "Rewind failed and rollback was only partial; run needs attention.",
              {
                details: {
                  cause: formatError(error),
                  rollbackSandboxErrors,
                  rollbackReconcilerError,
                },
              },
            );
            await emitLog(input.onLog, "warn", "jumpToFrame rollback partial", {
              runId,
              caller,
              rollbackSandboxErrors,
              rollbackReconcilerError,
            });
          } else {
            finalError =
              error instanceof JumpToFrameError
                ? error
                : new JumpToFrameError("RewindFailed", formatError(error));
          }

          throw finalError;
        }
      },
    );
  } catch (error) {
    if (!finalError) {
      finalError =
        error instanceof JumpToFrameError
          ? error
          : new JumpToFrameError("RewindFailed", formatError(error));
    }
  } finally {
    const durationMs = Math.max(0, nowMs() - startedAtMs);

    // Persist the terminal audit state BEFORE releasing the lock so a second
    // caller cannot beat us to the rate-limit count.
    try {
      if (auditRowId !== null) {
        await updateRewindAuditRow(input.adapter, {
          id: auditRowId,
          result: auditResult,
          durationMs,
          fromFrameNo: fromFrameNoForAudit,
        });
      } else if (canWriteAudit) {
        // The run exists but we threw before reaching the in_progress write.
        // Still record the attempt for auditability.
        await writeRewindAuditRow(input.adapter, {
          runId: runIdForAudit,
          fromFrameNo: fromFrameNoForAudit,
          toFrameNo: toFrameNoForAudit,
          caller,
          timestampMs: startedAtMs,
          result: auditResult,
          durationMs,
        });
      }
      if (auditRowId !== null || canWriteAudit) {
        await emitLog(input.onLog, "info", "jumpToFrame audit row written", {
          runId: runIdForAudit,
          fromFrameNo: fromFrameNoForAudit,
          toFrameNo: toFrameNoForAudit,
          caller,
          result: auditResult,
        });
      }
    } catch (auditError) {
      await emitLog(input.onLog, "error", "jumpToFrame audit write failed", {
        runId: runIdForAudit,
        fromFrameNo: fromFrameNoForAudit,
        toFrameNo: toFrameNoForAudit,
        caller,
        result: auditResult,
        error: formatError(auditError),
      });
      if (!finalError) {
        finalError = new JumpToFrameError(
          "RewindFailed",
          "Failed to persist rewind audit row.",
        );
      }
    }

    if (lock) {
      try {
        await lock.release();
      } catch (releaseError) {
        await emitLog(input.onLog, "error", "jumpToFrame lease release failed", {
          runId: runIdForAudit,
          error: formatError(releaseError),
        });
      }
    }

    let metricResultTag = "failed";
    if (auditResult === "success") {
      metricResultTag = "success";
    } else if (auditResult === "partial") {
      metricResultTag = "partial";
    } else if (finalError?.code === "Busy") {
      metricResultTag = "busy";
    } else if (finalError?.code === "RateLimited") {
      metricResultTag = "rate_limited";
    }
    try {
      await Effect.runPromise(
        Effect.all([
          Metric.increment(Metric.tagged(rewindTotal, "result", metricResultTag)),
          Metric.update(rewindDurationMs, durationMs),
        ]),
      );
      if (successResult) {
        await Effect.runPromise(
          Effect.all([
            Metric.update(rewindFramesDeleted, successResult.deletedFrames),
            Metric.update(rewindSandboxesReverted, successResult.revertedSandboxes),
          ]),
        );
      }
      if (auditResult === "partial") {
        await Effect.runPromise(Metric.increment(rewindRollbackTotal));
      }
    } catch {
      // metrics failures must never fail the RPC
    }

    // Emit a final `error` log for VcsError/RewindFailed failures so operators
    // always see a crash in the log stream (complementing the partial-rollback
    // and audit-write logs emitted above).
    if (
      finalError &&
      (finalError.code === "VcsError" ||
        finalError.code === "RewindFailed" ||
        finalError.code === "UnsupportedSandbox")
    ) {
      await emitLog(input.onLog, "error", "jumpToFrame failed", {
        runId: runIdForAudit,
        fromFrameNo: fromFrameNoForAudit,
        toFrameNo: toFrameNoForAudit,
        caller,
        code: finalError.code,
        message: finalError.message,
      });
    }
  }

  if (finalError) {
    throw finalError;
  }

  if (!successResult) {
    throw new JumpToFrameError("RewindFailed", "jumpToFrame completed without a result.");
  }

  return successResult;
}
