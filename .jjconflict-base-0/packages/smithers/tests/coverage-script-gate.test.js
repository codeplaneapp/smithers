// Unit coverage for scripts/coverage.mjs (SCRIPT_COVERAGE / `pnpm coverage`):
// package selection (argv vs SMITHERS_COVERAGE_PACKAGES), the SMITHERS_COVERAGE_DIR
// override, fast skip/error paths, safe compound Bun-test parsing, and
// fail-closed LCOV merge semantics for packages needing isolated Bun processes.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { directBunTestSegments, mergeLcovReports } from "../../../scripts/coverage-utils.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const script = resolve(root, "scripts/coverage.mjs");
const created = [];

setDefaultTimeout(60_000);

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempCoverageDir() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-coverage-gate-"));
  created.push(dir);
  return join(dir, "workspace");
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-coverage-unit-"));
  created.push(dir);
  return dir;
}

function runCoverage(args, { coverageDir, env: extraEnv } = {}) {
  const env = { ...process.env, ...extraEnv };
  // Never inherit ambient selection/inclusion knobs from the host shell.
  if (!extraEnv?.SMITHERS_COVERAGE_PACKAGES) delete env.SMITHERS_COVERAGE_PACKAGES;
  delete env.SMITHERS_COVERAGE_INCLUDE_E2E;
  env.SMITHERS_COVERAGE_DIR = coverageDir;
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function readSummary(coverageDir) {
  const path = join(coverageDir, "summary.json");
  expect(existsSync(path)).toBe(true);
  return JSON.parse(readFileSync(path, "utf8"));
}

function lcovRecord(text, source) {
  return text.split("end_of_record").find((record) => record.includes(`SF:${source}\n`));
}

function lcovCounter(record, name) {
  const match = record?.match(new RegExp(`^${name}:(\\d+)$`, "m"));
  return match ? Number(match[1]) : undefined;
}

describe("coverage script gate", () => {
  test("parses every direct &&-joined Bun test leg and strips nested coverage flags", () => {
    expect(directBunTestSegments(
      "bun test --coverage --coverage-dir old first.test.js && " +
      "bun test --coverage-reporter=lcov --path-ignore-patterns=\"**/dom/**\" tests",
    )).toEqual([
      { phase: "test-1", args: ["first.test.js"] },
      { phase: "test-2", args: ["--path-ignore-patterns=**/dom/**", "tests"] },
    ]);
  });

  test("compound parsing fails closed on unsafe, incomplete, or indirect shell syntax", () => {
    const rejected = [
      "bun test first.test.js; bun test second.test.js",
      "bun test first.test.js || bun test second.test.js",
      "bun test first.test.js | bun test second.test.js",
      "bun test first.test.js > result.txt",
      "bun test $(find tests)",
      "bun test `find tests`",
      "bun test tests/*.test.js",
      "bun test tests/file?.test.js",
      "bun test tests/[ab].test.js",
      "bun test ~/tests",
      "bun test tests/{one,two}.test.js",
      "bun test 'tests/one.test.js'",
      "bun test tests\\one.test.js",
      "bun test %TEST_FILE%",
      "bun test ^tests/one.test.js",
      "bun test \"%TEST_FILE%\"",
      "bun test first.test.js\nbun test second.test.js",
      "bun test first.test.js &&",
      "&& bun test first.test.js",
      "bun test first.test.js && echo skipped",
      "NODE_ENV=test bun test first.test.js",
      "bun test \"unterminated",
      "bun test --coverage-dir",
    ];
    for (const scriptText of rejected) {
      expect(directBunTestSegments(scriptText), scriptText).toBeNull();
    }
  });

  test("LCOV merge unions identities and conservatively preserves aggregate-only counters", () => {
    const dir = tempDir();
    const first = join(dir, "first.info");
    const second = join(dir, "second.info");
    const mergedPath = join(dir, "merged.info");
    writeFileSync(first, `TN:first
SF:src/common.js
FN:1,shared
FNDA:1,shared
FNF:1
FNH:1
DA:1,1
DA:2,0
LF:2
LH:1
BRDA:1,0,0,1
BRDA:1,0,1,-
BRF:2
BRH:1
end_of_record
SF:src/first-only.js
FN:1,firstOnly
FNDA:1,firstOnly
FNF:1
FNH:1
DA:1,1
LF:1
LH:1
BRF:0
BRH:0
end_of_record
SF:src/aggregate-only.js
FNF:2
FNH:1
LF:4
LH:2
BRF:3
BRH:1
end_of_record
SF:src/mixed.js
FN:1,identified
FNDA:1,identified
FNF:3
FNH:1
DA:1,1
LF:4
LH:1
BRDA:1,0,0,1
BRF:2
BRH:1
end_of_record
`);
    writeFileSync(second, `TN:second
SF:src/common.js
FN:1,shared
FN:3,second
FNDA:2,shared
FNDA:1,second
FNF:2
FNH:2
DA:1,2
DA:2,1
DA:3,0
LF:3
LH:2
BRDA:1,0,0,2
BRDA:1,0,1,0
BRF:2
BRH:1
end_of_record
SF:src/second-only.js
FN:1,secondOnly
FNDA:0,secondOnly
FNF:1
FNH:0
DA:1,0
LF:1
LH:0
BRF:0
BRH:0
end_of_record
SF:src/aggregate-only.js
FNF:2
FNH:2
LF:4
LH:3
BRF:3
BRH:2
end_of_record
SF:src/mixed.js
FNF:3
FNH:2
LF:4
LH:3
BRF:2
BRH:1
end_of_record
`);

    mergeLcovReports([first, second], mergedPath);
    const merged = readFileSync(mergedPath, "utf8");
    const common = lcovRecord(merged, "src/common.js");
    expect(common).toBeDefined();
    expect(common).toContain("FNDA:3,shared");
    expect(common).toContain("FNDA:1,second");
    expect(common).toContain("FNF:2");
    expect(common).toContain("FNH:2");
    expect(common).toContain("DA:1,3");
    expect(common).toContain("DA:2,1");
    expect(common).toContain("DA:3,0");
    expect(common).toContain("LF:3");
    expect(common).toContain("LH:2");
    expect(common).toContain("BRDA:1,0,0,3");
    expect(common).toContain("BRDA:1,0,1,0");
    expect(common).toContain("BRF:2");
    expect(common).toContain("BRH:1");
    const aggregateOnly = lcovRecord(merged, "src/aggregate-only.js");
    expect(aggregateOnly).toContain("FNF:2");
    expect(aggregateOnly).toContain("FNH:2");
    expect(aggregateOnly).toContain("LF:4");
    expect(aggregateOnly).toContain("LH:3");
    expect(aggregateOnly).toContain("BRF:3");
    expect(aggregateOnly).toContain("BRH:2");
    const mixed = lcovRecord(merged, "src/mixed.js");
    expect(mixed).toContain("FNDA:1,identified");
    expect(mixed).toContain("FNF:3");
    expect(mixed).toContain("FNH:2");
    expect(mixed).toContain("LF:4");
    expect(mixed).toContain("LH:3");
    expect(mixed).toContain("BRF:2");
    expect(mixed).toContain("BRH:1");
    expect(merged.match(/^SF:/gm)).toHaveLength(5);
  });

  test("LCOV merge resolves identity-incomplete changed totals per metric to the max-found lower bound", () => {
    const cases = [
      { metric: "lines", tag: "LF", first: "FNF:0\nFNH:0\nLF:1\nLH:0", second: "FNF:0\nFNH:0\nLF:2\nLH:0" },
      { metric: "functions", tag: "FNF", first: "FNF:1\nFNH:0\nLF:0\nLH:0", second: "FNF:2\nFNH:0\nLF:0\nLH:0" },
      { metric: "branches", tag: "BRF", first: "FNF:0\nFNH:0\nLF:0\nLH:0\nBRF:1\nBRH:0", second: "FNF:0\nFNH:0\nLF:0\nLH:0\nBRF:2\nBRH:0" },
    ];
    for (const { metric, tag, first: firstCounters, second: secondCounters } of cases) {
      const dir = tempDir();
      const first = join(dir, `${metric}-first.info`);
      const second = join(dir, `${metric}-second.info`);
      writeFileSync(first, `SF:src/ambiguous.js\n${firstCounters}\nend_of_record\n`);
      writeFileSync(second, `SF:src/ambiguous.js\n${secondCounters}\nend_of_record\n`);
      const merged = join(dir, `${metric}-merged.info`);
      mergeLcovReports([first, second], merged);
      expect(readFileSync(merged, "utf8"), metric).toContain(`${tag}:2`);
    }
  });

  test("LCOV merge rejects missing line or function aggregates instead of emitting 0 found", () => {
    const cases = [
      {
        metric: "lines",
        counters: "FNF:0\nFNH:0\nLF:1",
      },
      {
        metric: "functions",
        counters: "FNF:1\nLF:0\nLH:0",
      },
    ];
    for (const { metric, counters } of cases) {
      const dir = tempDir();
      const input = join(dir, `${metric}-missing.info`);
      writeFileSync(input, `SF:src/missing.js\n${counters}\nend_of_record\n`);
      expect(
        () => mergeLcovReports([input], join(dir, `${metric}-merged.info`)),
        metric,
      ).toThrow(`Incomplete LCOV ${metric} aggregates`);
    }
  });

  test("LCOV merge resolves a detailed identity union larger than a stable aggregate to the union", () => {
    const dir = tempDir();
    const first = join(dir, "identity-first.info");
    const second = join(dir, "identity-second.info");
    const aggregateOnly = join(dir, "identity-aggregate.info");
    writeFileSync(first, `SF:src/identity.js
FN:1,first
FNDA:1,first
FNF:1
FNH:1
LF:0
LH:0
end_of_record
`);
    writeFileSync(second, `SF:src/identity.js
FN:2,second
FNDA:0,second
FNF:1
FNH:0
LF:0
LH:0
end_of_record
`);
    writeFileSync(aggregateOnly, `SF:src/identity.js
FNF:1
FNH:0
LF:0
LH:0
end_of_record
`);
    const merged = join(dir, "identity-merged.info");
    mergeLcovReports([first, second, aggregateOnly], merged);
    // Two identified functions exceed the stable aggregate's 1 found: bun's
    // per-leg inventories disagree, so the merge takes the identified union.
    const output = readFileSync(merged, "utf8");
    expect(output).toContain("FNF:2");
    expect(output).toContain("FNH:1");
  });

  test("coverage executes both compound Bun legs and emits their merged report", () => {
    const coverageDir = tempCoverageDir();
    const fixture = "scripts/fixtures/multi-bun-test";
    const result = runCoverage([fixture], { coverageDir });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`[coverage] ${fixture} (test-1):`);
    expect(result.stdout).toContain(`[coverage] ${fixture} (test-2):`);
    expect(result.stdout).toContain("COVERAGE_FIXTURE_SEGMENT_ONE");
    expect(result.stdout).toContain("COVERAGE_FIXTURE_SEGMENT_TWO");
    const lcov = readFileSync(join(coverageDir, fixture, "lcov.info"), "utf8");
    expect(lcov).toContain("SF:src/first.js");
    expect(lcov).toContain("SF:src/second.js");
    const firstLegLcov = readFileSync(
      join(coverageDir, fixture, "1-test-1", "lcov.info"),
      "utf8",
    );
    const rawFirst = lcovRecord(firstLegLcov, "src/first.js");
    const mergedFirst = lcovRecord(lcov, "src/first.js");
    expect(lcovCounter(rawFirst, "FNF")).toBeGreaterThan(0);
    for (const counter of ["LF", "LH", "FNF", "FNH", "BRF", "BRH"]) {
      expect(lcovCounter(mergedFirst, counter), counter).toBe(lcovCounter(rawFirst, counter) ?? 0);
    }
    const secondLegLcov = readFileSync(
      join(coverageDir, fixture, "2-test-2", "lcov.info"),
      "utf8",
    );
    const firstShared = lcovRecord(firstLegLcov, "src/shared.js");
    const secondShared = lcovRecord(secondLegLcov, "src/shared.js");
    const mergedShared = lcovRecord(lcov, "src/shared.js");
    const sharedFound = lcovCounter(firstShared, "FNF");
    expect(sharedFound).toBeGreaterThan(0);
    expect(lcovCounter(secondShared, "FNF")).toBe(sharedFound);
    expect(lcovCounter(mergedShared, "FNF")).toBe(sharedFound);
    // Function identities are absent in Bun 1.3 LCOV, so complementary calls
    // cannot be proven disjoint. Preserve max(FNH) as a conservative union.
    expect(lcovCounter(mergedShared, "FNH")).toBe(Math.max(
      lcovCounter(firstShared, "FNH"),
      lcovCounter(secondShared, "FNH"),
    ));
    const summary = readSummary(coverageDir);
    expect(summary.map((entry) => entry.package)).toEqual([fixture]);
    // Bun 1.3 emits aggregate FNF/FNH without FN/FNDA for these real source
    // files. The merge must preserve that truth instead of turning it into the
    // `0 found` value that threshold evaluation treats as 100% coverage.
    expect(summary[0].functions.found).toBeGreaterThan(0);
    expect(summary[0].functions.hit).toBeGreaterThan(0);
  });

  test("a failing second compound leg fails the package after the first leg ran", () => {
    const coverageDir = tempCoverageDir();
    const fixture = "scripts/fixtures/multi-bun-test";
    const result = runCoverage([fixture], {
      coverageDir,
      env: { COVERAGE_FIXTURE_FAIL_SECOND: "1" },
    });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(1);
    expect(result.stdout).toContain("COVERAGE_FIXTURE_SEGMENT_ONE");
    expect(result.stdout).toContain(`[coverage] ${fixture} (test-2):`);
    expect(readSummary(coverageDir)).toEqual([
      { package: fixture, error: "test-2 bun test exited 1" },
    ]);
  });

  test("an ambiguous out-of-package LCOV source resolves conservatively instead of failing the package", () => {
    const coverageDir = tempCoverageDir();
    const sourceDir = tempDir();
    const fixture = "scripts/fixtures/ambiguous-bun-test";
    // The changing source lives OUTSIDE the covered package, so its SF path is
    // "../"-relative: bun's cross-package attribution noise, resolved with the
    // max-found/max-hit lower bound rather than failing the merge.
    const result = runCoverage([fixture, "e2e"], {
      coverageDir,
      env: { COVERAGE_AMBIGUOUS_SOURCE: join(sourceDir, "changing.js") },
    });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stderr).not.toContain("Ambiguous LCOV");
    const summary = readSummary(coverageDir);
    expect(summary).toHaveLength(2);
    expect(summary[0].package).toBe(fixture);
    expect(summary[0].error).toBeUndefined();
    expect(summary[1]).toMatchObject({ package: "e2e", skipped: true });
  });

  test("LCOV merge resolves ambiguous own-file totals to the max-found lower bound", () => {
    const dir = tempDir();
    const first = join(dir, "own-first.info");
    const second = join(dir, "own-second.info");
    writeFileSync(first, "SF:src/own.js\nFNF:1\nFNH:1\nLF:1\nLH:1\nend_of_record\n");
    writeFileSync(second, "SF:src/own.js\nFNF:2\nFNH:1\nLF:1\nLH:1\nend_of_record\n");
    const merged = join(dir, "own-merged.info");
    mergeLcovReports([first, second], merged);
    const output = readFileSync(merged, "utf8");
    expect(output).toContain("FNF:2");
    expect(output).toContain("FNH:1");
  });

  test("LCOV merge resolves ambiguous out-of-package totals to the max-found lower bound", () => {
    const dir = tempDir();
    const first = join(dir, "dep-first.info");
    const second = join(dir, "dep-second.info");
    writeFileSync(first, "SF:../../packages/dep/src/styles.tsx\nFNF:4\nFNH:2\nLF:4\nLH:2\nend_of_record\n");
    writeFileSync(second, "SF:../../packages/dep/src/styles.tsx\nFNF:3\nFNH:3\nLF:4\nLH:3\nend_of_record\n");
    const merged = join(dir, "dep-merged.info");
    mergeLcovReports([first, second], merged);
    const output = readFileSync(merged, "utf8");
    expect(output).toContain("FNF:4");
    expect(output).toContain("FNH:3");
  });

  test("a package without package.json fails the run but still writes the summary report", () => {
    const coverageDir = tempCoverageDir();
    const result = runCoverage(["packages/does-not-exist"], { coverageDir });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("[coverage] missing package.json for packages/does-not-exist");
    expect(readSummary(coverageDir)).toEqual([]);
  });

  test("coverage-unsupported packages are skipped with a reason and pass", () => {
    const coverageDir = tempCoverageDir();
    const result = runCoverage(["e2e"], { coverageDir });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("[coverage] skip e2e:");
    const summary = readSummary(coverageDir);
    expect(summary).toHaveLength(1);
    expect(summary[0].package).toBe("e2e");
    expect(summary[0].skipped).toBe(true);
    expect(typeof summary[0].reason).toBe("string");
  });

  test("packages whose test script is not a direct bun test are skipped without failing", () => {
    const coverageDir = tempCoverageDir();
    const result = runCoverage(["packages/jj-darwin-arm64"], { coverageDir });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      "[coverage] skip packages/jj-darwin-arm64: test script is not a direct bun test",
    );
    expect(readSummary(coverageDir)).toEqual([]);
  });

  test("SMITHERS_COVERAGE_PACKAGES selects packages, trimming whitespace and empty entries", () => {
    const coverageDir = tempCoverageDir();
    const result = runCoverage([], {
      coverageDir,
      env: { SMITHERS_COVERAGE_PACKAGES: " e2e ,, apps/smithers " },
    });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    const summary = readSummary(coverageDir);
    expect(summary.map((entry) => entry.package).sort()).toEqual(["apps/smithers", "e2e"]);
    expect(summary.every((entry) => entry.skipped)).toBe(true);
  });

  test("argv selection wins over SMITHERS_COVERAGE_PACKAGES", () => {
    const coverageDir = tempCoverageDir();
    const result = runCoverage(["e2e"], {
      coverageDir,
      // If the env selection won, the missing package would exit 1.
      env: { SMITHERS_COVERAGE_PACKAGES: "packages/does-not-exist" },
    });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(readSummary(coverageDir).map((entry) => entry.package)).toEqual(["e2e"]);
  });

  test("absolute package paths are normalized to repo-relative directories", () => {
    const coverageDir = tempCoverageDir();
    const result = runCoverage([join(root, "e2e")], { coverageDir });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(readSummary(coverageDir).map((entry) => entry.package)).toEqual(["e2e"]);
  });

  test("an error in one package does not abort the remaining selection", () => {
    const coverageDir = tempCoverageDir();
    const result = runCoverage(["packages/does-not-exist", "e2e"], { coverageDir });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("[coverage] missing package.json for packages/does-not-exist");
    // The e2e skip entry still lands in the report after the failure.
    expect(readSummary(coverageDir).map((entry) => entry.package)).toEqual(["e2e"]);
  });
});
