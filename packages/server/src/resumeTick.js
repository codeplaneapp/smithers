import { randomUUID } from "node:crypto";
import { runCronTick } from "./cronTick.js";

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

/**
 * Default stale-heartbeat threshold, in ms. Matches `smithers supervise`'s
 * `--supervise-stale-threshold` default ("30s", parsed by
 * `apps/cli/src/supervisor.js`'s `parseDurationMs`) and its
 * `DEFAULT_SUPERVISOR_STALE_THRESHOLD_MS` constant (apps/cli/src/supervisor.js)
 * — a run resumable by a serverless tick is exactly as stale as one the CLI
 * supervisor would resume.
 */
const DEFAULT_STALE_THRESHOLD_MS = 30_000;

/**
 * @typedef {object} ResumeJob
 * @property {string} runId
 * @property {string} workflowPath
 * @property {string} claimOwnerId
 * @property {number} claimHeartbeatAtMs
 * @property {string | null} restoreRuntimeOwnerId
 * @property {number | null} restoreHeartbeatAtMs
 * @property {string} [cliEntrypoint]
 */

/**
 * @typedef {object} RunResumeTickResult
 * @property {number} resumedCount
 * @property {Array<{ runId: string; kind: string }>} resumed
 * @property {Array<{ runId: string; error: string }>} errors
 * @property {number} now
 * @property {string} workerId
 */

/**
 * @typedef {object} RunResumeTickOptions
 * @property {number} [now] Clock override (mostly for tests). Defaults to `Date.now()`.
 * @property {number} [staleThresholdMs] How stale a `running` run's heartbeat (or an
 *   `waiting-event` run whose approval was decided) must be before a tick will claim
 *   and resume it. Defaults to `DEFAULT_STALE_THRESHOLD_MS` (30s, matching `smithers
 *   supervise`'s default).
 * @property {string} [workerId] Identifier recorded on claimed rows. Defaults to a random UUID.
 * @property {number} [limit] Max number of candidate runs to consider per kind, per tick. Defaults to 100.
 * @property {(job: ResumeJob, ctx: { now: number }) => Promise<unknown>} [resumeRun]
 *   Resumes a claimed run. Defaults to shelling out to the `smithers` CLI binary
 *   (`smithers up <workflowPath> --resume --run-id <runId> -d --force`), the same
 *   mechanism `apps/cli/src/resume-detached.js`'s `resumeRunDetached` uses — but
 *   spawning the generic `smithers` bin rather than importing that module directly.
 *   packages/server cannot depend on apps/cli (`node scripts/check-dependency-boundaries.mjs`
 *   passed with 44 workspace packages and does not list apps/cli as a package
 *   packages/server's manifest may depend on; apps are not importable from packages).
 *   Callers embedding `runResumeTick` in a serverless handler (e.g. a Vercel Cron
 *   route) SHOULD supply their own `resumeRun` that kicks the resume off somewhere
 *   that outlives the invocation (a sandbox provider, an internal queue, etc.),
 *   exactly as `runCronTick`'s `startWorkflowRun` recommends for cron-fired runs.
 * @property {string} [cliEntrypoint] Passed through to the default `resumeRun` as the
 *   binary to spawn. Defaults to `"smithers"` (resolved via `PATH`).
 */

/**
 * Default `resumeRun`: spawns the smithers CLI's `up --resume` detached,
 * mirroring `apps/cli/src/resume-detached.js`'s `resumeRunDetached` (same
 * flags: `--resume --run-id --resume-claim-owner --resume-claim-heartbeat
 * --resume-restore-owner --resume-restore-heartbeat`). Lazily imports
 * `node:child_process` so environments that always pass their own `resumeRun`
 * (e.g. serverless callers) don't pay for it.
 * @param {ResumeJob} job
 * @returns {Promise<void>}
 */
