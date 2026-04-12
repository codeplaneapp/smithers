import { Effect, Metric } from "effect";
import { asyncExternalWaitCounts } from "./_asyncExternalWaitCounts.js";
import { externalWaitAsyncPending } from "./externalWaitAsyncPending.js";
/**
 * @param {"approval" | "event"} kind
 * @param {number} delta
 * @returns {Effect.Effect<void>}
 */
export function updateAsyncExternalWaitPending(kind, delta) {
    return Effect.sync(() => {
        asyncExternalWaitCounts[kind] = Math.max(0, asyncExternalWaitCounts[kind] + delta);
        return asyncExternalWaitCounts[kind];
    }).pipe(Effect.flatMap((value) => Metric.set(Metric.tagged(externalWaitAsyncPending, "kind", kind), value)));
}
