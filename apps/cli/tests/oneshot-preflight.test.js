import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assessWorkingCopy,
  buildPreflightNotice,
  findActiveRunsForWorkingCopy,
  needsPreflightNotice,
} from "../src/oneshot-preflight.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");
const cliEntry = join(repoRoot, "apps/cli/src/index.js");
const tempDirs = [];

function temp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result;
}

function fixtureRepo() {
  const cwd = temp("smithers-oneshot-preflight-");
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.name", "Smithers Test"]);
  git(cwd, ["config", "user.email", "smithers@example.test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(cwd, "tracked.txt"), "initial\n");
  git(cwd, ["add", "tracked.txt"]);
  git(cwd, ["commit", "-m", "initial"]);
  return cwd;
}

describe("assessWorkingCopy", () => {
  test("reports a clean git repository", () => {
    const cwd = fixtureRepo();
    expect(assessWorkingCopy(cwd)).toMatchObject({
      vcs: "git",
      clean: true,
      cwd,
      dirty: { modified: 0, untracked: 0, staged: 0, conflicted: 0 },
      detachedHead: false,
    });
  });

  test("requires preflight for a clean detached HEAD", () => {
    const cwd = fixtureRepo();
    git(cwd, ["checkout", "--detach", "HEAD"]);
    const summary = assessWorkingCopy(cwd);
    expect(summary).toMatchObject({ vcs: "git", clean: true, detachedHead: true });
    expect(needsPreflightNotice(summary)).toBe(true);
    const notice = buildPreflightNotice(summary, "detached-run");
    expect(notice.warning).toContain("detached HEAD");
    expect(notice.preamble).toContain("Create or select a branch before making any goal commit");
  });

  test("counts dirty tracked files", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "tracked.txt"), "changed\n");
    expect(assessWorkingCopy(cwd)).toMatchObject({
      vcs: "git",
      clean: false,
      dirty: { modified: 1, untracked: 0, staged: 0, conflicted: 0 },
    });
  });

  test("counts staged entries separately", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "tracked.txt"), "staged\n");
    git(cwd, ["add", "tracked.txt"]);
    expect(assessWorkingCopy(cwd)).toMatchObject({
      vcs: "git",
      clean: false,
      dirty: { modified: 1, untracked: 0, staged: 1, conflicted: 0 },
    });
  });

  test("counts every untracked file", () => {
    const cwd = fixtureRepo();
    mkdirSync(join(cwd, "notes"));
    writeFileSync(join(cwd, "notes", "one.txt"), "one\n");
    writeFileSync(join(cwd, "notes", "two.txt"), "two\n");
    expect(assessWorkingCopy(cwd)).toMatchObject({
      vcs: "git",
      clean: false,
      dirty: { modified: 0, untracked: 2, staged: 0, conflicted: 0 },
    });
  });

  test("counts a real unmerged conflict", () => {
    const cwd = fixtureRepo();
    git(cwd, ["checkout", "-b", "other"]);
    writeFileSync(join(cwd, "tracked.txt"), "other\n");
    git(cwd, ["commit", "-am", "other"]);
    git(cwd, ["checkout", "main"]);
    writeFileSync(join(cwd, "tracked.txt"), "main\n");
    git(cwd, ["commit", "-am", "main"]);
    expect(git(cwd, ["merge", "other"], { allowFailure: true }).status).not.toBe(0);
    expect(assessWorkingCopy(cwd)).toMatchObject({
      vcs: "git",
      clean: false,
      dirty: { modified: 0, untracked: 0, staged: 0, conflicted: 1 },
    });
  });

  test("skips a non-repository directory", () => {
    expect(assessWorkingCopy(temp("smithers-oneshot-no-vcs-"))).toEqual({ vcs: "none" });
  });
});

