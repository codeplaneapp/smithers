import { Effect } from "effect";
import { closeSingleRunnerRuntime, runWorkflow } from "smthrs";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { buildGenericAgentCheckpointWorkflow, type GenericCheckpointMode } from "./genericAgentCheckpointWorkflow.ts";

function fail(message: string): never {
  process.stderr.write(`genericAgentCheckpointChildRunner: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [dbPath, runId, modeArg, markerDir, blockMsArg, nonce] = process.argv.slice(2);
  if (!dbPath || !runId || !modeArg || !markerDir || !nonce) {
    fail("missing args: <dbPath> <runId> <initial|resume> <markerDir> [blockMs] <nonce>");
  }
  if (modeArg !== "initial" && modeArg !== "resume") {
    fail(`invalid mode ${modeArg}`);
  }

  const mode: GenericCheckpointMode = modeArg;
  process.stdout.write(`SMITHERS_ENGINE_HANDSHAKE=runWorkflow:${nonce}\n`);
  const { workflow, db } = buildGenericAgentCheckpointWorkflow({
    dbPath,
    markerDir,
    mode,
    blockMs: blockMsArg ? Number(blockMsArg) : undefined,
  });
  ensureSmithersTables(db);

  const options = mode === "resume" ? { runId, input: {}, resume: true, force: true } : { runId, input: {} };
  const result = await Effect.runPromise(runWorkflow(workflow, options));
  process.stdout.write(`RESULT_STATUS=${result.status}\n`);
  await closeSingleRunnerRuntime();
  process.exitCode = result.status === "finished" ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(
    `genericAgentCheckpointChildRunner: unhandled error: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`,
  );
  process.exit(3);
});
