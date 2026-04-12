import { Effect } from "effect";
/**
 * @param {string} _label
 * @param {() => void} fn
 * @returns {Effect.Effect<void>}
 */
export function ignoreSyncError(_label, fn) {
    return Effect.sync(() => {
        try {
            fn();
        }
        catch {
            // Best-effort cleanup intentionally swallows failures.
        }
    });
}
