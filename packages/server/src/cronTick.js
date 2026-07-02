import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

/**
 * @typedef {object} RunCronTickResult
 * @property {number} claimedCount
 * @property {Array<{ cronId: string; workflowPath: string; nextRunAtMs: number }>} fired
 * @property {Array<{ cronId: string; error: string }>} errors
 * @property {number} now
 * @property {string} workerId
 */

/**
 * @typedef {object} RunCronTickOptions
 * @property {number} [now] Clock override (mostly for tests). Defaults to `Date.now()`.
 * @property {number} [leaseMs] How long a claim is held before another tick may
 *   steal it (guards against a worker crashing mid-run). Defaults to 5 minutes.
 * @property {string} [workerId] Identifier recorded on claimed rows. Defaults to a random UUID.
 * @property {number} [limit] Max number of due crons to claim/process in a single tick. Defaults to 100.
 * @property {(job: Record<string, unknown>, ctx: { now: number }) => Promise<unknown>} [startWorkflowRun]
 *   Starts (or advances) the workflow run for a due cron job. Defaults to spawning
 *   `smithers up <workflowPath> -d` as a detached subprocess — the same mechanism
 *   `apps/cli/src/scheduler.js` used historically. Callers embedding `runCronTick`
 *   in a short-lived serverless handler (e.g. a Vercel Cron route) SHOULD supply
 *   their own `startWorkflowRun` (for example one that calls into the in-process
 *   engine, or that hits an internal API/queue) since detached child processes are
 *   not guaranteed to keep running once the serverless invocation ends.
 */

/**
 * Default `startWorkflowRun`: spawns the smithers CLI's `up` command detached,
 * matching the historical `apps/cli/src/scheduler.js` behavior. Lazily imports
 * `node:child_process` so environments that never call the default (e.g.
 * serverless callers who always pass their own `startWorkflowRun`) don't pay for it.
 * @param {Record<string, unknown>} job
 * @returns {Promise<void>}
 */
async function defaultStartWorkflowRun(job) {
    const { spawn } = await import("node:child_process");
    await new Promise((resolvePromise, rejectPromise) => {
        try {
            const proc = spawn(process.execPath, [
                /** @type {string} */ (job.cliEntrypoint) ?? "smithers",
                "up",
                /** @type {string} */ (job.workflowPath),
                "-d",
            ], {
                cwd: process.cwd(),
                detached: true,
                stdio: "ignore",
            });
            proc.on?.("error", rejectPromise);
            proc.unref();
            resolvePromise(undefined);
        }
        catch (cause) {
            rejectPromise(cause);
        }
    });
}

/**
 * Compute the next run time for a cron pattern relative to `now`.
 * @param {string} pattern
 * @param {number} now
 * @returns {number}
 */
export function computeNextRunAtMs(pattern, now) {
    const interval = CronExpressionParser.parse(pattern, { currentDate: new Date(now) });
    return interval.next().getTime();
}

/**
 * A single, storage-agnostic cron "tick": claim every due cron (via an
 * adapter-level lease so two overlapping calls to `runCronTick` — e.g. two
 * overlapping Vercel Cron invocations, or a long-running scheduler loop
 * racing a manually-triggered tick — cannot both fire the same cron), start
 * or advance each due workflow run, and record the next run time.
 *
 * Safe to call from a short-lived HTTP handler: it does not loop or block
 * waiting on workflow completion, only kicks runs off (or advances them) and
 * returns a summary. This is the SAME implementation used by
 * `apps/cli/src/scheduler.js`'s long-running loop and is intended to be the
 * function a `Vercel Cron -> route handler` calls directly.
 *
 * @param {SmithersDb} db
 * @param {RunCronTickOptions} [opts]
 * @returns {Promise<RunCronTickResult>}
 */
export async function runCronTick(db, opts = {}) {
    const now = opts.now ?? Date.now();
    const leaseMs = opts.leaseMs ?? 5 * 60_000;
    const workerId = opts.workerId ?? randomUUID();
    const limit = opts.limit ?? 100;
    const startWorkflowRun = opts.startWorkflowRun ?? defaultStartWorkflowRun;

    const claimed = await db.claimDueCrons(now, leaseMs, workerId, limit);
    const fired = [];
    const errors = [];

    for (const job of claimed) {
        try {
            await startWorkflowRun(job, { now });
            const nextRunAtMs = computeNextRunAtMs(/** @type {string} */ (job.pattern), now);
            await db.updateCronRunTime(/** @type {string} */ (job.cronId), now, nextRunAtMs, null);
            fired.push({
                cronId: /** @type {string} */ (job.cronId),
                workflowPath: /** @type {string} */ (job.workflowPath),
                nextRunAtMs,
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const failedAtMs = Date.now();
            const fallbackNextRunAtMs = typeof job.nextRunAtMs === "number" ? job.nextRunAtMs : failedAtMs + 60_000;
            try {
                await db.updateCronRunTime(/** @type {string} */ (job.cronId), failedAtMs, fallbackNextRunAtMs, message);
            }
            catch {
                // Best-effort: the cron stays claimed until its lease expires,
                // at which point a later tick will retry it.
            }
            errors.push({ cronId: /** @type {string} */ (job.cronId), error: message });
        }
        finally {
            try {
                await db.releaseCronClaim(/** @type {string} */ (job.cronId));
            }
            catch {
                // Best-effort release; the lease will simply expire on its own.
            }
        }
    }

    return { claimedCount: claimed.length, fired, errors, now, workerId };
}
