import { Effect } from "effect";
import { closeSingleRunnerRuntime, runWorkflow } from "smthrs";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { getParityFixture } from "./fixtures/index.ts";

/**
 * Standalone engine child for `crash-resume` parity fixtures.
 *
 * The suite spawns this with `bun` as a SEPARATE OS process so it can be
 * SIGKILLed for real. It opens the on-disk database, rebuilds the named
 * fixture (both processes import the same fixture module, so they agree on
 * the workflow shape, node ids, and output schemas), and runs or resumes it.
 *
 *   bun parityChildRunner.ts <fixtureId> <dbPath> <runId> <initial|resume> <scratchDir>
 *
 * On the "initial" run this process is expected to be killed before it
 * reaches its exit line; that is the fault being injected.
 */

function fail(message: string): never {
  process.stderr.write(`parityChildRunner: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [fixtureId, dbPath, runId, modeArg, scratchDir] = process.argv.slice(2);
  if (!fixtureId || !dbPath || !runId || !modeArg || !scratchDir) {
    fail("missing args: <fixtureId> <dbPath> <runId> <initial|resume> <scratchDir>");
  }
  if (modeArg !== "initial" && modeArg !== "resume") {
    fail(`invalid mode ${modeArg}; expected "initial" or "resume"`);
  }

  const fixture = getParityFixture(fixtureId);
  const build = fixture.build({ dbPath, runId, mode: modeArg, scratchDir });
  ensureSmithersTables(build.db as never);

  // `force` is required on resume: a fresh process is not the owner that
  // wrote the run row, and without it the engine refuses to steal the lease.
  const options =
    modeArg === "resume"
      ? { runId, input: build.input, resume: true, force: true }
      : { runId, input: build.input };

  const result = await Effect.runPromise(runWorkflow(build.workflow as never, options));
  process.stdout.write(`PARITY_RESULT_STATUS=${result.status}\n`);
  build.close();
  // The run has settled and every output row is committed, so closing the
  // process-local SingleRunner runtime lets this child exit on its own.
  await closeSingleRunnerRuntime();
  process.exitCode = 0;
}

main().catch((error) => {
  process.stderr.write(
    `parityChildRunner: unhandled error: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`,
  );
  process.exit(3);
});
