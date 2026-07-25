import { expect, onTestFinished, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

/**
 * `skills add` owns BOTH skill sets. These run the real CLI through a piped
 * (non-TTY) child process with CI=1 — exactly the agent/CI shape that used to
 * skip the curated-skill refresh and report "N skills synced" over a stale
 * `smithers` skill (#1377).
 */

const BUNDLED_SKILL = new URL("../docs/SKILL.md", import.meta.url);
const BUNDLED_BUNDLE = new URL("../docs/llms-full.txt", import.meta.url);

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-skills-home-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  // Claude Code is "present" because its config dir exists.
  mkdirSync(join(dir, ".claude", "skills", "smithers"), { recursive: true });
  writeFileSync(join(dir, ".claude", "skills", "smithers", "SKILL.md"), "---\nname: smithers\n---\nSTALE\n");
  writeFileSync(join(dir, ".claude", "skills", "smithers", "llms-full.txt"), "stale bundle\n");
  return dir;
}

const env = (home) => ({
  HOME: home,
  CI: "1",
  SMITHERS_NO_UPDATE_CHECK: "1",
});

test("skills add refreshes the curated skill in a non-TTY CI session", () => {
  const repo = createTempRepo();
  const home = tempHome();

  const result = runSmithers(["skills", "add"], { cwd: repo.dir, env: env(home), format: null, timeoutMs: 120_000 });

  expect(result.exitCode).toBe(0);
  const dest = join(home, ".claude", "skills", "smithers");
  expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toBe(readFileSync(BUNDLED_SKILL, "utf8"));
  expect(readFileSync(join(dest, "llms-full.txt"), "utf8")).toBe(readFileSync(BUNDLED_BUNDLE, "utf8"));
  // The success output must state both halves, so it cannot mask a stale skill.
  expect(result.stderr).toContain("command skills");
  expect(result.stderr).toContain("curated `smithers` skill");
  expect(result.stderr).toContain("Claude Code");
}, 120_000);

test("skills list reports the curated skill alongside the command skills", () => {
  const repo = createTempRepo();
  const home = tempHome();

  const stale = runSmithers(["skills", "list"], { cwd: repo.dir, env: env(home), format: null, timeoutMs: 120_000 });
  expect(stale.exitCode).toBe(0);
  expect(stale.stderr).toContain("Curated skill (smithers");
  expect(stale.stderr).toContain("stale");
  expect(stale.stderr).toContain("smithers skills add");

  runSmithers(["skills", "add"], { cwd: repo.dir, env: env(home), format: null, timeoutMs: 120_000 });

  const fresh = runSmithers(["skills", "list"], { cwd: repo.dir, env: env(home), format: null, timeoutMs: 120_000 });
  expect(fresh.exitCode).toBe(0);
  expect(fresh.stderr).toContain("Curated skill (smithers");
  expect(fresh.stderr).toContain("current");
  expect(fresh.stderr).not.toContain("stale");
}, 180_000);
