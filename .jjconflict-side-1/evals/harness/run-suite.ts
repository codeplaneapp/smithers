// Run one fluency-eval suite via `smithers eval`, writing its report under
// evals/harness/.report/. Model diversity is encoded in the suite's cases.jsonl;
// `--only-model <name>` runs just that model's cases (cheap focused runs).
//
//   bun evals/harness/run-suite.ts knowledge-cli
//   bun evals/harness/run-suite.ts knowledge-cli --only-model haiku -j 4
//   bun evals/harness/run-suite.ts knowledge-cli --max-cases 3 --dry-run
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../lib/paths.js";

export type RunSuiteOptions = {
  onlyModel?: string | null;
  maxCases?: number | null;
  concurrency?: number;
  dryRun?: boolean;
};

const ROOT = repoRoot();
const REPORT_DIR = join(ROOT, "evals", "harness", ".report");

export function suiteDir(suite: string): string {
  return join(ROOT, "evals", "suites", suite);
}

export function reportPath(suite: string): string {
  return join(REPORT_DIR, `${suite}.json`);
}

/** Run a suite. Returns the report path (or null on a dry run / failure to launch). */
export function runSuite(suite: string, opts: RunSuiteOptions = {}): { reportPath: string | null; status: number } {
  const dir = suiteDir(suite);
  const evalFile = join(dir, "eval.tsx");
  let casesFile = join(dir, "cases.jsonl");
  if (!existsSync(evalFile) || !existsSync(casesFile)) {
    throw new Error(`Suite "${suite}" is missing eval.tsx or cases.jsonl in ${dir}`);
  }
  mkdirSync(REPORT_DIR, { recursive: true });

  // Optional per-model filtering → temp cases file.
  let suiteId = suite;
  if (opts.onlyModel) {
    const lines = readFileSync(casesFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const filtered = lines.filter((l) => {
      try {
        return JSON.parse(l)?.input?.model === opts.onlyModel;
      } catch {
        return false;
      }
    });
    if (filtered.length === 0) {
      console.warn(`[run-suite] no cases for model "${opts.onlyModel}" in ${suite}; skipping`);
      return { reportPath: null, status: 0 };
    }
    casesFile = join(REPORT_DIR, `${suite}.${opts.onlyModel}.cases.jsonl`);
    writeFileSync(casesFile, `${filtered.join("\n")}\n`);
    suiteId = `${suite}-${opts.onlyModel}`;
  }

  const args = [
    join(ROOT, "apps/cli/src/index.js"),
    "eval",
    evalFile,
    "--cases",
    casesFile,
    "--suite",
    suiteId,
    "--report",
    reportPath(suiteId),
    "--force",
    "-j",
    String(opts.concurrency ?? 4),
  ];
  if (opts.maxCases) args.push("--max-cases", String(opts.maxCases));
  if (opts.dryRun) args.push("--dry-run");

  const res = spawnSync("bun", args, { cwd: ROOT, stdio: "inherit" });
  return { reportPath: opts.dryRun ? null : reportPath(suiteId), status: res.status ?? 1 };
}

function parseArgs(argv: string[]): { suite: string; opts: RunSuiteOptions } {
  const [suite, ...rest] = argv;
  const opts: RunSuiteOptions = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--only-model") opts.onlyModel = rest[++i];
    else if (a === "--max-cases") opts.maxCases = Number(rest[++i]);
    else if (a === "-j" || a === "--concurrency") opts.concurrency = Number(rest[++i]);
    else if (a === "--dry-run" || a === "-n") opts.dryRun = true;
  }
  return { suite, opts };
}

if (import.meta.main) {
  const { suite, opts } = parseArgs(process.argv.slice(2));
  if (!suite) {
    console.error("usage: bun evals/harness/run-suite.ts <suite> [--only-model m] [--max-cases n] [-j n] [--dry-run]");
    process.exit(2);
  }
  const { status } = runSuite(suite, opts);
  process.exit(status);
}
