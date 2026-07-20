/**
 * Wire marker stamped into an attempt's `meta_json` when a time-travel reset
 * path (retry-task / rewind) cancels the attempt so the node can re-run cleanly.
 *
 * The engine discounts ONLY reset-cancelled attempts when deriving the next
 * attempt number (and thus the failover rung), so a deliberate reset restarts
 * at attempt 1 / rung 0. Ordinary crash-recovery cancellations (engine-initiated
 * on resume / stale-sweep / unmount) are left UNMARKED and still count, which
 * preserves attempt numbering, non-idempotent tool-resume warnings, and revert
 * anchors across a normal resume. The engine keeps a matching literal constant
 * (`RESET_CANCELLED_META_KEY` in engine.js); this string is the shared contract.
 */
export const RESET_CANCELLED_META_KEY = "resetCancelled";

/**
 * Merge the reset marker into an attempt's existing `meta_json`, preserving any
 * previously-stored fields (e.g. `agentEngine` / `agentModel`).
 * @param {string | null | undefined} metaJson
 * @returns {string}
 */
export function markResetCancelledMeta(metaJson) {
    let meta = {};
    if (metaJson) {
        try {
            const parsed = JSON.parse(metaJson);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                meta = parsed;
            }
        } catch {
            meta = {};
        }
    }
    meta[RESET_CANCELLED_META_KEY] = true;
    return JSON.stringify(meta);
}