test("buildPreflightNotice renders the warning and compact agent triage from the same inventory", () => {
  const notice = buildPreflightNotice(
    {
      vcs: "git",
      clean: false,
      cwd: "/workspace",
      root: "/workspace",
      dirty: { modified: 7, untracked: 3, staged: 2, conflicted: 1 },
      jjConflictPaths: [".jjconflict-base-1"],
      detachedHead: true,
    },
    "oneshot-test-run",
  );
  expect(notice.warning).toBe(
    "oneshot preflight: working copy at /workspace requires attention: 7 modified, 3 untracked, 2 staged, 1 conflicted file(s) (detached HEAD, 1 .jjconflict path(s)); commits can absorb pre-existing work or be left on an unreferenced detached lineage",
  );
  expect(notice.preamble).toContain(
    "chore(preflight): preserve pre-existing working-copy changes before oneshot-test-run",
  );
  expect(notice.preamble).toContain("git stash push");
  expect(notice.preamble).toContain("do NOT resolve, commit, or delete");
  expect(notice.preamble).toContain("`git add` every NEW file");
  expect(notice.preamble).toContain("left the CLI unbootable");
  expect(notice.preamble).toContain("Goal commits contain only goal work");
  expect(notice.preamble.split("\n").length).toBeLessThan(27);
});

function storedRun(cwd, overrides = {}) {
  const now = Date.now();
  return {
    runId: "other-run",
    status: "running",
    createdAtMs: now - 2_000,
    startedAtMs: now - 2_000,
    heartbeatAtMs: now - 1_000,
    runtimeOwnerId: `pid:${process.pid}:test`,
    cancelRequestedAtMs: null,
    errorJson: null,
    configJson: JSON.stringify({ rootDir: cwd }),
    ...overrides,
  };
}

function runAdapter(rows) {
  return {
    listRuns: async () => rows,
    listSandboxes: async () => [],
  };
}

describe("active-run commit guard", () => {
  test("finds live non-terminal runs only for the normalized working directory", async () => {
    const cwd = fixtureRepo();
    const nested = join(cwd, ".", "nested", "..");
    const runs = [
      storedRun(nested, { runId: "active-a" }),
      storedRun(temp("smithers-other-cwd-"), { runId: "other-cwd" }),
    ];
    expect(await findActiveRunsForWorkingCopy(runAdapter(runs), cwd)).toEqual(["active-a"]);
  });

  test("finished runs do not suppress the normal snapshot commit", async () => {
    const cwd = fixtureRepo();
    const activeRunIds = await findActiveRunsForWorkingCopy(
      runAdapter([
        storedRun(cwd, {
          runId: "finished-run",
          status: "finished",
          finishedAtMs: Date.now(),
          heartbeatAtMs: null,
          runtimeOwnerId: null,
        }),
      ]),
      cwd,
    );
    expect(activeRunIds).toEqual([]);
    writeFileSync(join(cwd, "tracked.txt"), "finished run dirt\n");
    const notice = buildPreflightNotice(assessWorkingCopy(cwd), "new-run", { activeRunIds });
    expect(notice.preamble).toContain("chore(preflight): preserve pre-existing working-copy changes");
    expect(notice.preamble).not.toContain("DO NOT commit any pre-existing path");
  });

  test("stale-heartbeat and dead-pid runs do not block commits", async () => {
    const cwd = fixtureRepo();
    const old = Date.now() - 10 * 60_000;
    const activeRunIds = await findActiveRunsForWorkingCopy(
      runAdapter([
        storedRun(cwd, {
          runId: "stale-heartbeat",
          heartbeatAtMs: old,
          startedAtMs: old,
        }),
        storedRun(cwd, {
          runId: "dead-pid",
          heartbeatAtMs: old,
          startedAtMs: old,
          runtimeOwnerId: "pid:2147483647:dead",
        }),
      ]),
      cwd,
    );
    expect(activeRunIds).toEqual([]);
  });

  test("active runs produce a loud id-bearing warning and prohibit pre-existing commits", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "tracked.txt"), "active run dirt\n");
    const notice = buildPreflightNotice(assessWorkingCopy(cwd), "new-run", {
      activeRunIds: ["active-a", "active-b"],
    });
    expect(notice.warning).toContain("ACTIVE RUNS: active-a, active-b");
    expect(notice.warning).toContain("wait for them to finish or use an isolated worktree");
    expect(notice.preamble).toContain("DO NOT commit any pre-existing path");
    expect(notice.preamble).not.toContain("chore(preflight): preserve pre-existing working-copy changes");
  });

  test("force-commit escape hatch is explicit in warning and restores snapshot guidance", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "tracked.txt"), "forced dirt\n");
    const notice = buildPreflightNotice(assessWorkingCopy(cwd), "new-run", {
      activeRunIds: ["active-a"],
      forceCommit: true,
    });
    expect(notice.warning).toContain("--preflight-force-commit overrides the commit guard");
    expect(notice.warning).toContain("prefer waiting for them to finish or use an isolated worktree");
    expect(notice.preamble).toContain("chore(preflight): preserve pre-existing working-copy changes");
  });
});

