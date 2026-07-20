import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { smithersSnapshots } from "../schema.js";
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */
/** @typedef {import("./Snapshot.ts").Snapshot} Snapshot */

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Effect.Effect<Array<Pick<Snapshot, "runId" | "frameNo" | "contentHash" | "createdAtMs" | "vcsPointer">>, SmithersError>}
 */
export function listSnapshots(adapter, runId) {
    return Effect.tryPromise({
        try: () => adapter.internalStorage?.dialect === "postgres"
            ? adapter.internalStorage.queryAll(`SELECT run_id, frame_no, content_hash, created_at_ms, vcs_pointer FROM _smithers_snapshots WHERE run_id = ? ORDER BY frame_no`, [runId])
            : adapter.db
                .select({
                runId: smithersSnapshots.runId,
                frameNo: smithersSnapshots.frameNo,
                contentHash: smithersSnapshots.contentHash,
                createdAtMs: smithersSnapshots.createdAtMs,
                vcsPointer: smithersSnapshots.vcsPointer,
            })
                .from(smithersSnapshots)
                .where(eq(smithersSnapshots.runId, runId))
                .orderBy(smithersSnapshots.frameNo),
        catch: (cause) => toSmithersError(cause, "list snapshots", {
            code: "DB_QUERY_FAILED",
            details: { runId },
        }),
    }).pipe(Effect.annotateLogs({ runId }), Effect.withLogSpan("time-travel:list-snapshots"));
}
