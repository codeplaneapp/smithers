import { writeFileSync } from "node:fs";
import { Effect } from "effect";
import { closeSingleRunnerRuntime, runWorkflow } from "../../src/index.js";
import { buildAgentCheckpointRestartWorkflow } from "./agentCheckpointRestartWorkflow.js";

async function main() {
  const [connectionString, runId, mode, markerDir, readyPath] = process.argv.slice(2);
  if (!connectionString || !runId || !markerDir || !readyPath || !["initial", "resume"].includes(mode)) {
    throw new Error("expected <connectionString> <runId> <initial|resume> <markerDir> <readyPath>");
  }
  const { api, workflow } = await buildAgentCheckpointRestartWorkflow({
    connectionString,
    markerDir,
    mode,
  });
  writeFileSync(readyPath, "ready");
  try {
    const options = mode === "resume" ? { runId, input: {}, resume: true, force: true } : { runId, input: {} };
    const result = await Effect.runPromise(runWorkflow(workflow, options));
    process.stdout.write(`RESULT_STATUS=${result.status}\n`);
    process.exitCode = result.status === "finished" ? 0 : 1;
  } finally {
    await closeSingleRunnerRuntime();
    await api.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(2);
});
