import { describe, expect, test } from "bun:test";
import { buildWorktreeIsolationNotice, WORKTREE_ISOLATION_NOTICE_MARKER } from "../src/buildWorktreeIsolationNotice.js";

describe("buildWorktreeIsolationNotice", () => {
  test("names the parent checkout and forbids node_modules symlink sharing", () => {
    const notice = buildWorktreeIsolationNotice("/repo/.smithers/workflows/.worktrees/sr-task", "/repo");
    expect(notice).not.toBeNull();
    expect(notice).toStartWith(WORKTREE_ISOLATION_NOTICE_MARKER);
    expect(notice).toContain("/repo");
    expect(notice).toContain("pnpm install");
    expect(notice).toContain("NEVER symlink node_modules");
    expect(notice).toContain("NEVER create, modify, or delete anything under /repo");
  });
  test("returns null when the worktree is the root checkout", () => {
    expect(buildWorktreeIsolationNotice("/repo", "/repo")).toBeNull();
    expect(buildWorktreeIsolationNotice("/repo/../repo", "/repo")).toBeNull();
  });
  test("returns null on missing paths", () => {
    expect(buildWorktreeIsolationNotice("", "/repo")).toBeNull();
    expect(buildWorktreeIsolationNotice("/repo/wt", "")).toBeNull();
  });
});
