/**
 * Latching detector for run-level concurrency starvation.
 *
 * The engine caps concurrent task execution at `maxConcurrency` (CLI:
 * `--max-concurrency`, default 4). Workflows that fan out wider than the cap
 * silently queue — a 12-ticket kanban run with 3 reviewers per ticket wants
 * ~16 slots and crawls at 4 with no visible signal. This helper watches slot
 * acquisition and produces a single human-readable hint per run the first
 * time queued demand reaches the cap itself (i.e. total demand is at least
 * twice the cap), so transient one-off waits stay quiet.
 *
 * @param {number} maxConcurrency
 * @returns {{ onSlotWait: (activeTaskCount: number, waitingCount: number) => string | null }}
 */
export function createSlotStarvationHint(maxConcurrency) {
    let latched = false;
    return {
        /**
         * Call when a task is about to queue for a slot. `waitingCount` counts
         * the queue INCLUDING the task about to wait.
         *
         * @param {number} activeTaskCount
         * @param {number} waitingCount
         * @returns {string | null} the warning to log once, else null
         */
        onSlotWait(activeTaskCount, waitingCount) {
            if (latched || maxConcurrency <= 0 || waitingCount < maxConcurrency) {
                return null;
            }
            latched = true;
            const demand = activeTaskCount + waitingCount;
            return (
                `${demand} tasks want to run concurrently but maxConcurrency is ${maxConcurrency}; ` +
                `${waitingCount} are queued waiting for a free slot. ` +
                `If the host and providers can take it, raise the cap (CLI: smithers up --max-concurrency ${demand}) ` +
                `to run this workflow at full width.`
            );
        },
    };
}
