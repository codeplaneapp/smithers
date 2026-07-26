import { Effect } from "effect";
import { closeSingleRunnerRuntime, runWorkflow } from "smithers-orchestrator";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import {
  buildKillResumeWorkflow,
  type EngineChildMode,
} from "./killResumeWorkflow.ts";

/**
 * Standalone engine child for case31. The test spawns this with `bun` as a
 * SEPARATE OS process so it can be SIGKILLed for real via the killProcess
 * harness. It opens the on-disk sqlite db, builds the shared workflow, and runs
 * (or resumes) it.
 *
 * Usage:
 *   bun engineChildRunner.ts <dbPath> <runId> <initial|resume|probe> <markerDir> <counterFile> [bSleepMs]
 *
 * Mode "probe" is the realProcessAdapter ADMISSION protocol: it proves the
 * repository production runner boots and can open/bootstrap the real on-disk
 * database (production createSmithers + ensureSmithersTables), prints
 * `SMITHERS_ENGINE_HANDSHAKE=probe:<nonce>` and `PROBE_STATUS=ok`, and exits 0
 * WITHOUT executing the target workflow — admission liveness probing is
 * deliberately separated from the runWorkflow transition, which only a
 * runStep-spawned "initial" child performs.
 *
 * It prints a single machine-readable line to stdout when the run resolves:
 *   RESULT_STATUS=<status>
 *
 * It then closes the process-local SingleRunner runtime and returns, setting
 * process.exitCode rather than forcing an exit. The engine used to leave that
 * cluster runtime's daemon fibers alive after runWorkflow resolved, which kept
 * the event loop running and forced a process.exit() here (#1378); the public
 * closeSingleRunnerRuntime() is now the teardown boundary. Closing here is
 * safe: runWorkflow only resolves after the run reaches a terminal/durable
 * state and all output rows are committed to the on-disk db.
 *
 * On the "initial" run this process is expected to be SIGKILLed by the parent
 * before it ever reaches the exit line — that is the whole point.
 */

function fail(message: string): never {
  process.stderr.write(`engineChildRunner: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [dbPath, runId, modeArg, markerDir, counterFile, bSleepMsArg, nonce] =
    process.argv.slice(2);

  if (!dbPath || !runId || !modeArg || !markerDir || !counterFile) {
    fail(
      "missing args: <dbPath> <runId> <initial|resume> <markerDir> <counterFile> [bSleepMs]",
    );
  }
  if (modeArg !== "initial" && modeArg !== "resume" && modeArg !== "probe") {
    fail(`invalid mode ${modeArg}; expected "initial", "resume", or "probe"`);
  }
  // These are the authenticated production-runner protocol markers consumed by
  // realProcessAdapter; an arbitrary long-lived child cannot pass real-process
  // admission or the runWorkflow transition by merely claiming a name in
  // memory. The probe and runWorkflow phases use DISTINCT markers so an
  // admission probe can never be replayed as workflow-transition evidence.
  if (!nonce) fail("missing adapter nonce");
  if (modeArg === "probe") {
    process.stdout.write(`SMITHERS_ENGINE_HANDSHAKE=probe:${nonce}\n`);
    // Prove the production system is executable from this runner — real db
    // bootstrap through production modules — without running the target
    // workflow: no marker files, no attempt rows, no runWorkflow call.
    const { db } = buildKillResumeWorkflow({ dbPath, markerDir, counterFile, mode: "resume" });
    ensureSmithersTables(db);
    process.stdout.write("PROBE_STATUS=ok\n");
    process.exit(0);
  }
  const mode: EngineChildMode = modeArg;
  process.stdout.write(`SMITHERS_ENGINE_HANDSHAKE=runWorkflow:${nonce}\n`);
  const bSleepMs = bSleepMsArg ? Number(bSleepMsArg) : undefined;

  const { workflow, db } = buildKillResumeWorkflow({
    dbPath,
    markerDir,
    counterFile,
    mode,
    bSleepMs,
  });
  ensureSmithersTables(db);

  const opts =
    mode === "resume"
      ? { runId, input: {}, resume: true, force: true }
      : { runId, input: {} };

  const result = await Effect.runPromise(runWorkflow(workflow, opts));
  process.stdout.write(`RESULT_STATUS=${result.status}\n`);
  // See header comment: the run has settled, so closing the process-local
  // SingleRunner runtime lets this child exit on its own (#1378).
  await closeSingleRunnerRuntime();
  process.exitCode = result.status === "finished" ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(
    `engineChildRunner: unhandled error: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`,
  );
  process.exit(3);
});
