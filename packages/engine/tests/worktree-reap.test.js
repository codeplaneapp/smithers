import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __engineInternals as I } from "../src/engine.js";
import { listSmithersWorktrees } from "../src/listSmithersWorktrees.js";
import { reapWorktrees } from "../src/reapWorktrees.js";

/**
 * A `<Worktree>` lane is a full checkout. Nothing ever removed them, so a repo
 * driving 64-lane runs accumulated hundreds of registrations and tens of GB.
 * These pin the reaper against real git repositories and real worktrees: a run
 * that is over gives its lanes back, a run that is still live never does, and
 * work that exists nowhere else is never deleted. No mocks.
 */

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  return new Promise((res, rej) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) =>
      code === 0 ? res(stdout) : rej(new Error(`git ${args.join(" ")} failed in ${cwd} (exit ${code}): ${stderr}`)),
    );
  });
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function jj(cwd, args) {
  return new Promise((res, rej) => {
    const child = spawn("jj", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) =>
      code === 0 ? res(stdout) : rej(new Error(`jj ${args.join(" ")} failed in ${cwd} (exit ${code}): ${stderr}`)),
    );
  });
}

// jj takes its identity from the environment, so the suite does not depend on
// the machine having a user-level jj config.
process.env.JJ_USER ??= "smithers-test";
process.env.JJ_EMAIL ??= "test@smithers.sh";

