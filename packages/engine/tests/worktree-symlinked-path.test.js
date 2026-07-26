import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { __engineInternals as I } from "../src/engine.js";

/**
 * Regression coverage: a `<Worktree path>` under a SYMLINKED root failed to
 * create in a jj repo with WORKTREE_CREATE_FAILED ("Git metadata for jj
 * workspace ... does not resolve back to the workspace root").
 *
 * Cause: the post-create verification compared `resolve(gitTopLevel)` against
 * `resolve(worktreePath)`. `resolve()` normalizes but never follows symlinks,
 * while `git rev-parse --show-toplevel` always reports the REAL path. On macOS
 * `/tmp` is a symlink to `/private/tmp`, so every `<Worktree path="/tmp/...">`
 * lane in a jj repo died at creation — four parallel lanes of one production
 * run failed simultaneously this way. Linux `/tmp` is a real directory, which
 * is why it never reproduced in CI.
 */

const jjAvailable = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0;
const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

/** @type {string[]} */
const cleanup = [];
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

/** @param {string} prefix */
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

describe("isSamePath", () => {
  test("treats a symlinked path and its real target as the same location", () => {
    const real = tempDir("sym-real-");
    const linkParent = tempDir("sym-link-");
    const link = join(linkParent, "alias");
    symlinkSync(real, link);

    // The exact shape that broke: git answers with the real path, the
    // caller holds the symlinked one.
    expect(I.isSamePath(link, real)).toBe(true);
    expect(I.isSamePath(join(link, "sub"), join(real, "sub"))).toBe(false); // neither exists yet
    mkdirSync(join(real, "sub"));
    expect(I.isSamePath(join(link, "sub"), join(real, "sub"))).toBe(true);
    expect(resolve(link) === resolve(real)).toBe(false); // the old comparison disagreed
  });

  test("keeps distinct directories distinct", () => {
    const a = tempDir("sym-a-");
    const b = tempDir("sym-b-");
    expect(I.isSamePath(a, b)).toBe(false);
  });

  test("falls back to normalization for paths that do not exist", () => {
    expect(I.isSamePath("/nope/does/not/exist", "/nope/does/not/exist")).toBe(true);
    expect(I.isSamePath("/nope/does/not/exist", "/nope/other")).toBe(false);
    expect(I.isSamePath("/nope/a/../b", "/nope/b")).toBe(true);
  });
});

describe.skipIf(!jjAvailable || !gitAvailable)("ensureWorktree under a symlinked root (jj)", () => {
  test("creates a jj workspace when the path goes through a symlink", async () => {
    const root = tempDir("uf-repo-");
    const repo = join(root, "repo");
    mkdirSync(repo);
    const run = (cmd, args, cwd) => {
      const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
      if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
      return res.stdout;
    };
    run("git", ["init", "-q", "-b", "main", "."], repo);
    run("git", ["config", "user.email", "t@example.com"], repo);
    run("git", ["config", "user.name", "t"], repo);
    writeFileSync(join(repo, "README.md"), "seed\n");
    run("git", ["add", "README.md"], repo);
    run("git", ["commit", "-qm", "seed"], repo);
    run("jj", ["git", "init", "--colocate"], repo);

    // Reach the SAME repo through a symlinked parent, the way /tmp does.
    const linkParent = tempDir("uf-link-");
    const linkedRoot = join(linkParent, "alias");
    symlinkSync(root, linkedRoot);
    const worktreePath = join(linkedRoot, "repo-lanes", "lane-A");

    await I.ensureWorktree(repo, worktreePath, "uf/lane-a", "main", undefined);

    expect(existsSync(join(worktreePath, ".jj"))).toBe(true);
    const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: worktreePath, encoding: "utf8" });
    expect(top.status).toBe(0);
    // git reports the real path; the workspace is still the one we asked for.
    expect(I.isSamePath(top.stdout.trim(), worktreePath)).toBe(true);
  }, 120_000);
});
