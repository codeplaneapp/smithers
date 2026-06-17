import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveWorktreePath } from "../src/worktree-path.js";

describe("resolveWorktreePath", () => {
    test("resolves absolute paths without using the base root", () => {
        expect(resolveWorktreePath("/tmp/smithers-worktree", { baseRootDir: "/ignored" })).toBe(
            resolve("/tmp/smithers-worktree"),
        );
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
