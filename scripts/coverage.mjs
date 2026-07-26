#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { directBunTestSegments, mergeLcovReports } from "./coverage-utils.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const coverageRoot = resolve(repoRoot, process.env.SMITHERS_COVERAGE_DIR ?? "coverage/workspace");

const thresholdProfiles = {
  critical: { lines: 35, functions: 45 },
  library: { lines: 40, functions: 50 },
  app: { lines: 25, functions: 35 },
  default: { lines: 15, functions: 15 },
};

const packageProfiles = new Map([
  ["packages/db", "critical"],
  ["packages/engine", "critical"],
  ["packages/server", "critical"],
  ["packages/gateway-client", "critical"],
  ["packages/time-travel", "critical"],
  ["packages/scheduler", "critical"],
  ["packages/driver", "library"],
  ["packages/accounts", "library"],
  ["packages/usage", "library"],
  ["packages/errors", "library"],
  ["packages/memory", "library"],
  ["packages/gateway", "library"],
  ["packages/gateway-react", "library"],
  ["packages/agents", "library"],
  ["packages/components", "library"],
  ["packages/openapi", "library"],
  ["packages/sandbox", "library"],
  ["packages/scorers", "library"],
  ["packages/vcs", "library"],
  ["packages/pi-plugin", "library"],
  ["packages/react-reconciler", "default"],
  ["packages/graph", "default"],
  ["packages/smithers", "default"],
  ["apps/cli", "app"],
  ["apps/observability", "app"],
  ["apps/review", "app"],
]);

const packageThresholdOverrides = new Map([
  ["packages/agents", { lines: 35, functions: 45 }],
  ["packages/components", { lines: 35, functions: 45 }],
  // Functions lowered 80 -> 78: the txid-capture module (captureTxid.js) added
  // this release is largely Postgres-only (isRealPostgresAdapter /
  // capturePostgresTransactionTxid / recordCommittedTxid ...), so the sqlite
  // coverage leg can only reach their short-circuit branches. Raise back to 80
  // once a Postgres-backed coverage leg exercises the txid path.
  ["packages/db", { lines: 75, functions: 78 }],
  ["packages/engine", { lines: 25, functions: 35 }],
  // Lowered 90/90 -> 60/50 after the M1/M2 sync -> TanStack-DB data-layer
  // rewrite: the Electric-backed modules (createSmithersDataClient's SSE path,
  // the Electric branch of createSmithersCollections, smithersElectricCollection
  // Options) need a live Electric backend that CI does not provision. Raise back
  // as the local REST/SSE data-layer gains unit tests against a seeded gateway.
  ["packages/gateway-client", { lines: 60, functions: 50 }],
  ["packages/scheduler", { lines: 80, functions: 90 }],
  ["packages/time-travel", { lines: 20, functions: 25 }],
]);

const coverageUnsupported = new Map([
  [
    "apps/smithers",
    "The local Smithers UI (served by `smithers ui --app`); covered by normal test/typecheck/e2e jobs, not coverage thresholds.",
  ],
  ["e2e", "Bun coverage can fail while instrumenting the full fault matrix; run e2e through normal test/fault jobs."],
]);

const coverageArgsOverrides = new Map([
  [
    "packages/engine",
    [
      "--timeout=60000",
      "--max-concurrency=1",
      "tests/engine-internals.test.js",
      "tests/engine-small-utils.test.js",
      "tests/engine-scheduler-plan.test.js",
      "tests/scheduler-comprehensive.test.js",
      "tests/crash-recovery.test.js",
      "tests/deferred-state-bridge-internals.test.js",
      "tests/compute-task-bridge-internals.test.js",
      "tests/agent-trace-collector-lifecycle.test.js",
      "tests/workflow-bridge-internals.test.js",
      "tests/activity-bridge-internals.test.js",
      "tests/effect-small-helpers.test.js",
      "tests/aspects-budget-unit.test.js",
      "tests/json-extraction.test.js",
      "tests/json-schema-to-zod.test.js",
      "tests/resolveForkSessionMessages.test.js",
      "tests/snapshot-server.test.js",
    ],
  ],
  [
    "packages/time-travel",
    [
      "tests/vcs-version.test.js",
      "tests/time-travel-metrics.test.js",
      "tests/timeline.test.js",
      "tests/revert.test.js",
      "tests/fork-recovery.test.js",
      "tests/rewindLock-concurrent.test.ts",
      "tests/recoverInProgressRewindAudits.test.ts",
      "tests/time-travel-replay.test.js",
      "tests/jumpToFrame.test.ts",
      "tests/diff.test.js",
      "tests/malformed-json.test.js",
      "tests/rewindAuditHelpers.test.ts",
      "tests/rewindLock.test.ts",
      "tests/replay-edges.test.js",
      "tests/fork.test.js",
      "tests/vcsRestoreSuccess.test.js",
      "tests/rewindRollback.test.ts",
      "tests/snapshot.test.js",
    ],
  ],
  [
    "packages/server",
    [
      "tests/server-parse-params.test.js",
      "tests/gateway-bounds.test.js",
      "tests/gateway-http-boundaries.test.js",
      "tests/gateway-extensions.test.ts",
      "tests/gateway-extensions-dispatch.test.js",
      "tests/getNodeOutput.test.ts",
      "tests/getNodeDiff.test.js",
      "tests/getDevToolsSnapshot.test.tsx",
      "tests/streamDevTools.test.tsx",
      "tests/gateway-v1-contract.test.jsx",
      "tests/gateway-webhooks.test.jsx",
    ],
  ],
]);

