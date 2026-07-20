// Run every fluency-eval suite, then build the scorecard.
//
//   bun evals/harness/run-all.ts                      # all suites, all models
//   bun evals/harness/run-all.ts --only-model haiku   # cheap: just haiku cases
//   bun evals/harness/run-all.ts --max-cases 2 -j 8   # smoke each suite
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../lib/paths.js";
import { type RunSuiteOptions, runSuite } from "./run-suite.js";

const ROOT = repoRoot();
const SUITES_DIR = join(ROOT, "evals", "suites");

export function discoverSuites(): string[] {
  if (!existsSync(SUITES_DIR)) return [];
  return readdirSync(SUITES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(join(SUITES_DIR, name, "eval.tsx")) && existsSync(join(SUITES_DIR, name, "cases.jsonl")))
    .sort();
}

function parseArgs(argv: string[]): RunSuiteOptions {
  const opts: RunSuiteOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--only-model") opts.onlyModel = argv[++i];
    else if (a === "--max-cases") opts.maxCases = Number(argv[++i]);
    else if (a === "-j" || a === "--concurrency") opts.concurrency = Number(argv[++i]);
    else if (a === "--dry-run" || a === "-n") opts.dryRun = true;
  }
  return opts;
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  const suites = discoverSuites();
  if (suites.length === 0) {
    console.error("No suites found under evals/suites/.");
    process.exit(1);
  }
  console.log(`Running ${suites.length} suite(s): ${suites.join(", ")}`);
  let anyFail = 0;
  for (const suite of suites) {
    console.log(`\n=== ${suite} ===`);
    try {
      const { status } = runSuite(suite, opts);
      if (status !== 0) anyFail = 1;
    } catch (err) {
      console.error(`  ${suite} failed to launch: ${err instanceof Error ? err.message : String(err)}`);
      anyFail = 1;
    }
  }
  if (!opts.dryRun) {
    console.log("\n=== scorecard ===");
    spawnSync("bun", [join(ROOT, "evals/harness/scorecard.ts")], { cwd: ROOT, stdio: "inherit" });
  }
  process.exit(anyFail);
}
