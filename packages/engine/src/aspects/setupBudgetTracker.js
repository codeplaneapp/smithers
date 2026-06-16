import { createBudgetTracker } from "./createBudgetTracker.js";

/**
 * @typedef {import("./createBudgetTracker.js").BudgetTracker} BudgetTracker
 */

/**
 * Create a per-run Aspects budget tracker, seed it from persisted
 * `TokenUsageReported` events (so accumulated token/cost usage survives a
 * resume), and subscribe it to the event bus so live usage keeps accumulating.
 *
 * Listeners on `emitEventQueued`/`emitEventWithPersist` run synchronously, so
 * the accumulator is always current by the time the scheduler evaluates the
 * next task's budget.
 *
 * @param {{
 *   adapter: any;
 *   runId: string;
 *   eventBus: import("node:events").EventEmitter;
 *   runStartMs: number;
 * }} opts
 * @returns {Promise<BudgetTracker>}
 */
export async function setupBudgetTracker(opts) {
    const { adapter, runId, eventBus, runStartMs } = opts;
    const tracker = createBudgetTracker({ runStartMs });
    // Seed from persisted usage so resumed runs keep their accumulated spend.
    try {
        const rows = await adapter.listEventsByType(runId, "TokenUsageReported");
        for (const row of rows ?? []) {
            const payload = parseUsageRow(row);
            if (payload) {
                tracker.recordUsage(payload);
            }
        }
    }
    catch {
        // Best-effort seeding: a missing/garbled history must not block the run.
        // Budgets simply start from the live usage in that case.
    }
    eventBus.on("event", (event) => {
        if (event && event.type === "TokenUsageReported") {
            tracker.recordUsage(event);
        }
    });
    return tracker;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {import("./createBudgetTracker.js").UsageLike | null}
 */
function parseUsageRow(row) {
    const json = row?.payloadJson;
    if (typeof json !== "string") {
        return null;
    }
    try {
        const parsed = JSON.parse(json);
        if (!parsed || typeof parsed !== "object") {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
