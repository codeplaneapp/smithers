import { describe, expect, spyOn, test } from "bun:test";
import { dirname, resolve } from "node:path";
import {
    resetRelativeWorktreePathWarningForTest,
    resolveWorktreePath,
} from "../src/worktree-path.js";

describe("resolveWorktreePath", () => {
    test("resolves absolute paths without using the base root", () => {
        expect(resolveWorktreePath("/tmp/smithers-worktree", { baseRootDir: "/ignored" })).toBe(
            resolve("/tmp/smithers-worktree"),
        );
    });

    test("warns once that relative paths resolve against baseRootDir, not workflowPath dirname", () => {
        resetRelativeWorktreePathWarningForTest();
        const warn = spyOn(console, "warn").mockImplementation(() => {});
        try {
            const baseRootDir = "/tmp/operator-root";
            const workflowPath = "/tmp/operator-root/.smithers/workflows/build.tsx";

            expect(resolveWorktreePath("wt-a", { baseRootDir, workflowPath })).toBe(
                resolve(baseRootDir, "wt-a"),
            );
            expect(resolveWorktreePath("wt-b", { baseRootDir, workflowPath })).toBe(
                resolve(baseRootDir, "wt-b"),
            );

            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toContain("relative <Worktree path>");
            expect(warn.mock.calls[0][1]).toMatchObject({
                code: "WORKTREE_RELATIVE_PATH_BASE_ROOT",
                path: "wt-a",
                base: baseRootDir,
                resolvedPath: resolve(baseRootDir, "wt-a"),
                workflowPath,
                workflowDir: dirname(workflowPath),
            });
        }
        finally {
            warn.mockRestore();
        }
    });

    test("resolves relative paths against an explicit base root", () => {
        expect(resolveWorktreePath("workspace", { baseRootDir: "/tmp/root" })).toBe(
            resolve("/tmp/root", "workspace"),
        );
    });

    test("falls back to cwd when base root is empty or missing", () => {
        expect(resolveWorktreePath("workspace", { baseRootDir: "" })).toBe(
            resolve(process.cwd(), "workspace"),
        );
        expect(resolveWorktreePath("workspace")).toBe(resolve(process.cwd(), "workspace"));
    });

    test("trims input before validation and resolution", () => {
        expect(resolveWorktreePath("  nested/workspace  ", { baseRootDir: "/tmp/root" })).toBe(
            resolve("/tmp/root", "nested/workspace"),
        );
    });

    test("throws a SmithersError for null, undefined, and blank paths", () => {
        for (const value of [null, undefined, "", "   "]) {
            expect(() => resolveWorktreePath(value, { baseRootDir: "/tmp/root" })).toThrow(
                "<Worktree> requires a non-empty path prop",
            );
        }
    });
});