async function defaultResumeRun(job) {
    const { spawn } = await import("node:child_process");
    await new Promise((resolvePromise, rejectPromise) => {
        try {
            const args = [
                "up",
                job.workflowPath,
                "--resume",
                "--run-id",
                job.runId,
                "-d",
                "--force",
                "--resume-claim-owner",
                job.claimOwnerId,
                "--resume-claim-heartbeat",
                String(job.claimHeartbeatAtMs),
            ];
            if (job.restoreRuntimeOwnerId !== undefined && job.restoreRuntimeOwnerId !== null) {
                args.push("--resume-restore-owner", job.restoreRuntimeOwnerId);
            }
            if (job.restoreHeartbeatAtMs !== undefined && job.restoreHeartbeatAtMs !== null) {
                args.push("--resume-restore-heartbeat", String(job.restoreHeartbeatAtMs));
            }
            const proc = spawn(job.cliEntrypoint ?? "smithers", args, {
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
 * Attempt to atomically claim and resume one candidate run. This is the
 * single "claim + resume + release-on-failure" primitive shared by
 * `runResumeTick` (below, for serverless ticks) and
 * `apps/cli/src/supervisor.js`'s `processCandidateEffect` /
 * `processApprovalDecidedCandidateEffect` (for the long-running CLI
 * supervisor loop): claim via `db.claimRunForResume` (the SAME
 * lease-guarded `UPDATE ... RETURNING` either caller uses), then call
 * `resumeRun`, releasing the claim on failure so a later tick can retry.
 *
 * Exported so `smithers supervise` can delegate to it instead of
 * duplicating the claim/resume/release sequence, mirroring how
 * `apps/cli/src/scheduler.js` delegates to `runCronTick`.
 *
 * @param {SmithersDb} db
 * @param {Record<string, unknown>} run
 * @param {{ now: number; staleBeforeMs: number; workerId: string; resumeRun: RunResumeTickOptions["resumeRun"]; cliEntrypoint?: string; claimOwnerId?: string }} ctx
 * @param {string} kind
 * @returns {Promise<{ runId: string; resumed: boolean; kind?: string; error?: string }>}
 */
export async function claimAndResumeRun(db, run, ctx, kind) {
    const runId = /** @type {string} */ (run.runId);
    const claimOwnerId = ctx.claimOwnerId ?? `resume-tick:${ctx.workerId}`;
    const claimHeartbeatAtMs = ctx.now;
    const runtimeOwnerId = /** @type {string | null} */ (run.runtimeOwnerId ?? null);
    const heartbeatAtMs = /** @type {number | null} */ (run.heartbeatAtMs ?? null);
    const claimed = await db.claimRunForResume({
        runId,
        expectedStatus: /** @type {string} */ (run.status),
        expectedRuntimeOwnerId: runtimeOwnerId,
        expectedHeartbeatAtMs: heartbeatAtMs,
        staleBeforeMs: ctx.staleBeforeMs,
        claimOwnerId,
        claimHeartbeatAtMs,
        requireStale: true,
    });
    if (!claimed) {
        return { runId, resumed: false };
    }
    try {
        await ctx.resumeRun({
            runId,
            workflowPath: /** @type {string} */ (run.workflowPath),
            claimOwnerId,
            claimHeartbeatAtMs,
            restoreRuntimeOwnerId: runtimeOwnerId,
            restoreHeartbeatAtMs: heartbeatAtMs,
            cliEntrypoint: ctx.cliEntrypoint,
        }, { now: ctx.now });
        return { runId, resumed: true, kind };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
            await db.releaseRunResumeClaim({
                runId,
                claimOwnerId,
                restoreRuntimeOwnerId: runtimeOwnerId,
                restoreHeartbeatAtMs: heartbeatAtMs,
            });
        }
        catch {
            // Best-effort release; the lease will simply expire on its own.
        }
        return { runId, resumed: false, kind, error: message };
    }
}

/**
 * A single, storage-agnostic "resume tick": find every run resumable because
 * (i) its heartbeat has gone stale while `running` (the engine process that
 * owned it died or the invocation that owned it ended), or (ii) it is
 * `waiting-event` with at least one decided approval recorded while
 * detached (`approval-decided-resume-required` — the gate node is already
 * "pending" but no engine is alive to execute it) — then claims a lease via
 * `db.claimRunForResume` (the same lease-guarded claim `smithers supervise`
 * uses) and resumes each claimed run.
 *
 * Safe to call from a short-lived HTTP handler: it does not loop or block
 * waiting on workflow completion, only claims + kicks off resumes and
 * returns a summary. This is the run-resume half of `runServerlessTick`, the
 * function intended for a `Vercel Cron -> route handler`.
 *
 * @param {SmithersDb} db
 * @param {RunResumeTickOptions} [opts]
 * @returns {Promise<RunResumeTickResult>}
 */
export async function runResumeTick(db, opts = {}) {
    const now = opts.now ?? Date.now();
    const staleThresholdMs = opts.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
    const staleBeforeMs = now - staleThresholdMs;
    const limit = opts.limit ?? 100;
    const workerId = opts.workerId ?? randomUUID();
    const resumeRun = opts.resumeRun ?? defaultResumeRun;
    const ctx = { now, staleBeforeMs, workerId, resumeRun, cliEntrypoint: opts.cliEntrypoint };

    const resumed = [];
    const errors = [];

    const staleRuns = await db.listStaleRunningRuns(staleBeforeMs, limit);
    for (const run of staleRuns) {
        const result = await claimAndResumeRun(db, run, ctx, "stale-running");
        if (result.resumed) {
            resumed.push({ runId: result.runId, kind: /** @type {string} */ (result.kind) });
        }
        else if (result.error) {
            errors.push({ runId: result.runId, error: result.error });
        }
    }

    const waitingEventRuns = await db.listRuns(limit, "waiting-event");
    for (const run of waitingEventRuns) {
        const heartbeatAtMs = /** @type {number | null} */ (run.heartbeatAtMs ?? null);
        if (heartbeatAtMs !== null && heartbeatAtMs >= staleBeforeMs) {
            continue;
        }
        const decided = await db.listDecidedApprovals(/** @type {string} */ (run.runId));
        if (decided.length === 0) {
            continue;
        }
        const result = await claimAndResumeRun(db, run, ctx, "approval-decided-resume-required");
        if (result.resumed) {
            resumed.push({ runId: result.runId, kind: /** @type {string} */ (result.kind) });
        }
        else if (result.error) {
            errors.push({ runId: result.runId, error: result.error });
        }
    }

    return { resumedCount: resumed.length, resumed, errors, now, workerId };
}

/**
 * @typedef {object} RunServerlessTickResult
 * @property {import("./cronTick.js").RunCronTickResult} cron
 * @property {RunResumeTickResult} resume
 */

/**
 * The single function a Vercel Cron -> route handler should call: runs
 * `runCronTick` (claim due crons, start/advance their workflow runs) then
 * `runResumeTick` (claim + resume stale/approval-decided suspended runs).
 * Both halves only claim leases and kick work off elsewhere (a detached
 * process, a sandbox provider, an internal queue) — this stays short enough
 * for a serverless invocation regardless of how long the resumed workflow
 * itself takes to finish.
 *
 * @param {SmithersDb} db
 * @param {import("./cronTick.js").RunCronTickOptions & RunResumeTickOptions} [opts]
 * @returns {Promise<RunServerlessTickResult>}
 */
export async function runServerlessTick(db, opts = {}) {
    const cron = await runCronTick(db, opts);
    const resume = await runResumeTick(db, opts);
    return { cron, resume };
}
