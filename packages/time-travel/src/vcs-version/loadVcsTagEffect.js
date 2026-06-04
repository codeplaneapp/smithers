import { eq, and } from "drizzle-orm";
import { Effect } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { smithersVcsTags } from "../schema.js";
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */
/** @typedef {import("./VcsTag.ts").VcsTag} VcsTag */

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @returns {Effect.Effect<VcsTag | undefined, SmithersError>}
 */
export function loadVcsTag(adapter, runId, frameNo) {
    return Effect.tryPromise({
        try: () => adapter.internalStorage?.dialect === "postgres"
            ? adapter.internalStorage.queryOne(`SELECT * FROM _smithers_vcs_tags WHERE run_id = ? AND frame_no = ? LIMIT 1`, [runId, frameNo]).then((row) => (row ? [row] : []))
            : adapter.db
                .select()
                .from(smithersVcsTags)
                .where(and(eq(smithersVcsTags.runId, runId), eq(smithersVcsTags.frameNo, frameNo)))
                .limit(1),
        catch: (cause) => toSmithersError(cause, "load vcs tag", {
            code: "DB_QUERY_FAILED",
            details: { frameNo, runId },
        }),
    }).pipe(Effect.map((rows) => rows[0]), Effect.annotateLogs({ runId, frameNo: String(frameNo) }), Effect.withLogSpan("time-travel:load-vcs-tag"));
}
