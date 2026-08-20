import { afterAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { CodexAgent, externalGitDirs } from "../src/CodexAgent.js";

const run = promisify(execFile);

/**
 * Extract the value of a `-c key=...` Codex config override from an argv.
 * @param {string[]} args
 * @param {string} key
 * @returns {string | undefined}
 */
function configOverride(args, key) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c" && typeof args[i + 1] === "string" && args[i + 1].startsWith(`${key}=`)) {
      return args[i + 1].slice(`${key}=`.length);
    }
  }
  return undefined;
}

const WRITABLE_ROOTS = "sandbox_workspace_write.writable_roots";

/** Directories to remove when the suite ends. @type {string[]} */
const scratch = [];

/**
 * A repository plus a linked worktree, which is the layout `<Worktree>` lanes
 * create: the worktree's `.git` is a file pointing into the parent repo.
 * @returns {Promise<{ repo: string; worktree: string }>}
 */
async function makeWorktree() {
  const root = await fs.mkdtemp(join(tmpdir(), "codex-worktree-"));
  scratch.push(root);
  const repo = join(root, "repo");
  await fs.mkdir(repo);
  await run("git", ["-C", repo, "init", "--initial-branch=main"]);
  await run("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await run("git", ["-C", repo, "config", "user.name", "Test"]);
  await fs.writeFile(join(repo, "file.txt"), "one\n");
  await run("git", ["-C", repo, "add", "."]);
  await run("git", ["-C", repo, "commit", "-m", "initial"]);
  const worktree = join(root, "lane");
  await run("git", ["-C", repo, "worktree", "add", "-b", "lane", worktree]);
  return { repo, worktree };
}

afterAll(async () => {
  for (const dir of scratch) await fs.rm(dir, { recursive: true, force: true });
});

describe("CodexAgent sandbox widening for worktrees", () => {
  test("an ordinary repository contributes no writable roots", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "codex-plainrepo-"));
    scratch.push(root);
    await run("git", ["-C", root, "init", "--initial-branch=main"]);
    expect(await externalGitDirs(root)).toEqual([]);
  });

  test("a linked worktree reports the gitdir that lives outside it", async () => {
    const { repo, worktree } = await makeWorktree();
    const dirs = await externalGitDirs(worktree);
    expect(dirs.length).toBeGreaterThan(0);
    // Compare through realpath: on macOS the temp root is a symlink
    // (/var -> /private/var) and git reports the resolved form.
    const realRepo = await fs.realpath(repo);
    for (const dir of dirs) {
      expect(dir.startsWith(resolve(worktree))).toBe(false);
      expect(dir.startsWith(realRepo)).toBe(true);
    }
  });

  test("a non-repository directory contributes nothing", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "codex-norepo-"));
    scratch.push(root);
    expect(await externalGitDirs(root)).toEqual([]);
  });

  test("fullAuto in a worktree widens workspace-write to the external gitdir", async () => {
    const { worktree } = await makeWorktree();
    const cmd = await new CodexAgent({ fullAuto: true }).buildCommand({
      prompt: "go",
      cwd: worktree,
      options: {},
    });
    try {
      expect(cmd.args).toContain("--sandbox");
      const roots = configOverride(cmd.args, WRITABLE_ROOTS);
      expect(roots).toBeDefined();
      const parsed = JSON.parse(/** @type {string} */ (roots));
      expect(parsed.length).toBeGreaterThan(0);
      for (const dir of parsed) expect(dir.startsWith(resolve(worktree))).toBe(false);
    } finally {
      await cmd.cleanup?.();
    }
  });

  test("fullAuto in an ordinary repository emits no writable_roots override", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "codex-plain2-"));
    scratch.push(root);
    await run("git", ["-C", root, "init", "--initial-branch=main"]);
    const cmd = await new CodexAgent({ fullAuto: true }).buildCommand({
      prompt: "go",
      cwd: root,
      options: {},
    });
    try {
      expect(configOverride(cmd.args, WRITABLE_ROOTS)).toBeUndefined();
    } finally {
      await cmd.cleanup?.();
    }
  });

  test("an explicit writable_roots config wins over the automatic widening", async () => {
    const { worktree } = await makeWorktree();
    const cmd = await new CodexAgent({
      fullAuto: true,
      config: { [WRITABLE_ROOTS]: ["/custom/root"] },
    }).buildCommand({ prompt: "go", cwd: worktree, options: {} });
    try {
      const overrides = cmd.args.filter((arg, i) =>
        cmd.args[i - 1] === "-c" && typeof arg === "string" && arg.startsWith(`${WRITABLE_ROOTS}=`)
      );
      expect(overrides.length).toBe(1);
      expect(overrides[0]).toContain("/custom/root");
    } finally {
      await cmd.cleanup?.();
    }
  });

  test("a bypassed sandbox needs no widening", async () => {
    const { worktree } = await makeWorktree();
    const cmd = await new CodexAgent({ dangerouslyBypassApprovalsAndSandbox: true }).buildCommand({
      prompt: "go",
      cwd: worktree,
      options: {},
    });
    try {
      expect(configOverride(cmd.args, WRITABLE_ROOTS)).toBeUndefined();
    } finally {
      await cmd.cleanup?.();
    }
  });
});
