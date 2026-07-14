import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertReleaseTagMatchesHead } from "../../../scripts/release-tag-guard.mjs";

const created = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-release-tag-"));
  created.push(dir);
  git(dir, "init", "--quiet");
  git(dir, "config", "user.name", "Release Guard Test");
  git(dir, "config", "user.email", "release-guard@example.com");
  git(dir, "commit", "--allow-empty", "-m", "base", "--quiet");
  return dir;
}

describe("release tag guard", () => {
  test("allows a tag that resolves to HEAD", () => {
    const dir = scratchRepo();
    git(dir, "tag", "-a", "v9.9.9", "-m", "release");

    expect(() => assertReleaseTagMatchesHead({ cwd: dir, version: "9.9.9" })).not.toThrow();
  });

  test("rejects a tag that resolves behind HEAD with recovery instructions", () => {
    const dir = scratchRepo();
    git(dir, "tag", "-a", "v9.9.9", "-m", "release");
    git(dir, "commit", "--allow-empty", "-m", "new work", "--quiet");

    expect(() => assertReleaseTagMatchesHead({ cwd: dir, version: "9.9.9" })).toThrow(
      /release tag v9\.9\.9 points to .* but HEAD is .*Re-tag.*git tag -f -a v9\.9\.9 HEAD.*force-push.*or bump/s,
    );
  });

  test("allows a release version whose tag does not exist", () => {
    const dir = scratchRepo();
    expect(() => assertReleaseTagMatchesHead({ cwd: dir, version: "9.9.9" })).not.toThrow();
  });
});
