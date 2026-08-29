import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertMatrixInventory,
  budgetVerdict,
  loadMatrix,
  mergeHistory,
  parseJUnitResults,
  readHistory,
  repoRelativeFaultFiles,
  REPO_ROOT,
  writeJsonAtomic,
} from "./faultMatrix.ts";

type Suite = "pr" | "nightly";

function requestedSuite(): Suite {
  const index = process.argv.indexOf("--suite");
  const suite = index >= 0 ? process.argv[index + 1] : undefined;
  if (suite !== "pr" && suite !== "nightly") {
    throw new Error("usage: bun ci/runFaultSuite.ts --suite <pr|nightly>");
  }
  return suite;
}

const suite = requestedSuite();
const matrix = loadMatrix();
assertMatrixInventory(matrix);
const budget = JSON.parse(readFileSync(join(REPO_ROOT, "e2e/budgets/latency.json"), "utf8")) as {
  perPRSuiteWallTimeMaxMs: number;
  nightlySoakWallTimeMaxMs: number;
};
const budgetMs = suite === "pr" ? budget.perPRSuiteWallTimeMaxMs : budget.nightlySoakWallTimeMaxMs;
const budgetName = suite === "pr" ? "perPRSuiteWallTimeMaxMs" : "nightlySoakWallTimeMaxMs";
if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) throw new Error(`Invalid ${budgetName}`);

const tempDir = mkdtempSync(join(tmpdir(), "smithers-fault-suite-"));
const junitPath = join(tempDir, "junit.xml");
const startedAt = performance.now();
let budgetExpired = false;

const child = Bun.spawn(
  [
    "bun",
    "test",
    ...repoRelativeFaultFiles(matrix),
    "--reporter=junit",
    `--reporter-outfile=${junitPath}`,
    "--no-orphans",
  ],
  {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      ...(suite === "nightly" ? { SMITHERS_E2E_SOAK: "1" } : {}),
    },
  },
);

// A suite that ignores SIGTERM would otherwise sit until the GitHub job
// timeout, which is exactly the outcome the budget exists to prevent.
const HARD_KILL_GRACE_MS = 30_000;
let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
const budgetTimer = setTimeout(() => {
  budgetExpired = true;
  child.kill("SIGTERM");
  hardKillTimer = setTimeout(() => child.kill("SIGKILL"), HARD_KILL_GRACE_MS);
}, budgetMs);
const exitCode = await child.exited;
clearTimeout(budgetTimer);
if (hardKillTimer) clearTimeout(hardKillTimer);
const elapsedMs = performance.now() - startedAt;

let junit = "";
try {
  junit = readFileSync(junitPath, "utf8");
} catch {
  // A crash or budget kill can happen before Bun flushes the report. Those
  // cases become incomplete outcomes below instead of disappearing from
  // history, so the run still fails closed without inventing flakes.
}
const results = parseJUnitResults(junit, matrix);
const resultPath = process.env.SMITHERS_E2E_FLAKE_RESULTS;
if (resultPath) {
  writeJsonAtomic(resultPath, {
    version: 1,
    suite,
    runId: process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`,
    elapsedMs,
    budgetMs,
    cases: results,
  });
}

const historyPath = process.env.SMITHERS_E2E_FLAKE_HISTORY;
if (historyPath) {
  const runId = `${process.env.GITHUB_RUN_ID ?? "local"}:${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`;
  writeJsonAtomic(historyPath, mergeHistory(readHistory(historyPath), results, runId));
}
rmSync(tempDir, { recursive: true, force: true });

const verdict = budgetVerdict({
  suite,
  budgetName,
  budgetMs,
  elapsedMs,
  killedAtBudget: budgetExpired,
});
if (!verdict.ok) {
  console.error(verdict.message);
  process.exit(1);
}

console.log(verdict.message);
process.exit(exitCode);
