/**
 * JSX-arm candidate runner for the api-ab-benchmark.
 *
 * Loads a candidate module (default export = the `smithers(...)` workflow) and
 * executes it with `runWorkflow` against a throwaway sqlite file, then prints
 * the run's final result row on stdout behind the same sentinel the Effect
 * runner uses, so both arms are scored by identical downstream code.
 *
 * `createSmithers` resolves its db path at module-import time from the process
 * cwd, so the runner chdirs into the throwaway db's directory BEFORE importing
 * the candidate. That keeps candidates free of harness-specific plumbing: the
 * Effect arm gets its persistence layer from the runner too.
 *
 * Usage: bun run-jsx-candidate.ts <candidateFile> <inputJson> <dbFile>
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Effect } from "effect";
import { runWorkflow } from "smithers-orchestrator";

export const RESULT_SENTINEL = "__API_AB_RESULT__";

/** Output rows carry runtime-managed columns; the scored result is the payload without them. */
export function stripReservedColumns(row: Record<string, unknown>): Record<string, unknown> {
  const { runId: _runId, nodeId: _nodeId, iteration: _iteration, ...rest } = row;
  return rest;
}

mkdirSync(dirname(process.argv[4] ?? "."), { recursive: true });

const [candidateFile, inputJson, dbFile] = process.argv.slice(2);
if (!candidateFile || !inputJson || !dbFile) {
  console.error("usage: run-jsx-candidate.ts <candidateFile> <inputJson> <dbFile>");
  process.exit(2);
}

process.chdir(dirname(dbFile));
const module_ = (await import(candidateFile)) as Record<string, unknown>;
const workflow = module_.default;
if (!workflow) {
  console.error("candidate module has no default export (export default smithers(...))");
  process.exit(3);
}

const result = await Effect.runPromise(
  runWorkflow(workflow, {
    input: JSON.parse(inputJson),
    runId: `api-ab-${Date.now()}`,
  }),
);
if (result.status !== "finished") {
  console.error(`run ended with status ${result.status}: ${JSON.stringify(result.error ?? null)}`);
  process.exit(4);
}
const rows = (Array.isArray(result.output) ? result.output : []) as Record<string, unknown>[];
const last = rows.at(-1);
if (!last) {
  console.error("run finished but wrote no result row; pass { output: outputs.result } to smithers(...)");
  process.exit(5);
}
console.log(`${RESULT_SENTINEL}${JSON.stringify(stripReservedColumns(last))}`);
// The engine keeps daemon fibers alive; a finite runner exits explicitly.
process.exit(0);
