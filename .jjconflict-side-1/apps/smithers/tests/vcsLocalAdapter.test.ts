import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectLocalRepo, readLocalVcsSnapshot } from "../src/vcs/localAdapter";

const tempDirs: string[] = [];

function tempRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `smithers-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function hasCommand(command: string): boolean {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("vcs local adapter", () => {
  test("detects non-repo directories", () => {
    const dir = tempRepo("vcs-empty");
    expect(detectLocalRepo(dir)).toMatchObject({
      workspacePath: dir,
      repoRoot: null,
      primary: null,
      hasGit: false,
      hasJj: false,
    });
  });

  test("detects jj as primary when .jj and .git are both present", () => {
    const dir = tempRepo("vcs-mixed");
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, ".jj"));
    expect(detectLocalRepo(dir)).toMatchObject({
      repoRoot: dir,
      primary: "jj",
      hasGit: true,
      hasJj: true,
    });
  });

  test("reads a real local git repository", async () => {
    if (!hasCommand("git")) {
      console.warn("skipping git adapter test: git is not installed");
      return;
    }

    const dir = tempRepo("vcs-git");
    git(dir, ["init", "-b", "main"]);
    git(dir, ["config", "user.email", "smithers@example.test"]);
    git(dir, ["config", "user.name", "Smithers Test"]);
    writeFileSync(join(dir, "tracked.txt"), "one\n");
    git(dir, ["add", "tracked.txt"]);
    git(dir, ["commit", "-m", "initial"]);
    writeFileSync(join(dir, "tracked.txt"), "two\n");
    writeFileSync(join(dir, "new.txt"), "new\n");

    const snapshot = await readLocalVcsSnapshot(dir);

    expect(snapshot.primary).toBe("git");
    expect(snapshot.detected).toEqual({ git: true, jj: false });
    expect(snapshot.git?.available).toBe(true);
    expect(snapshot.git?.current).toBe("main");
    expect(snapshot.git?.clean).toBe(false);
    expect(snapshot.git?.changes.map((change) => [change.category, change.path])).toEqual([
      ["modified", "tracked.txt"],
      ["untracked", "new.txt"],
    ]);
  });
});
