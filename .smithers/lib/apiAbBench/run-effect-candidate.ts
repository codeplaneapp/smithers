/**
 * Effect-arm candidate runner for the api-ab-benchmark.
 *
 * Loads a candidate module, takes its exported `workflow` (a finalized
 * `G.from(...)` value) and executes it against a throwaway sqlite file, then
 * prints the decoded final result on stdout behind a sentinel so the harness
 * can parse it without guessing which line is the payload.
 *
 * Usage: bun run-effect-candidate.ts <candidateFile> <inputJson> <dbFile>
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Effect } from "effect";
import { Smithers } from "smthrs";

export const RESULT_SENTINEL = "__API_AB_RESULT__";

mkdirSync(dirname(process.argv[4] ?? "."), { recursive: true });

const [candidateFile, inputJson, dbFile] = process.argv.slice(2);
if (!candidateFile || !inputJson || !dbFile) {
  console.error("usage: run-effect-candidate.ts <candidateFile> <inputJson> <dbFile>");
  process.exit(2);
}

// Execute from the throwaway db's directory: it keeps the run's root dir out
// of the smithers checkout (no jj pointer snapshots of a dirty working copy)
// and mirrors what the JSX runner has to do for `createSmithers`.
process.chdir(dirname(dbFile));
const module_ = (await import(candidateFile)) as Record<string, unknown>;
const workflow = (module_.workflow ?? module_.default) as
  | { execute: (input: unknown, opts: { runId: string }) => Effect.Effect<unknown, unknown, never> }
  | undefined;
if (!workflow || typeof workflow.execute !== "function") {
  console.error("candidate module does not export a finalized workflow (export const workflow = G.from(...))");
  process.exit(3);
}

const result = await Effect.runPromise(
  workflow
    .execute(JSON.parse(inputJson), { runId: `api-ab-${Date.now()}` })
    .pipe(Effect.provide(Smithers.sqlite({ filename: dbFile }))),
);
console.log(`${RESULT_SENTINEL}${JSON.stringify(result ?? null)}`);
// The engine keeps daemon fibers alive; a finite runner exits explicitly.
process.exit(0);
