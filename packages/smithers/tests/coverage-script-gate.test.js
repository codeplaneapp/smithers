// Unit coverage for scripts/coverage.mjs (SCRIPT_COVERAGE / `pnpm coverage`):
// package selection (argv vs SMITHERS_COVERAGE_PACKAGES), the SMITHERS_COVERAGE_DIR
// override, and every fast skip/error path. All selected fixtures are packages
// the script refuses to instrument, so no `bun test --coverage` child is ever
// spawned — each case is a single quick `node` run.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const script = resolve(root, "scripts/coverage.mjs");
const created = [];

setDefaultTimeout(30_000);

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

describe("coverage script gate", () => {
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