test("oneshot flag schema parses preflight as auto by default", () => {
  const result = spawnSync(process.execPath, ["run", cliEntry, "oneshot", "--schema", "--format", "json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  const preflight = JSON.parse(result.stdout).options.properties.preflight;
  expect(preflight).toMatchObject({ default: "auto", enum: ["auto", "warn", "off"] });
  expect(JSON.parse(result.stdout).options.properties.preflightForceCommit).toMatchObject({ default: false });
}, 30_000);

test("oneshot warns for dirty and detached cwd states and stays quiet for a clean one", () => {
  const cwd = fixtureRepo();
  const workflowDir = join(cwd, ".smithers", "workflows");
  const binDir = join(cwd, "bin");
  mkdirSync(workflowDir, { recursive: true });
  mkdirSync(binDir);
  const fakeCodex = join(binDir, "codex");
  writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeCodex, 0o755);
  writeFileSync(join(cwd, ".gitignore"), ".smithers/*\n.home/\nsmithers.db*\n");
  writeFileSync(
    join(workflowDir, "oneshot.tsx"),
    `/** @jsxImportSource smthrs */
import { createSmithers } from "${pathToFileURL(join(repoRoot, "packages/smithers/src/index.js")).href}";
import { z } from "${pathToFileURL(join(repoRoot, "node_modules/zod/index.js")).href}";
const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({ goal: z.string(), review: z.enum(["on", "off"]), model: z.string() }),
  receipt: z.object({ ok: z.boolean() }),
});
export default smithers(() => <Workflow name="custom-oneshot"><Task id="done" output={outputs.receipt}>{async () => ({ ok: true })}</Task></Workflow>);
`,
  );
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "add oneshot fixture"]);
  const env = {
    ...process.env,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    SMITHERS_HOME: join(cwd, ".home"),
    SMITHERS_NO_SKILL_REFRESH: "1",
    OPENAI_API_KEY: "sk-oneshot-preflight-fixture",
  };
  let runNumber = 0;
  const run = () =>
    spawnSync(
      process.execPath,
      [
        "run",
        cliEntry,
        "oneshot",
        "test preflight",
        "--run-id",
        `preflight-e2e-${++runNumber}`,
        "--detach",
        "false",
        "--open",
        "false",
        "--review",
        "off",
      ],
      { cwd, env, encoding: "utf8", timeout: 30_000 },
    );

  const clean = run();
  if (clean.status !== 0) {
    throw new Error(`clean oneshot failed:\nstdout=${clean.stdout}\nstderr=${clean.stderr}`);
  }
  expect(clean.status).toBe(0);
  expect(`${clean.stdout}${clean.stderr}`).not.toContain("oneshot preflight: working copy");

  git(cwd, ["checkout", "--detach", "HEAD"]);
  const detached = run();
  if (detached.status !== 0) {
    throw new Error(`detached oneshot failed:\nstdout=${detached.stdout}\nstderr=${detached.stderr}`);
  }
  expect(`${detached.stdout}${detached.stderr}`).toContain("oneshot preflight: working copy at");
  expect(`${detached.stdout}${detached.stderr}`).toContain("detached HEAD");
  git(cwd, ["checkout", "main"]);

  writeFileSync(join(cwd, "tracked.txt"), "dirty\n");
  const dirty = run();
  if (dirty.status !== 0) {
    throw new Error(`dirty oneshot failed:\nstdout=${dirty.stdout}\nstderr=${dirty.stderr}`);
  }
  expect(dirty.status).toBe(0);
  expect(`${dirty.stdout}${dirty.stderr}`).toContain("oneshot preflight: working copy at");
  expect(`${dirty.stdout}${dirty.stderr}`).toContain("1 modified");
  const db = new Database(join(cwd, "smithers.db"), { readonly: true });
  try {
    const row = db
      .query("select config_json as configJson from _smithers_runs where run_id = ?")
      .get("preflight-e2e-3");
    expect(JSON.parse(row.configJson).oneshot.preflight).toMatchObject({
      mode: "auto",
      vcs: "git",
      clean: false,
      dirty: { modified: 1, untracked: 0, staged: 0, conflicted: 0 },
      detachedHead: false,
    });
  } finally {
    db.close();
  }
}, 60_000);
