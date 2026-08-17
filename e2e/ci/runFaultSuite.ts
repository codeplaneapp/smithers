import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertMatrixInventory,
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

function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
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

const budgetTimer = setTimeout(() => {
  budgetExpired = true;
  child.kill("SIGTERM");
}, budgetMs);
const exitCode = await child.exited;
clearTimeout(budgetTimer);
const elapsedMs = performance.now() - startedAt;

let junit = "";
try {
  junit = readFileSync(junitPath, "utf8");
} catch {
  // A crash or budget kill can happen before Bun flushes the report. Missing
  // cases become flake outcomes below instead of disappearing from history.
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

if (budgetExpired || elapsedMs > budgetMs) {
  const overMs = Math.max(0, elapsedMs - budgetMs);
  console.error(
    `[fault-budget] ${suite} suite exceeded ${budgetName}: elapsed ${formatMs(elapsedMs)}, budget ${formatMs(budgetMs)}, over by ${formatMs(overMs)}`,
  );
  process.exit(1);
}

console.log(
  `[fault-budget] ${suite} suite completed in ${formatMs(elapsedMs)} within ${budgetName}=${formatMs(budgetMs)} (${formatMs(budgetMs - elapsedMs)} headroom)`,
);
process.exit(exitCode);