const jjAvailable = (() => {
  try {
    return spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();
const describeIfJj = jjAvailable ? describe : describe.skip;

const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-worktree-reap-")));
let seq = 0;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** @type {string} */
let repo;
/** @type {Map<string, string>} */
let runStatuses;

const getRunStatus = async (/** @type {string} */ runId) => runStatuses.get(runId) ?? null;

beforeEach(async () => {
  repo = join(root, `repo-${seq++}`);
  await git(root, ["init", "-b", "main", repo]);
  await git(repo, ["config", "user.email", "test@smithers.sh"]);
  await git(repo, ["config", "user.name", "smithers-test"]);
  writeFileSync(join(repo, "file.txt"), "hello\n");
  await git(repo, ["add", "file.txt"]);
  await git(repo, ["commit", "-m", "init"]);
  runStatuses = new Map();
});

/**
 * @param {string} lane
 * @param {string} runId
 */
async function createLane(lane, runId) {
  const path = join(repo, "worktrees", lane);
  await I.ensureWorktree(repo, path, `smithers/${lane}`, "main", { runId, workflowName: "test-flow" });
  return path;
}

describe("worktree reaping", () => {
  test("a Smithers-created worktree is registered to its run", async () => {
    const path = await createLane("lane-a", "run-1");
    const worktrees = await listSmithersWorktrees(repo);
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].path).toBe(path);
    expect(worktrees[0].owner.runId).toBe("run-1");
    expect(worktrees[0].owner.workflowName).toBe("test-flow");
    expect(worktrees[0].owner.vcsType).toBe("git");
  });

  test("a hand-made worktree is invisible to the reaper", async () => {
    const manual = join(repo, "worktrees", "by-hand");
    await git(repo, ["worktree", "add", "-b", "mine", manual, "main"]);
    runStatuses.set("run-1", "finished");

    expect(await listSmithersWorktrees(repo)).toHaveLength(0);
    const result = await reapWorktrees({ rootDir: repo, getRunStatus });
    expect(result.removed).toHaveLength(0);
    expect(existsSync(manual)).toBe(true);
  });

  test("a terminal run's clean worktree is removed and its registration pruned", async () => {
    const path = await createLane("lane-a", "run-1");
    runStatuses.set("run-1", "finished");

    const result = await reapWorktrees({ rootDir: repo, getRunStatus });

    expect(result.removed.map((entry) => entry.path)).toEqual([path]);
    expect(existsSync(path)).toBe(false);
    expect(await git(repo, ["worktree", "list"])).not.toContain(path);
    expect(await listSmithersWorktrees(repo)).toHaveLength(0);
  });

  test.each([["running"], ["paused"], ["waiting-approval"], ["waiting-event"]])(
    "a %s run's worktree is never removed",
    async (status) => {
      const path = await createLane("lane-a", "run-1");
      runStatuses.set("run-1", status);

      const result = await reapWorktrees({ rootDir: repo, getRunStatus });

      expect(result.removed).toHaveLength(0);
      expect(result.skipped).toEqual([{ path, runId: "run-1", reason: `run-${status}` }]);
      expect(existsSync(path)).toBe(true);
    },
  );

  test("a run the database does not know is never removed", async () => {
    const path = await createLane("lane-a", "ghost-run");

    const result = await reapWorktrees({ rootDir: repo, getRunStatus });

    expect(result.skipped).toEqual([{ path, runId: "ghost-run", reason: "unknown-run" }]);
    expect(existsSync(path)).toBe(true);
  });

  test("uncommitted work survives a terminal run unless forced", async () => {
    const path = await createLane("lane-a", "run-1");
    runStatuses.set("run-1", "finished");
    writeFileSync(join(path, "agent-work.txt"), "hours of work\n");

    const kept = await reapWorktrees({ rootDir: repo, getRunStatus });
    expect(kept.removed).toHaveLength(0);
    expect(kept.skipped).toEqual([{ path, runId: "run-1", reason: "unsaved-work" }]);
    expect(existsSync(join(path, "agent-work.txt"))).toBe(true);

    const forced = await reapWorktrees({ rootDir: repo, getRunStatus, force: true });
    expect(forced.removed.map((entry) => entry.path)).toEqual([path]);
    expect(existsSync(path)).toBe(false);
  });

  test("an unpushed commit survives a terminal run unless forced", async () => {
    const path = await createLane("lane-a", "run-1");
    runStatuses.set("run-1", "finished");
    writeFileSync(join(path, "agent-work.txt"), "hours of work\n");
    await git(path, ["add", "agent-work.txt"]);
    await git(path, ["commit", "-m", "lane work"]);

    const kept = await reapWorktrees({ rootDir: repo, getRunStatus });
    expect(kept.skipped).toEqual([{ path, runId: "run-1", reason: "unsaved-work" }]);
    expect(existsSync(path)).toBe(true);

    const forced = await reapWorktrees({ rootDir: repo, getRunStatus, force: true });
    expect(forced.removed.map((entry) => entry.path)).toEqual([path]);
    expect(existsSync(path)).toBe(false);
  });

  test("a lane whose commit is already merged into the checkout is reaped", async () => {
    const path = await createLane("lane-a", "run-1");
    runStatuses.set("run-1", "finished");
    writeFileSync(join(path, "agent-work.txt"), "merged work\n");
    await git(path, ["add", "agent-work.txt"]);
    await git(path, ["commit", "-m", "lane work"]);
    await git(repo, ["merge", "--ff-only", "smithers/lane-a"]);

    const result = await reapWorktrees({ rootDir: repo, getRunStatus });

    expect(result.removed.map((entry) => entry.path)).toEqual([path]);
    expect(existsSync(path)).toBe(false);
  });

  test("--dry-run removes nothing and reports what it would remove", async () => {
    const path = await createLane("lane-a", "run-1");
    const live = await createLane("lane-b", "run-2");
    runStatuses.set("run-1", "finished");
    runStatuses.set("run-2", "running");

    const result = await reapWorktrees({ rootDir: repo, getRunStatus, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.removed.map((entry) => entry.path)).toEqual([path]);
    expect(result.skipped).toEqual([{ path: live, runId: "run-2", reason: "run-running" }]);
    expect(result.bytesFreed).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(live)).toBe(true);
    expect(await listSmithersWorktrees(repo)).toHaveLength(2);
  });

  test("--run scopes the reap to one run's lanes", async () => {
    const mine = await createLane("lane-a", "run-1");
    const other = await createLane("lane-b", "run-2");
    runStatuses.set("run-1", "finished");
    runStatuses.set("run-2", "failed");

    const result = await reapWorktrees({ rootDir: repo, getRunStatus, runId: "run-1" });

    expect(result.removed.map((entry) => entry.path)).toEqual([mine]);
    expect(result.skipped).toHaveLength(0);
    expect(existsSync(other)).toBe(true);
  });

  test("--older-than keeps recently used lanes", async () => {
    const path = await createLane("lane-a", "run-1");
    runStatuses.set("run-1", "finished");

    const kept = await reapWorktrees({ rootDir: repo, getRunStatus, olderThanMs: 60_000 });
    expect(kept.skipped).toEqual([{ path, runId: "run-1", reason: "too-recent" }]);
    expect(existsSync(path)).toBe(true);

    const aged = await reapWorktrees({
      rootDir: repo,
      getRunStatus,
      olderThanMs: 60_000,
      nowMs: Date.now() + 3_600_000,
    });
    expect(aged.removed.map((entry) => entry.path)).toEqual([path]);
    expect(existsSync(path)).toBe(false);
  });

  test("a lane reused by a live run is owned by that run, not the finished one", async () => {
    const path = await createLane("lane-a", "run-1");
    await createLane("lane-a", "run-2");
    runStatuses.set("run-1", "finished");
    runStatuses.set("run-2", "running");

    const result = await reapWorktrees({ rootDir: repo, getRunStatus });

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toEqual([{ path, runId: "run-2", reason: "run-running" }]);
    expect(existsSync(path)).toBe(true);
  });
});

describeIfJj("jj workspace reaping", () => {
  /**
   * A jj lane workspace of a colocated repo, created through the same engine
   * path production uses.
   *
   * @param {string} lane
   * @param {string} runId
   */
  async function createJjLane(lane, runId) {
    const path = join(root, `${lane}-${seq++}`);
    await I.ensureWorktree(repo, path, `smithers/${lane}`, "main", { runId, workflowName: "test-flow" });
    return path;
  }

  beforeEach(async () => {
    await jj(repo, ["git", "init", "--colocate"]);
  });

  test("a lane squash-landed onto the base branch is reaped, and is kept until it lands", async () => {
    const path = await createJjLane("lane-a", "run-1");
    runStatuses.set("run-1", "finished");
    writeFileSync(join(path, "agent-work.txt"), "hours of work\n");
    await jj(path, ["describe", "-m", "lane work"]);
    await jj(path, ["new"]);

    const kept = await reapWorktrees({ rootDir: repo, getRunStatus });
    expect(kept.skipped).toEqual([{ path, runId: "run-1", reason: "unsaved-work" }]);
    expect(existsSync(path)).toBe(true);

    // Land it the way the merge queue does: identical content, brand new
    // commit id. Ancestry alone still says the lane commit is nowhere else.
    await jj(repo, ["new", "main", "-m", "landed lane work"]);
    await jj(repo, ["restore", "--from", "smithers/lane-a"]);
    await jj(repo, ["bookmark", "set", "main", "-r", "@", "--allow-backwards"]);
    await jj(repo, ["new", "main"]);

    const result = await reapWorktrees({ rootDir: repo, getRunStatus });
    expect(result.skipped).toHaveLength(0);
    expect(result.removed.map((entry) => entry.path)).toEqual([path]);
    expect(existsSync(path)).toBe(false);
  });

  test("uncommitted work in a landed lane still survives", async () => {
    const path = await createJjLane("lane-b", "run-1");
    runStatuses.set("run-1", "finished");
    writeFileSync(join(path, "agent-work.txt"), "hours of work\n");
    await jj(path, ["describe", "-m", "lane work"]);
    await jj(path, ["new"]);
    await jj(repo, ["new", "main", "-m", "landed lane work"]);
    await jj(repo, ["restore", "--from", "smithers/lane-b"]);
    await jj(repo, ["bookmark", "set", "main", "-r", "@", "--allow-backwards"]);
    await jj(repo, ["new", "main"]);
    writeFileSync(join(path, "not-landed.txt"), "written after the lane landed\n");

    const result = await reapWorktrees({ rootDir: repo, getRunStatus });

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toEqual([{ path, runId: "run-1", reason: "unsaved-work" }]);
    expect(existsSync(join(path, "not-landed.txt"))).toBe(true);
  });
});
