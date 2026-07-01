#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  ["packages/db", { lines: 75, functions: 80 }],
  ["packages/engine", { lines: 25, functions: 35 }],
  ["packages/gateway-client", { lines: 90, functions: 90 }],
  ["packages/scheduler", { lines: 80, functions: 90 }],
  ["packages/time-travel", { lines: 20, functions: 25 }],
]);

const coverageUnsupported = new Map([
  ["apps/smithers", "The local Smithers UI (served by `smithers ui --app`); covered by normal test/typecheck/e2e jobs, not coverage thresholds."],
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

function shellWords(input) {
  const words = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) words.push(current);
  return words;
}

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
  const selected = fromArgs.length > 0
    ? fromArgs
    : fromEnv
      ? fromEnv.split(",").map((part) => part.trim()).filter(Boolean)
      : workspacePackageDirs();
  return selected.map((dir) => relative(repoRoot, resolve(repoRoot, dir)));
}

function bunTestArgs(script) {
  const words = shellWords(script);
  const bunIndex = words.indexOf("bun");
  if (bunIndex < 0 || words[bunIndex + 1] !== "test") return null;
  return words.slice(bunIndex + 2).filter((arg) => {
    return arg !== "--coverage" &&
      !arg.startsWith("--coverage-reporter") &&
      !arg.startsWith("--coverage-dir");
  });
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
  const testScript = pkg.scripts?.test;
  const testArgs = coverageArgsOverrides.get(relDir) ??
    (typeof testScript === "string" ? bunTestArgs(testScript) : null);
  if (!testArgs) {
    console.log(`[coverage] skip ${relDir}: test script is not a direct bun test`);
    continue;
  }

  const outDir = join(coverageRoot, relDir);
  mkdirSync(outDir, { recursive: true });
  const args = [
    "test",
    "--coverage",
    "--coverage-reporter=lcov",
    `--coverage-dir=${outDir}`,
    ...testArgs,
  ];
  console.log(`\n[coverage] ${relDir}: bun ${args.join(" ")}`);
  const run = spawnSync("bun", args, {
    cwd: join(repoRoot, relDir),
    env: process.env,
    stdio: "inherit",
  });
  if (run.status !== 0) {
    failed = true;
    results.push({ package: relDir, error: `bun test exited ${run.status}` });
    continue;
  }

  const lcovPath = join(outDir, "lcov.info");
  if (!existsSync(lcovPath)) {
    failed = true;
    results.push({ package: relDir, error: "missing lcov.info" });
    continue;
  }

  const summary = readLcovSummary(lcovPath, relDir);
  const threshold = thresholdFor(relDir);
  const linePass = summary.lines.pct >= threshold.lines;
  const fnPass = summary.functions.pct >= threshold.functions;
  const branchNote = summary.branches.found === 0
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
