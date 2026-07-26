import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CronExpressionParser } from "cron-parser";
import { Effect, Schedule } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { runPromise } from "./smithersRuntime.js";
import { findAndOpenDb } from "./find-db.js";
const CLI_ENTRYPOINT = fileURLToPath(new URL("./index.js", import.meta.url));
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/**
 * @typedef {{
 *   cronId: string;
 *   pattern: string;
 *   workflowPath: string;
 *   nextRunAtMs?: number | null;
 * }} SchedulerCronRecord
 */
/**
 * @typedef {{
 *   now?: () => number;
 *   launchCronWorkflow?: (job: SchedulerCronRecord) => void;
 * }} SchedulerTickOptions
 */
/**
 * @param {unknown} error
 */
function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
function acquireSchedulerDbEffect() {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () => findAndOpenDb(),
      catch: (cause) => toSmithersError(cause, "find and open scheduler db"),
    }),
    ({ cleanup }) => Effect.sync(() => cleanup()),
  );
}
/**
 * Starts the workflow process for a due cron record. This is deliberately a
 * narrow boundary so callers that need deterministic clock-driven ticks can
 * observe dispatches without replacing the scheduler's due-selection,
 * cron-parser, or persisted next-run update path.
 *
 * @param {SchedulerCronRecord} job
 * @param {typeof spawn} [spawnProcess]
 */
export function launchCronWorkflow(job, spawnProcess = spawn) {
  const proc = spawnProcess(process.execPath, [CLI_ENTRYPOINT, "up", job.workflowPath, "-d"], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
  });
  proc.unref();
}
/**
 * @param {SmithersDb} adapter
 * @param {SchedulerCronRecord} job
 * @param {number} now
 * @param {(job: SchedulerCronRecord) => void} [launch]
 * @returns {Effect.Effect<void, never>}
 */
export function processCronEffect(adapter, job, now, launch = launchCronWorkflow) {
  return Effect.gen(function* () {
    // Parse before any side effect: an invalid pattern must never launch.
    const nextRunAtMs = yield* Effect.try({
      try: () => {
        const interval = CronExpressionParser.parse(job.pattern, { currentDate: new Date(now) });
        return interval.next().getTime();
      },
      catch: (cause) => toSmithersError(cause, `calculate next run for cron ${job.cronId}`),
    });
    // Persist the advanced schedule before launching. A crash in between
    // skips at most one fire; launching first double-fires whenever a
    // concurrent scheduler sees the same due row or the update fails.
    const claimed = yield* adapter.claimCronRunEffect(job.cronId, job.nextRunAtMs ?? null, now, nextRunAtMs);
    if (!claimed) {
      yield* Effect.logDebug(`[smithers-cron] Skipping ${job.cronId}: another scheduler already claimed this fire`);
      return;
    }
    yield* Effect.logInfo(`[smithers-cron] Triggering due workflow: ${job.workflowPath} (Schedule: ${job.pattern})`);
    yield* Effect.try({
      try: () => launch(job),
      catch: (cause) => toSmithersError(cause, `spawn cron workflow ${job.cronId}`),
    });
  }).pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        const errorMessage = formatError(error);
        yield* Effect.logWarning(`[smithers-cron] Error processing job ${job.cronId}: ${errorMessage}`);
        const failedAtMs = now;
        // Always park the retry in the future; re-persisting a stale past
        // nextRunAtMs re-fires the broken job on every tick.
        yield* adapter
          .updateCronRunTimeEffect(job.cronId, failedAtMs, failedAtMs + 60_000, errorMessage)
          .pipe(
            Effect.catchAll((updateError) =>
              Effect.logWarning(
                `[smithers-cron] Failed to record error for job ${job.cronId}: ${formatError(updateError)}`,
              ),
            ),
          );
      }),
    ),
  );
}
/**
 * @param {SmithersDb} adapter
 * @param {SchedulerTickOptions} [options]
 * @returns {Effect.Effect<void, never>}
 */
export function schedulerTickEffect(adapter, options = {}) {
  return Effect.withLogSpan("scheduler:poll")(
    Effect.gen(function* () {
      const crons = yield* adapter
        .listCronsEffect(true)
        .pipe(
          Effect.catchAll((error) =>
            Effect.logWarning(`[smithers-cron] Tick failed: ${formatError(error)}`).pipe(Effect.as([])),
          ),
        );
      const now = options.now?.() ?? Date.now();
      const launch = options.launchCronWorkflow ?? launchCronWorkflow;
      for (const job of crons) {
        if (typeof job.nextRunAtMs === "number" && now < job.nextRunAtMs) {
          continue;
        }
        yield* processCronEffect(adapter, job, now, launch);
      }
    }),
  );
}
/**
 * @param {number} pollIntervalMs
 */
export function schedulerLoopEffect(pollIntervalMs) {
  return Effect.scoped(
    Effect.gen(function* () {
      const { adapter } = yield* acquireSchedulerDbEffect();
      yield* Effect.logInfo("[smithers-cron] Starting background scheduler loop...");
      yield* Effect.logInfo(`[smithers-cron] Polling every ${pollIntervalMs / 1000}s for due jobs.`);
      yield* schedulerTickEffect(adapter).pipe(Effect.repeat(Schedule.spaced(`${pollIntervalMs} millis`)));
    }).pipe(
      Effect.annotateLogs({ component: "scheduler" }),
      Effect.ensuring(Effect.logInfo("[smithers-cron] Scheduler stopped.")),
      Effect.interruptible,
      Effect.asVoid,
    ),
  );
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
  } catch (error) {
    abort.dispose();
    if (abort.signal.aborted) {
      process.exit(0);
    }
    throw error;
  }
  abort.dispose();
}
