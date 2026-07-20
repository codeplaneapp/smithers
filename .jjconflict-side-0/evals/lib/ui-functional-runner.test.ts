// Proves the ui-functional verifier actually discriminates a good UI from a bad
// one — the guard that keeps the whole ui-functional signal honest. It boots a
// real Gateway + headless Chromium against the fixture run (no mocks):
//   • the known-GOOD reference UI must pass every functional check
//   • the known-BAD UI (status only) must pass mounts+status but FAIL
//     events/output/error/approval
// Skipped when Chromium is not installed (CI without browsers).
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = resolve(HERE, "../..");
const RUNNER = join(HERE, "ui-functional-runner.ts");

function chromiumInstalled(): boolean {
  try {
    const require = createRequire(join(REPO_ROOT, "apps/cli/package.json"));
    const exe = require("playwright").chromium?.executablePath?.();
    return typeof exe === "string" && existsSync(exe);
  } catch {
    return false;
  }
}

const uiTest = chromiumInstalled() ? test : test.skip;

function runVerifier(artifact: string) {
  const dir = mkdtempSync(join(tmpdir(), "uifn-test-"));
  try {
    const out = join(dir, "verdict.json");
    const res = spawnSync("bun", [RUNNER, "--artifact", artifact, "--out", out], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (!existsSync(out)) throw new Error(`no verdict: ${res.stdout}\n${res.stderr}`);
    return JSON.parse(readFileSync(out, "utf8")) as {
      passed: boolean;
      score: number;
      checks: Array<{ name: string; passed: boolean; detail: string }>;
      features: Record<string, boolean>;
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const check = (v: { checks: Array<{ name: string; passed: boolean }> }, name: string) =>
  v.checks.find((c) => c.name === name)?.passed ?? false;

uiTest(
  "the known-good reference UI passes every functional check",
  () => {
    const v = runVerifier(join(HERE, "ui-fixture/known-good-ui.tsx"));
    expect(v.passed).toBe(true);
    for (const name of ["mounts", "status", "events", "output", "error", "approval", "approvalLive"]) {
      expect(check(v, name)).toBe(true);
    }
  },
  360_000,
);

uiTest(
  "the known-bad UI fails events/output/error/approval but mounts + shows status",
  () => {
    const v = runVerifier(join(HERE, "ui-fixture/known-bad-ui.tsx"));
    expect(v.passed).toBe(false);
    expect(check(v, "mounts")).toBe(true);
    expect(check(v, "status")).toBe(true);
    expect(check(v, "events")).toBe(false);
    expect(check(v, "output")).toBe(false);
    expect(check(v, "error")).toBe(false);
    expect(check(v, "approval")).toBe(false);
  },
  360_000,
);
