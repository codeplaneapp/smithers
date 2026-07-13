import { Effect } from "effect";
import { runWorkflow } from "smithers-orchestrator";
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
 *   bun engineChildRunner.ts <dbPath> <runId> <initial|resume> <markerDir> <counterFile> [bSleepMs]
 *
 * It prints a single machine-readable line to stdout when the run resolves:
 *   RESULT_STATUS=<status>
 *
 * It then calls process.exit() explicitly. The engine leaves a run supervisor /
 * db handle alive that keeps the event loop running after runWorkflow resolves,
 * so without an explicit exit the child would never terminate on its own — the
 * test would hang waiting for the resume child to exit. Exiting here is safe:
 * runWorkflow only resolves after the run reaches a terminal/durable state and
 * all output rows are committed to the on-disk db.
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
  if (modeArg !== "initial" && modeArg !== "resume") {
    fail(`invalid mode ${modeArg}; expected "initial" or "resume"`);
  }
  const mode: EngineChildMode = modeArg;
  // This is the authenticated production-runner protocol marker consumed by
  // realProcessAdapter admission; an arbitrary long-lived child cannot pass
  // real-process admission by merely claiming a name in memory.
  if (!nonce) fail("missing adapter nonce");
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
  // See header comment: explicit exit is required because the engine keeps the
  // event loop alive after the run resolves.
  process.exit(result.status === "finished" ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(
    `engineChildRunner: unhandled error: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`,
  );
  process.exit(3);
});
