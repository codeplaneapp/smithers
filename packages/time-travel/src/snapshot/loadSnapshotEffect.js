import { Effect } from "effect";
import { toSmithersError } from "@smthrs/errors/toSmithersError";
import { hydrateSnapshot } from "./captureSnapshotEffect.js";
/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smthrs/errors/SmithersError").SmithersError} SmithersError */
/** @typedef {import("./Snapshot.ts").Snapshot} Snapshot */

const SNAPSHOT_WITH_CONTENT_SQL = `SELECT
  s.*,
  r.content_hash AS referenced_content_hash,
  c.nodes_json AS payload_nodes_json,
  c.outputs_json AS payload_outputs_json,
  c.ralph_json AS payload_ralph_json,
  c.input_json AS payload_input_json
FROM _smithers_snapshots s
LEFT JOIN _smithers_snapshot_payload_refs r
  ON r.run_id = s.run_id AND r.frame_no = s.frame_no
LEFT JOIN _smithers_snapshot_contents c
  ON c.content_hash = r.content_hash`;
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @returns {Effect.Effect<Snapshot | undefined, SmithersError>}
 */
export function loadSnapshot(adapter, runId, frameNo) {
  return Effect.tryPromise({
    // Snapshot metadata and raw content share one statement snapshot, so a
    // concurrent rewind cannot delete the content between two reads.
    try: () =>
      adapter.internalStorage.queryOne(
        `${SNAPSHOT_WITH_CONTENT_SQL}
WHERE s.run_id = ? AND s.frame_no = ?
LIMIT 1`,
        [runId, frameNo],
      ),
    catch: (cause) =>
      toSmithersError(cause, "load snapshot", {
        code: "DB_QUERY_FAILED",
        details: { frameNo, runId },
      }),
  }).pipe(
    Effect.flatMap((row) =>
      row
        ? Effect.tryPromise({
            try: () => hydrateSnapshot(adapter, row),
            catch: (cause) =>
              toSmithersError(cause, "hydrate snapshot", {
                code: "DB_QUERY_FAILED",
                details: { frameNo, runId },
              }),
          })
        : Effect.succeed(undefined),
    ),
    Effect.annotateLogs({ runId, frameNo: String(frameNo) }),
    Effect.withLogSpan("time-travel:load-snapshot"),
  );
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Effect.Effect<Snapshot | undefined, SmithersError>}
 */
export function loadLatestSnapshot(adapter, runId) {
  return Effect.tryPromise({
    try: () =>
      adapter.internalStorage.queryOne(
        `${SNAPSHOT_WITH_CONTENT_SQL}
WHERE s.run_id = ?
ORDER BY s.frame_no DESC
LIMIT 1`,
        [runId],
      ),
    catch: (cause) =>
      toSmithersError(cause, "load latest snapshot", {
        code: "DB_QUERY_FAILED",
        details: { runId },
      }),
  }).pipe(
    Effect.flatMap((row) =>
      row
        ? Effect.tryPromise({
            try: () => hydrateSnapshot(adapter, row),
            catch: (cause) =>
              toSmithersError(cause, "hydrate latest snapshot", {
                code: "DB_QUERY_FAILED",
                details: { runId },
              }),
          })
        : Effect.succeed(undefined),
    ),
    Effect.annotateLogs({ runId }),
    Effect.withLogSpan("time-travel:load-latest-snapshot"),
  );
}