function workspacePackageDirs() {
  const dirs = [];
  for (const parent of ["packages", "apps"]) {
    const absParent = join(repoRoot, parent);
    if (!existsSync(absParent)) continue;
    for (const name of readdirSync(absParent)) {
      const dir = join(absParent, name);
      if (existsSync(join(dir, "package.json"))) dirs.push(relative(repoRoot, dir));
    }
  }
  if (existsSync(join(repoRoot, "e2e/package.json"))) dirs.push("e2e");
  return dirs.sort();
}

function selectedPackageDirs() {
  const fromEnv = process.env.SMITHERS_COVERAGE_PACKAGES;
  const fromArgs = process.argv.slice(2);
  const selected =
    fromArgs.length > 0
      ? fromArgs
      : fromEnv
        ? fromEnv
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
        : workspacePackageDirs();
  return selected.map((dir) => relative(repoRoot, resolve(repoRoot, dir)));
}

function pct(hit, found) {
  if (found === 0) return 100;
  return (hit / found) * 100;
}

function readLcovSummary(lcovPath, relDir) {
  const text = readFileSync(lcovPath, "utf8");
  const summary = {
    lines: { hit: 0, found: 0 },
    functions: { hit: 0, found: 0 },
    branches: { hit: 0, found: 0 },
  };
  let includeRecord = true;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      const sourcePath = resolve(repoRoot, relDir, line.slice(3));
      const sourceRel = relative(repoRoot, sourcePath);
      includeRecord = sourceRel === relDir || sourceRel.startsWith(`${relDir}/`);
      continue;
    }
    if (!includeRecord) continue;
    if (line.startsWith("LF:")) summary.lines.found += Number(line.slice(3));
    else if (line.startsWith("LH:")) summary.lines.hit += Number(line.slice(3));
    else if (line.startsWith("FNF:")) summary.functions.found += Number(line.slice(4));
    else if (line.startsWith("FNH:")) summary.functions.hit += Number(line.slice(4));
    else if (line.startsWith("BRF:")) summary.branches.found += Number(line.slice(4));
    else if (line.startsWith("BRH:")) summary.branches.hit += Number(line.slice(4));
  }
  return {
    lines: { ...summary.lines, pct: pct(summary.lines.hit, summary.lines.found) },
    functions: { ...summary.functions, pct: pct(summary.functions.hit, summary.functions.found) },
    branches: { ...summary.branches, pct: pct(summary.branches.hit, summary.branches.found) },
  };
}

function bunTestSegments(pkg, relDir) {
  const override = coverageArgsOverrides.get(relDir);
  if (override) return [{ phase: "test", args: override }];
  // Coverage invokes Bun directly instead of going through pnpm, so preserve
  // safe `bun test ... && bun test ...` boundaries explicitly. Each segment
  // gets its own process and LCOV report; mergeLcovReports unions counters.
  const script = pkg.scripts?.test;
  return typeof script === "string" ? (directBunTestSegments(script) ?? []) : [];
}

function thresholdFor(relDir) {
  const profile = packageProfiles.get(relDir) ?? (relDir.startsWith("apps/") ? "app" : "default");
  return { profile, ...thresholdProfiles[profile], ...packageThresholdOverrides.get(relDir) };
}

rmSync(coverageRoot, { recursive: true, force: true });
mkdirSync(coverageRoot, { recursive: true });

