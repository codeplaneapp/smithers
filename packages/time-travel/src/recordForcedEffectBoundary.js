import { Effect } from "effect";
import { nowMs } from "@smthrs/scheduler/nowMs";

/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./EffectBoundaryReport.ts").EffectBoundaryReport} EffectBoundaryReport */

/**
 * Append one forced-crossing stamp in the database so concurrent replay/fork
 * operations cannot overwrite one another's audit history.
 *
 * @param {SmithersDb} db
 * @param {{ runId: string; nodeId: string; iteration: number; attempt: number; seq: number }} effect
 * @param {{ opId: string; timestampMs: number; operation: string }} stamp
 */
async function appendForcedPast(db, effect, stamp) {
  const stampJson = JSON.stringify(stamp);
  const key = [effect.runId, effect.nodeId, effect.iteration, effect.attempt, effect.seq];
  if (db.internalStorage.dialect === "postgres") {
    await db.internalStorage.execute(
      `UPDATE _smithers_tool_calls
          SET forced_past_json = (
            COALESCE(NULLIF(forced_past_json, ''), '[]')::jsonb
            || CAST(? AS jsonb)
          )::text
        WHERE run_id = ? AND node_id = ? AND iteration = ? AND attempt = ? AND seq = ?
          AND NOT (
            COALESCE(NULLIF(forced_past_json, ''), '[]')::jsonb
            @> CAST(? AS jsonb)
          )`,
      [JSON.stringify([stamp]), ...key, JSON.stringify([{ opId: stamp.opId }])],
    );
    return;
  }
  const normalizedArray = `CASE
    WHEN forced_past_json IS NOT NULL
      AND json_valid(forced_past_json)
      AND json_type(forced_past_json) = 'array'
    THEN forced_past_json
    ELSE '[]'
  END`;
  await db.internalStorage.execute(
    `UPDATE _smithers_tool_calls
        SET forced_past_json = json_insert(${normalizedArray}, '$[#]', json(?))
      WHERE run_id = ? AND node_id = ? AND iteration = ? AND attempt = ? AND seq = ?
        AND NOT EXISTS (
          SELECT 1
            FROM json_each(${normalizedArray})
           WHERE json_extract(value, '$.opId') = ?
        )`,
    [stampJson, ...key, stamp.opId],
  );
}

/**
 * Persist the durable evidence required when an operation is forced across
 * unresolved external effects.
 *
 * @param {SmithersDb} db
 * @param {{ runId: string; operation: string; opId: string; report: EffectBoundaryReport }} params
 */
export async function recordForcedEffectBoundary(db, params) {
  const timestampMs = nowMs();
  const effects = [...params.report.blocking, ...params.report.revertible];
  for (const effect of effects) {
    await appendForcedPast(
      db,
      {
        runId: effect.runId || params.runId,
        nodeId: effect.nodeId,
        iteration: effect.iteration,
        attempt: effect.attempt,
        seq: effect.seq,
      },
      {
        opId: params.opId,
        timestampMs,
        operation: params.operation,
      },
    );
  }
  const event = {
    type: "SideEffectBoundaryCrossed",
    runId: params.runId,
    opId: params.opId,
    operation: params.operation,
    report: params.report,
    timestampMs,
  };
  await Effect.runPromise(
    db.insertEventWithNextSeq({
      runId: params.runId,
      timestampMs,
      type: event.type,
      payloadJson: JSON.stringify(event),
    }),
  );
}
