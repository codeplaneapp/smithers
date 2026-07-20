import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

/**
 * Parse a JSON column persisted in a snapshot row, converting a malformed
 * payload into a SmithersError instead of letting a raw SyntaxError escape and
 * crash the fork/replay path.
 *
 * @template T
 * @param {string} json
 * @param {string} field - the snapshot column being parsed (for diagnostics)
 * @param {{ runId?: string; frameNo?: number }} [context]
 * @returns {T}
 */
export function parseSnapshotJson(json, field, context = {}) {
    try {
        return JSON.parse(json);
    } catch (cause) {
        throw new SmithersError(
            "DB_QUERY_FAILED",
            `Corrupt snapshot data: ${field} is not valid JSON`,
            { field, ...context },
            { cause },
        );
    }
}
