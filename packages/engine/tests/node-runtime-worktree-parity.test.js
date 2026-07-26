import { describe, expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { createNodeRuntime } from "../src/node-runtime.js";
import { resetRelativeWorktreePathWarningForTest } from "@smithers-orchestrator/graph";

/**
 * `createNodeRuntime().worktree.resolve` wraps the real, unmodified
 * `resolveWorktreePath` from `@smithers-orchestrator/graph` — these tests
 * pin the exact current contract (see packages/graph/tests/worktree-path.test.js)
 * so wiring it through `RuntimeAdapter` cannot silently regress it.
 */
describe("createNodeRuntime worktree parity", () => {
  test("empty path throws WORKTREE_EMPTY_PATH", () => {
    const runtime = createNodeRuntime();
    expect(() => runtime.worktree.resolve("")).toThrow(/non-empty path|WORKTREE_EMPTY_PATH/);
    expect(() => runtime.worktree.resolve("   ")).toThrow(/non-empty path|WORKTREE_EMPTY_PATH/);
  });

  test("relative path resolves against baseRootDir with the existing warn-once behavior", () => {
    resetRelativeWorktreePathWarningForTest();
    const runtime = createNodeRuntime();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = runtime.worktree.resolve("lane-a", { baseRootDir: "/repo/workflows" });
      expect(result).toBe(resolve("/repo/workflows", "lane-a"));
      expect(warn).toHaveBeenCalledTimes(1);
      // Warn-once: a second relative resolution in the same process does not warn again.
      runtime.worktree.resolve("lane-b", { baseRootDir: "/repo/workflows" });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("absolute path passes through resolve() unchanged (still normalized)", () => {
    const runtime = createNodeRuntime();
    expect(runtime.worktree.resolve("/already/absolute/lane")).toBe(resolve("/already/absolute/lane"));
  });

  test("../lane parent-relative paths normalize against baseRootDir", () => {
    resetRelativeWorktreePathWarningForTest();
    const runtime = createNodeRuntime();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = runtime.worktree.resolve("../sibling-lane", {
        baseRootDir: "/repo/workflows/nested",
      });
      expect(result).toBe(resolve("/repo/workflows/nested", "../sibling-lane"));
      expect(result).toBe(resolve("/repo/workflows/sibling-lane"));
    } finally {
      warn.mockRestore();
    }
  });

  test("falls back to process.cwd() when no baseRootDir is given", () => {
    const runtime = createNodeRuntime();
    expect(runtime.worktree.resolve("relative-lane")).toBe(resolve(process.cwd(), "relative-lane"));
  });
});
