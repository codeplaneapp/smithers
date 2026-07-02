import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Effect, Schedule } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { runCronTick } from "@smithers-orchestrator/server";
import { runPromise } from "./smithersRuntime.js";
import { findAndOpenDb } from "./find-db.js";
const CLI_ENTRYPOINT = fileURLToPath(new URL("./index.js", import.meta.url));
// One workerId per scheduler process: leases claimed by `runCronTick` record
// which worker holds them, which is useful when debugging a stuck lease
// (e.g. telling this long-running loop apart from a serverless tick).
const SCHEDULER_WORKER_ID = `cli-scheduler:${randomUUID()}`;
/**
 * @param {unknown} error
 */
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
function acquireSchedulerDbEffect() {
    return Effect.acquireRelease(Effect.tryPromise({
        try: () => findAndOpenDb(),
        catch: (cause) => toSmithersError(cause, "find and open scheduler db"),
    }), ({ cleanup }) => Effect.sync(() => cleanup()));
}
/**
 * Starts (or advances) a due workflow run by spawning `smithers up
 * <workflowPath> -d` as a detached subprocess. This is the historical
 * scheduler behavior, now shared with `runCronTick` (the SAME function a
 * serverless `Vercel Cron -> route handler` calls) via dependency injection.
 * @param {{ workflowPath: string }} job
 * @returns {Promise<void>}
 */
function spawnCronWorkflow(job) {
    return new Promise((resolvePromise, rejectPromise) => {
        try {
            const proc = spawn(process.execPath, [CLI_ENTRYPOINT, "up", job.workflowPath, "-d"], {
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
 * One scheduler poll: delegates to the shared `runCronTick` (also the
 * function a serverless `Vercel Cron -> route handler` calls) so there is
 * exactly ONE implementation of "claim due crons, start their workflow runs,
 * record the next run time" for both the long-running CLI loop and
 * short-lived HTTP invocations.
 * @param {SmithersDb} adapter
 * @returns {Effect.Effect<void, never>}
 */
export function schedulerTickEffect(adapter) {
    return Effect.withLogSpan("scheduler:poll")(Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
            try: () => runCronTick(adapter, { workerId: SCHEDULER_WORKER_ID, startWorkflowRun: spawnCronWorkflow }),
            catch: (cause) => toSmithersError(cause, "scheduler tick"),
        }).pipe(Effect.catchAll((error) => Effect.logWarning(`[smithers-cron] Tick failed: ${formatError(error)}`).pipe(Effect.as({ claimedCount: 0, fired: [], errors: [] }))));
        if (result.claimedCount > 0) {
            yield* Effect.logInfo(`[smithers-cron] Tick claimed ${result.claimedCount} due job(s): ${result.fired.length} fired, ${result.errors.length} failed.`);
        }
        for (const failure of result.errors) {
            yield* Effect.logWarning(`[smithers-cron] Error processing job ${failure.cronId}: ${failure.error}`);
        }
    }));
}
/**
 * @param {number} pollIntervalMs
 */
export function schedulerLoopEffect(pollIntervalMs) {
    return Effect.scoped(Effect.gen(function* () {
        const { adapter } = yield* acquireSchedulerDbEffect();
        yield* Effect.logInfo("[smithers-cron] Starting background scheduler loop...");
        yield* Effect.logInfo(`[smithers-cron] Polling every ${pollIntervalMs / 1000}s for due jobs.`);
        yield* schedulerTickEffect(adapter).pipe(Effect.repeat(Schedule.spaced(`${pollIntervalMs} millis`)));
    }).pipe(Effect.annotateLogs({ component: "scheduler" }), Effect.ensuring(Effect.logInfo("[smithers-cron] Scheduler stopped.")), Effect.interruptible, Effect.asVoid));
}
function setupAbortSignal() {
    const abort = new AbortController();
    const onSigInt = () => abort.abort();
    const onSigTerm = () => abort.abort();
    process.once("SIGINT", onSigInt);
    process.once("SIGTERM", onSigTerm);
    return {
        signal: abort.signal,
        dispose() {
            process.off("SIGINT", onSigInt);
            process.off("SIGTERM", onSigTerm);
        },
    };
}
export async function runScheduler(pollIntervalMs = 15_000) {
    const abort = setupAbortSignal();
    try {
        await runPromise(schedulerLoopEffect(pollIntervalMs), {
            signal: abort.signal,
        });
    }
    catch (error) {
        abort.dispose();
        if (abort.signal.aborted) {
            process.exit(0);
        }
        throw error;
    }
    abort.dispose();
}
