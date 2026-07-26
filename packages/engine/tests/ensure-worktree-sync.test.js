import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __engineInternals as I } from "../src/engine.js";

/**
 * Real-git integration coverage for the ensureWorktree exists-path sync cache:
 * within the TTL the per-task `git fetch origin` is skipped (observed via the
 * worktree's per-worktree FETCH_HEAD file), the rebase re-runs as soon as the
 * origin/<base> tracking ref moves, and a TTL of 0 restores the
 * fetch-every-time behavior. All assertions are filesystem-state based.
 */

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number; stdout: string; stderr: string }>}
 */
function runGit(cwd, args) {
  return new Promise((res) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (err) => res({ code: 127, stdout: "", stderr: err.message }));
    child.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
async function git(cwd, args) {
  const res = await runGit(cwd, args);
  if (res.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd} (exit ${res.code}): ${res.stderr}`);
  }
  return res;
}

const COMMIT_IDENTITY = [
  "-c",
  "user.email=test@smithers.sh",
  "-c",
  "user.name=Smithers Test",
  "-c",
  "commit.gpgsign=false",
];

/**
 * @param {string} cwd
 * @param {string} fileName
 * @param {string} content
 * @param {string} message
 */
async function commitFile(cwd, fileName, content, message) {
  writeFileSync(join(cwd, fileName), content, "utf8");
  await git(cwd, ["add", fileName]);
  await git(cwd, [...COMMIT_IDENTITY, "commit", "-m", message]);
}

/**
 * Build a bare origin plus a clone with `main` pushed, so origin/<base>
 * tracking refs exist and fetches/pushes have a real (file-transport) remote.
 */
async function makeFixture() {
  const tmp = mkdtempSync(join(tmpdir(), "smithers-wt-sync-"));
  const originDir = join(tmp, "origin.git");
  const repoDir = join(tmp, "repo");
  const worktreePath = join(tmp, "wt");
  await git(tmp, ["init", "--bare", "-b", "main", "origin.git"]);
  await git(tmp, ["init", "-b", "main", "repo"]);
  await commitFile(repoDir, "README.md", "hello\n", "initial commit");
  await git(repoDir, ["remote", "add", "origin", originDir]);
  await git(repoDir, ["push", "-u", "origin", "main"]);
  return { tmp, originDir, repoDir, worktreePath };
}

/**
 * Per-worktree FETCH_HEAD lives in the linked worktree's private gitdir; its
 * (re)appearance after deletion is the filesystem evidence that a fetch ran.
 *
 * @param {string} worktreePath
 */
function worktreeFetchHeadPath(worktreePath) {
  const raw = readFileSync(join(worktreePath, ".git"), "utf8").trim();
  const match = raw.match(/^gitdir:\s*(.+)$/);
  if (!match?.[1]) {
    throw new Error(`No gitdir pointer at ${worktreePath}/.git`);
  }
  return join(match[1].trim(), "FETCH_HEAD");
}

/** @param {string} path */
function deleteIfExists(path) {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

/** @param {string} repoOrBareDir bare repo dir, or a non-bare repo's .git dir */
function readLooseRef(repoOrBareDir, ref) {
  return readFileSync(join(repoOrBareDir, ref), "utf8").trim();
}

const originalTtlEnv = process.env.SMITHERS_WORKTREE_FETCH_TTL_MS;
/** @type {string[]} */
const tempDirs = [];

afterEach(() => {
  if (originalTtlEnv === undefined) {
    delete process.env.SMITHERS_WORKTREE_FETCH_TTL_MS;
  } else {
    process.env.SMITHERS_WORKTREE_FETCH_TTL_MS = originalTtlEnv;
  }
  I.resetWorktreeSyncCache();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ensureWorktree sync cache (real git)", () => {
  test("within the TTL: fetch is skipped, and a moved origin/<base> still rebases", async () => {
    process.env.SMITHERS_WORKTREE_FETCH_TTL_MS = "600000";
    I.resetWorktreeSyncCache();
    const { tmp, originDir, repoDir, worktreePath } = await makeFixture();
    tempDirs.push(tmp);
    await I.ensureWorktree(repoDir, worktreePath, "smithers-wt", "main");
    // First exists-path sync: pays the fetch (creation-path fetches are not cached).
    await I.ensureWorktree(repoDir, worktreePath, "smithers-wt", "main");
    const fetchHead = worktreeFetchHeadPath(worktreePath);
    expect(existsSync(fetchHead)).toBe(true);
    deleteIfExists(fetchHead);
    // Second sync inside the TTL: no fetch.
    await I.ensureWorktree(repoDir, worktreePath, "smithers-wt", "main");
    expect(existsSync(fetchHead)).toBe(false);
    // Advance main and push from the repo itself: the push moves the local
    // origin/main tracking ref, so the tip check must trigger a rebase
    // even though the fetch is still skipped.
    await commitFile(repoDir, "second.txt", "two\n", "second commit");
    await git(repoDir, ["push", "origin", "main"]);
    const advancedTip = readLooseRef(originDir, "refs/heads/main");
    await I.ensureWorktree(repoDir, worktreePath, "smithers-wt", "main");
    expect(existsSync(fetchHead)).toBe(false);
    expect(readLooseRef(join(repoDir, ".git"), "refs/heads/smithers-wt")).toBe(advancedTip);
    // An external push origin never fetched stays invisible inside the TTL.
    const otherDir = join(tmp, "other");
    await git(tmp, ["clone", originDir, "other"]);
    await commitFile(otherDir, "third.txt", "three\n", "external commit");
    await git(otherDir, ["push", "origin", "main"]);
    await I.ensureWorktree(repoDir, worktreePath, "smithers-wt", "main");
    expect(existsSync(fetchHead)).toBe(false);
    expect(readLooseRef(join(repoDir, ".git"), "refs/heads/smithers-wt")).toBe(advancedTip);
  });

  test("after the TTL expires: fetch runs again and picks up external commits", async () => {
    process.env.SMITHERS_WORKTREE_FETCH_TTL_MS = "200";
    I.resetWorktreeSyncCache();
    const { tmp, originDir, repoDir, worktreePath } = await makeFixture();
    tempDirs.push(tmp);
    await I.ensureWorktree(repoDir, worktreePath, "smithers-wt", "main");
    await I.ensureWorktree(repoDir, worktreePath, "smithers-wt", "main");
    const fetchHead = worktreeFetchHeadPath(worktreePath);
    deleteIfExists(fetchHead);
    const otherDir = join(tmp, "other");
    await git(tmp, ["clone", originDir, "other"]);
    await commitFile(otherDir, "external.txt", "ext\n", "external commit");
    await git(otherDir, ["push", "origin", "main"]);
    const externalTip = readLooseRef(originDir, "refs/heads/main");
    await new Promise((res) => setTimeout(res, 250));
    await I.ensureWorktree(repoDir, worktreePath, "smithers-wt", "main");
    expect(existsSync(fetchHead)).toBe(true);
    expect(readLooseRef(join(repoDir, ".git"), "refs/heads/smithers-wt")).toBe(externalTip);
  });

  test("SMITHERS_WORKTREE_FETCH_TTL_MS=0 disables caching: every sync fetches", async () => {
    process.env.SMITHERS_WORKTREE_FETCH_TTL_MS = "0";
    I.resetWorktreeSyncCache();
    const { tmp, repoDir, worktreePath } = await makeFixture();
    tempDirs.push(tmp);
    await I.ensureWorktree(repoDir, worktreePath, "smithers-wt", "main");
    await I.ensureWorktree(repoDir, worktreePath, "smithers-wt", "main");
    const fetchHead = worktreeFetchHeadPath(worktreePath);
    expect(existsSync(fetchHead)).toBe(true);
    deleteIfExists(fetchHead);
    await I.ensureWorktree(repoDir, worktreePath, "smithers-wt", "main");
    expect(existsSync(fetchHead)).toBe(true);
  });
});

describe("resolveWorktreeFetchTtlMs", () => {
  /**
   * @param {string | undefined} raw
   * @param {number} expected
   */
  function expectTtl(raw, expected) {
    if (raw === undefined) {
      delete process.env.SMITHERS_WORKTREE_FETCH_TTL_MS;
    } else {
      process.env.SMITHERS_WORKTREE_FETCH_TTL_MS = raw;
    }
    expect(I.resolveWorktreeFetchTtlMs()).toBe(expected);
  }

  test("defaults to 60s when unset, blank, or unparsable", () => {
    expectTtl(undefined, 60_000);
    expectTtl("", 60_000);
    expectTtl("  ", 60_000);
    expectTtl("soon", 60_000);
  });

  test("parses integers, keeping 0 and negatives as disable values", () => {
    expectTtl("30000", 30_000);
    expectTtl("0", 0);
    expectTtl("-5", -5);
  });
});
