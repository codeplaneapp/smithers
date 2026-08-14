import { Effect } from "effect";
import { nowMs } from "@smthrs/scheduler/nowMs";
import { SmithersError } from "@smthrs/errors/SmithersError";

/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smthrs/observability/SmithersEvent").SmithersEvent} SmithersEvent */
/** @typedef {import("./CrossedEffect.ts").CrossedEffect} CrossedEffect */
/** @typedef {import("./EffectBoundaryReport.ts").EffectBoundaryReport} EffectBoundaryReport */
/** @typedef {import("./EffectHandlerRegistry.ts").EffectHandlerRegistry} EffectHandlerRegistry */

/**
 * @param {string | null | undefined} value
 * @returns {unknown}
 */
function parseJson(value) {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * @param {SmithersDb} db
 * @param {string} runId
 * @param {CrossedEffect} effect
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function loadLiveRow(db, runId, effect) {
  return (
    (await db.internalStorage.queryOne(
      `SELECT * FROM _smithers_tool_calls
      WHERE run_id = ? AND node_id = ? AND iteration = ? AND attempt = ? AND seq = ?`,
      [runId, effect.nodeId, effect.iteration, effect.attempt, effect.seq],
      { booleanColumns: ["sideEffect", "idempotent", "acceptsIdempotencyKey", "hasRevert"] },
    )) ?? null
  );
}

/**
 * @param {SmithersDb} db
 * @param {string} runId
 * @param {CrossedEffect} effect
 * @param {Record<string, unknown>} patch
 */
async function updateRow(db, runId, effect, patch) {
  await Effect.runPromise(db.updateToolCall(runId, effect.nodeId, effect.iteration, effect.attempt, effect.seq, patch));
}

/**
 * @param {SmithersDb} db
 * @param {string} runId
 * @param {CrossedEffect} effect
 * @param {Record<string, unknown>} patch
 * @returns {Promise<number>}
 */
async function finishRevertingRow(db, runId, effect, patch) {
  return await db.internalStorage.updateWhere(
    "_smithers_tool_calls",
    patch,
    `run_id = ? AND node_id = ? AND iteration = ? AND attempt = ? AND seq = ?
      AND revert_status = ?`,
    [runId, effect.nodeId, effect.iteration, effect.attempt, effect.seq, "reverting"],
  );
}

/**
 * @param {{
 *   runId: string;
 *   operation: string;
 *   report: EffectBoundaryReport;
 * }} params
 * @param {CrossedEffect} effect
 * @param {Record<string, unknown> | null} row
 * @param {unknown} [cause]
 * @returns {SmithersError}
 */
function changedRevertStateError(params, effect, row, cause) {
  const revertStatus = row?.revertStatus ?? "missing";
  const reason =
    revertStatus === "revert-stale"
      ? "The original call completed while compensation was running, so the revert is stale."
      : `The effect row changed to revert status ${String(revertStatus)} while compensation was running.`;
  const failedReport = {
    ...params.report,
    blocking: [
      ...params.report.blocking,
      {
        ...effect,
        effectStatus: "unknown",
        reason,
      },
    ],
    revertible: params.report.revertible.filter((candidate) => candidate !== effect),
  };
  return new SmithersError(
    "TIME_TRAVEL_SIDE_EFFECT_BLOCKED",
    `Time travel is blocked because compensation for ${effect.kind} ${effect.toolName} became stale.`,
    { runId: params.runId, operation: params.operation, report: failedReport },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * @param {SmithersDb} db
 * @param {SmithersEvent} event
 * @param {((event: SmithersEvent) => void) | undefined} onProgress
 */
async function emitEvent(db, event, onProgress) {
  await Effect.runPromise(
    db.insertEventWithNextSeq({
      runId: event.runId,
      timestampMs: event.timestampMs,
      type: event.type,
      payloadJson: JSON.stringify(event),
    }),
  );
  onProgress?.(event);
}

/**
 * Run resolved compensation handlers in reverse chronological order. Each
 * effect row is journaled before and after its handler. A failure aborts with
 * the boundary report and leaves all history intact.
 *
 * @param {SmithersDb} db
 * @param {{
 *   runId: string;
 *   operation: string;
 *   report: EffectBoundaryReport;
 *   registry: EffectHandlerRegistry;
 *   checkStillHeld?: () => Promise<boolean>;
 *   onProgress?: (event: SmithersEvent) => void;
 * }} params
 * @returns {Promise<EffectBoundaryReport>}
 */
export async function executeEffectReverts(db, params) {
  const effects = [...params.report.revertible].sort(
    (left, right) => right.startedAtMs - left.startedAtMs || right.attempt - left.attempt || right.seq - left.seq,
  );
  for (const effect of effects) {
    const effectRunId = effect.runId || params.runId;
    if (params.checkStillHeld && !(await params.checkStillHeld())) {
      throw new Error(
        `Time-travel lease ownership was lost for ${params.runId} before compensating ${effect.kind} ${effect.kind === "tool" ? effect.toolName : effect.nodeId}.`,
      );
    }
    const row = await loadLiveRow(db, effectRunId, effect);
    if (!row || row.revertStatus === "reverted") continue;
    const toolHandler = effect.kind === "tool" ? params.registry.tools.get(effect.toolName) : undefined;
    const taskHandler = effect.kind === "task" ? params.registry.tasks.get(effect.nodeId) : undefined;
    const handler = toolHandler?.revert ?? taskHandler?.revert;
    if (typeof handler !== "function") {
      const failedReport = {
        ...params.report,
        blocking: [
          ...params.report.blocking,
          {
            ...effect,
            reason:
              effect.kind === "tool" && effect.hasRevert
                ? `The journal records hasRevert=true for tool ${effect.toolName}, but no matching defineTool instance was enumerable from task agents or exported workflow tool registries. Closed-over compute-task tools must be exported in a tool registry.`
                : `No revert handler could be resolved for ${effect.kind} ${effect.kind === "tool" ? effect.toolName : effect.nodeId}.`,
          },
        ],
        revertible: params.report.revertible.filter((candidate) => candidate !== effect),
      };
      throw new SmithersError(
        "TIME_TRAVEL_SIDE_EFFECT_BLOCKED",
        `Time travel is blocked because a revert handler could not be resolved.`,
        { runId: params.runId, operation: params.operation, report: failedReport },
      );
    }
    const started = nowMs();
    await updateRow(db, effectRunId, effect, {
      revertStatus: "reverting",
      revertedAtMs: null,
      revertErrorJson: null,
    });
    await emitEvent(
      db,
      {
        type: "EffectRevertStarted",
        runId: effectRunId,
        operation: params.operation,
        kind: effect.kind,
        toolName: effect.toolName,
        nodeId: effect.nodeId,
        iteration: effect.iteration,
        attempt: effect.attempt,
        seq: effect.seq,
        effectStatus: effect.effectStatus,
        timestampMs: started,
      },
      params.onProgress,
    );
    try {
      if (effect.kind === "task") {
        await handler({
          outputRow: parseJson(/** @type {string | null | undefined} */ (row.outputJson)),
          effectStatus: effect.effectStatus,
          runId: effectRunId,
          nodeId: effect.nodeId,
          iteration: effect.iteration,
          attempt: effect.attempt,
        });
      } else {
        await handler(parseJson(/** @type {string | null | undefined} */ (row.inputJson)), {
          output: parseJson(/** @type {string | null | undefined} */ (row.outputJson)),
          effectStatus: effect.effectStatus,
          idempotencyKey: row.idempotencyKey ?? null,
          runId: effectRunId,
          nodeId: effect.nodeId,
          iteration: effect.iteration,
          attempt: effect.attempt,
          toolCallSeq: effect.seq,
        });
      }
    } catch (error) {
      const failedAt = nowMs();
      const message = error instanceof Error ? error.message : String(error);
      const updated = await finishRevertingRow(db, effectRunId, effect, {
        revertStatus: "revert-failed",
        revertedAtMs: null,
        revertErrorJson: JSON.stringify({ message }),
      });
      if (updated === 0) {
        const current = await loadLiveRow(db, effectRunId, effect);
        throw changedRevertStateError(params, effect, current, error);
      }
      await emitEvent(
        db,
        {
          type: "EffectRevertFailed",
          runId: effectRunId,
          operation: params.operation,
          kind: effect.kind,
          toolName: effect.toolName,
          nodeId: effect.nodeId,
          iteration: effect.iteration,
          attempt: effect.attempt,
          seq: effect.seq,
          error: message,
          timestampMs: failedAt,
        },
        params.onProgress,
      );
      const failedReport = {
        ...params.report,
        blocking: [
          ...params.report.blocking,
          {
            ...effect,
            effectStatus: "unknown",
            reason: `Revert failed: ${message}`,
          },
        ],
        revertible: params.report.revertible.filter((candidate) => candidate !== effect),
      };
      throw new SmithersError(
        "TIME_TRAVEL_SIDE_EFFECT_BLOCKED",
        `Time travel is blocked because reverting ${effect.kind} ${effect.toolName} failed.`,
        { runId: params.runId, operation: params.operation, report: failedReport },
        { cause: error },
      );
    }
    const finished = nowMs();
    const updated = await finishRevertingRow(db, effectRunId, effect, {
      revertStatus: "reverted",
      revertedAtMs: finished,
      revertErrorJson: null,
    });
    if (updated === 0) {
      const current = await loadLiveRow(db, effectRunId, effect);
      throw changedRevertStateError(params, effect, current);
    }
    await emitEvent(
      db,
      {
        type: "EffectRevertFinished",
        runId: effectRunId,
        operation: params.operation,
        kind: effect.kind,
        toolName: effect.toolName,
        nodeId: effect.nodeId,
        iteration: effect.iteration,
        attempt: effect.attempt,
        seq: effect.seq,
        timestampMs: finished,
      },
      params.onProgress,
    );
  }
  return {
    ...params.report,
    revertible: params.report.revertible.map((effect) => ({
      ...effect,
      reason: "Reverted successfully.",
    })),
  };
}