const selected = selectedPackageDirs();
const results = [];
let failed = false;

for (const relDir of selected) {
  const packageJsonPath = join(repoRoot, relDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    console.error(`[coverage] missing package.json for ${relDir}`);
    failed = true;
    continue;
  }
  if (coverageUnsupported.has(relDir) && process.env.SMITHERS_COVERAGE_INCLUDE_E2E !== "1") {
    console.log(`[coverage] skip ${relDir}: ${coverageUnsupported.get(relDir)}`);
    results.push({ package: relDir, skipped: true, reason: coverageUnsupported.get(relDir) });
    continue;
  }
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const testSegments = bunTestSegments(pkg, relDir);
  if (testSegments.length === 0) {
    console.log(`[coverage] skip ${relDir}: test script is not a direct bun test`);
    continue;
  }

  const outDir = join(coverageRoot, relDir);
  mkdirSync(outDir, { recursive: true });
  const lcovPaths = [];
  let segmentFailure = null;
  for (const [index, segment] of testSegments.entries()) {
    const segmentOutDir = testSegments.length === 1 ? outDir : join(outDir, `${index + 1}-${segment.phase}`);
    mkdirSync(segmentOutDir, { recursive: true });
    const args = [
      "test",
      "--coverage",
      "--coverage-reporter=lcov",
      `--coverage-dir=${segmentOutDir}`,
      // Instrumented runs are slower than the plain test jobs, so bun's 5s
      // default per-test timeout flakes on tests that legitimately take a few
      // seconds (gateway-ui canvas interactions, engine validation loops).
      // Give every package a generous ceiling unless its override sets one.
      ...(segment.args.some((arg) => arg.startsWith("--timeout")) ? [] : ["--timeout=60000"]),
      ...segment.args,
    ];
    console.log(`\n[coverage] ${relDir} (${segment.phase}): bun ${args.join(" ")}`);
    const run = spawnSync("bun", args, {
      cwd: join(repoRoot, relDir),
      env: process.env,
      stdio: "inherit",
    });
    if (run.status !== 0) {
      segmentFailure = `${segment.phase} bun test exited ${run.status}`;
      break;
    }
    const segmentLcovPath = join(segmentOutDir, "lcov.info");
    if (!existsSync(segmentLcovPath)) {
      segmentFailure = `${segment.phase} missing lcov.info`;
      break;
    }
    lcovPaths.push(segmentLcovPath);
  }
  if (segmentFailure) {
    failed = true;
    results.push({ package: relDir, error: segmentFailure });
    continue;
  }
  const lcovPath = join(outDir, "lcov.info");
  if (lcovPaths.length > 1) {
    try {
      mergeLcovReports(lcovPaths, lcovPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[coverage] ${relDir}: LCOV merge failed: ${message}`);
      failed = true;
      results.push({ package: relDir, error: `LCOV merge failed: ${message}` });
      continue;
    }
  }

  const summary = readLcovSummary(lcovPath, relDir);
  const threshold = thresholdFor(relDir);
  const linePass = summary.lines.pct >= threshold.lines;
  const fnPass = summary.functions.pct >= threshold.functions;
  const branchNote =
    summary.branches.found === 0
      ? "branch coverage unavailable in this lcov"
      : `${summary.branches.pct.toFixed(2)}% branches`;

  if (!linePass || !fnPass) failed = true;
  results.push({
    package: relDir,
    profile: threshold.profile,
    thresholds: { lines: threshold.lines, functions: threshold.functions },
    lines: summary.lines,
    functions: summary.functions,
    branches: summary.branches,
    branchNote,
    pass: linePass && fnPass,
  });
}

const reportPath = join(coverageRoot, "summary.json");
writeFileSync(reportPath, `${JSON.stringify(results, null, 2)}\n`);

console.log("\n[coverage] summary");
for (const result of results) {
  if (result.error) {
    console.log(`- ${result.package}: ERROR ${result.error}`);
    continue;
  }
  if (result.skipped) {
    console.log(`- SKIP ${result.package}: ${result.reason}`);
    continue;
  }
  const status = result.pass ? "PASS" : "FAIL";
  console.log(
    `- ${status} ${result.package} (${result.profile}): ` +
      `${result.lines.pct.toFixed(2)}% lines, ` +
      `${result.functions.pct.toFixed(2)}% functions, ${result.branchNote}`,
  );
}
console.log(`[coverage] wrote ${relative(repoRoot, reportPath)}`);

if (failed) process.exit(1);
