import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveJjBinary } from "@smthrs/vcs";

import { currentHead } from "../workflows/archive/codex-issue-merge-queue.tsx";

const run = (cwd: string, command: string, args: string[]) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// CI runners have no jj on PATH; the vendored platform package
// (@smthrs/jj-<platform>) provides one. Skip only when even
// that binary is unavailable or not executable.
const jjBinary = resolveJjBinary().path;
const jjAvailable = (() => {
  try {
    execFileSync(jjBinary, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("codex issue merge queue current head", () => {
  test.skipIf(!jjAvailable)(
    "uses a nested Git worktree HEAD instead of its parent jj workspace",
    () => {
      const root = mkdtempSync(join(tmpdir(), "smithers-current-head-"));
      const lane = join(root, "lane");
      try {
        run(root, "git", ["init", "--initial-branch=main"]);
        run(root, "git", ["config", "user.name", "Smithers Test"]);
        run(root, "git", ["config", "user.email", "smithers@example.test"]);
        writeFileSync(join(root, "base.txt"), "base\n");
        run(root, "git", ["add", "base.txt"]);
        run(root, "git", ["commit", "-m", "base"]);
        run(root, jjBinary, ["git", "init", "--colocate"]);
        run(root, "git", ["worktree", "add", lane, "HEAD"]);
        const laneHead = run(lane, "git", ["rev-parse", "HEAD"]);

        writeFileSync(join(root, "parent.txt"), "parent\n");
        run(root, "git", ["add", "parent.txt"]);
        run(root, "git", ["commit", "-m", "parent workspace change"]);
        const parentJjHead = run(root, jjBinary, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);

        expect(existsSync(join(lane, ".git"))).toBe(true);
        expect(parentJjHead).not.toBe(laneHead);
        expect(currentHead(lane)).toBe(laneHead);
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    },
    30_000,
  );

  test("keeps jj reads side-effect-free and checkout-aware", () => {
    const source = Bun.file(join(import.meta.dir, "../workflows/archive/codex-issue-merge-queue.tsx"));
    return source.text().then((text) => {
      expect(text).toContain('execFileSync("jj", ["workspace", "root", "--ignore-working-copy"]');
      expect(text).toContain(
        'execFileSync("jj", ["log", "-r", "@", "--no-graph", "-T", "commit_id", "--ignore-working-copy"]',
      );
      expect(text).toContain('if (existsSync(join(cwd, ".git"))) return git(["rev-parse", "HEAD"], cwd);');
    });
  });
});
