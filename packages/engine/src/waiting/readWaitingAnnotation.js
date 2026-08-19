/**
 * Read back the annotation a run was parked with.
 *
 * The seam persists `{ reason, wakeAt?, token? }` on the `RunStatusChanged`
 * event that records the park, so the durable record travels with the journal
 * entry that caused it. Rows parked before stage 1.4 have no annotation; they
 * are reconstructed from the run status and, for a quota park, the
 * `errorJson.resetAtMs` that path has always written.
 *
 * @typedef {import("./WaitingAnnotation.ts").WaitingAnnotation} WaitingAnnotation
 * @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb
 */
import { Effect } from "effect";
import { makeWaitingAnnotation, parseWaitingAnnotation, waitingReasonForRunStatus } from "./waitingTaxonomy.js";

/** @param {unknown} raw */
function parseJson(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {{ status?: string | null; errorJson?: string | null } | null | undefined} run
 * @returns {WaitingAnnotation | null}
 */
export function waitingAnnotationFromRunRow(run) {
  if (!run) return null;
  const reason = waitingReasonForRunStatus(run.status);
  if (!reason) return null;
  const error = parseJson(run.errorJson);
  const declared = error && typeof error === "object" ? parseWaitingAnnotation(error.waiting) : null;
  const resetAtMs = error && typeof error === "object" ? Number(error.resetAtMs) : Number.NaN;
  const fallbackWakeAt = Number.isFinite(resetAtMs) ? resetAtMs : undefined;
  // A declared annotation with no `wakeAt` still defers to the `resetAtMs`
  // this path has always written. Otherwise a quota park whose provider
  // deadline had already elapsed when the annotation was built would read as
  // deadline-less and never come due, where the pre-taxonomy reader had it due
  // on the next poll.
  if (declared) {
    return declared.wakeAt !== undefined
      ? declared
      : makeWaitingAnnotation(declared.reason, {
          wakeAt: fallbackWakeAt,
          token: declared.token,
        });
  }
  return makeWaitingAnnotation(reason, { wakeAt: fallbackWakeAt });
}

/**
 * The newest `RunStatusChanged` entry in a run's journal.
 *
 * The sweep asks two questions of it: what status the run was last moved to,
 * and what waiting annotation moved it there. Both have to come from the same
 * entry — an older annotation belongs to a park the run has already left.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<{ status: string | null; annotation: WaitingAnnotation | null } | null>}
 */
export async function readLatestRunStatusChange(adapter, runId) {
  const rows = await Effect.runPromise(adapter.listEventsByType(runId, "RunStatusChanged")).catch(() => []);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const payload = parseJson(rows[index]?.payloadJson ?? rows[index]?.payload_json);
    if (!payload || typeof payload !== "object") continue;
    return {
      status: typeof payload.status === "string" ? payload.status : null,
      annotation: parseWaitingAnnotation(payload.waiting),
    };
  }
  return null;
}

/**
 * The annotation a parked run row is currently waiting under.
 *
 * The row is consulted first because it is one read, but only quota parks put
 * anything there: every other park leaves `errorJson` alone and the journal
 * entry is the only durable record. So a row that yields no deadline falls
 * back to the newest `RunStatusChanged`, and only when that entry is the one
 * that produced the row's current status.
 *
 * @param {SmithersDb} adapter
 * @param {{ runId: string; status?: string | null; errorJson?: string | null }} run
 * @returns {Promise<WaitingAnnotation | null>}
 */
export async function waitingAnnotationForRun(adapter, run) {
  const fromRow = waitingAnnotationFromRunRow(run);
  if (fromRow?.wakeAt !== undefined) return fromRow;
  const latest = await readLatestRunStatusChange(adapter, String(run.runId));
  if (latest && latest.annotation && latest.status === (run.status ?? null)) {
    return latest.annotation;
  }
  return fromRow;
}

/**
 * The annotation a run is currently parked under, by run id.
 *
 * The operator-facing read behind `smithers supervise`'s park explanation. It
 * answers the same question the sweep asks, from the same two sources, so an
 * operator and the sweep cannot disagree about why a run is waiting.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<WaitingAnnotation | null>}
 */
export async function readWaitingAnnotation(adapter, runId) {
  const run = await Effect.runPromise(adapter.getRun(runId));
  return run ? waitingAnnotationForRun(adapter, run) : null;
}
