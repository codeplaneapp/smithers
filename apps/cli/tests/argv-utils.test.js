import { describe, expect, test } from "bun:test";
import {
    findFirstPositionalIndex,
    parseMcpSurfaceArgv,
    rewriteBareResumeFlagArgv,
} from "../src/argv-utils.js";

describe("argv-utils", () => {
    describe("parseMcpSurfaceArgv", () => {
        test("defaults to semantic and preserves argv without a surface flag", () => {
            const argv = ["mcp", "--format", "json"];

            expect(parseMcpSurfaceArgv(argv)).toEqual({
                surface: "semantic",
                argv,
            });
        });

        test("removes separate and equals-form surface flags", () => {
            expect(parseMcpSurfaceArgv(["mcp", "--surface", "raw", "--format", "json"])).toEqual({
                surface: "raw",
                argv: ["mcp", "--format", "json"],
            });

            expect(parseMcpSurfaceArgv(["mcp", "--surface=both", "--verbose"])).toEqual({
                surface: "both",
                argv: ["mcp", "--verbose"],
            });
        });

        test("normalizes surface values and lets the last surface flag win", () => {
            expect(parseMcpSurfaceArgv(["mcp", "--surface", " RAW ", "--surface=semantic"])).toEqual({
                surface: "semantic",
                argv: ["mcp"],
            });
        });

        test("rejects missing, empty, and unknown surface values", () => {
            expect(() => parseMcpSurfaceArgv(["mcp", "--surface"])).toThrow(
                "Missing value for --surface. Expected semantic, raw, or both.",
            );
            expect(() => parseMcpSurfaceArgv(["mcp", "--surface="])).toThrow(
                "Missing value for --surface. Expected semantic, raw, or both.",
            );
            expect(() => parseMcpSurfaceArgv(["mcp", "--surface", "invalid"])).toThrow(
                "Invalid --surface value: invalid. Expected semantic, raw, or both.",
            );
        });
    });

    describe("findFirstPositionalIndex", () => {
        test("returns the first non-flag argument", () => {
            expect(findFirstPositionalIndex(["--verbose", "run", "--json"])).toBe(1);
        });

        test("skips built-in flags that consume values", () => {
            expect(findFirstPositionalIndex(["--format", "json", "--token-limit", "10", "run"])).toBe(4);
            expect(findFirstPositionalIndex(["--filter-output", "summary", "--surface", "raw", "mcp"])).toBe(4);
        });

        test("honors the requested start index", () => {
            expect(findFirstPositionalIndex(["workflow", "--format", "json", "run"], 1)).toBe(3);
        });

        test("returns -1 when no positional argument exists", () => {
            expect(findFirstPositionalIndex(["--format", "json", "--verbose"])).toBe(-1);
            expect(findFirstPositionalIndex([], 0)).toBe(-1);
        });
    });

    describe("rewriteBareResumeFlagArgv", () => {
        test("rewrites a bare resume flag before another flag or end of argv", () => {
            expect(rewriteBareResumeFlagArgv(["run", "--resume", "--run-id", "abc"])).toEqual([
                "run",
                "--resume=true",
                "--run-id",
                "abc",
            ]);
            expect(rewriteBareResumeFlagArgv(["run", "--resume"])).toEqual(["run", "--resume=true"]);
        });

        test("preserves resume flags that already have explicit values", () => {
            expect(rewriteBareResumeFlagArgv(["run", "--resume", "false"])).toEqual(["run", "--resume", "false"]);
            expect(rewriteBareResumeFlagArgv(["run", "--resume=false"])).toEqual(["run", "--resume=false"]);
        });

        test("does not rewrite unrelated flags", () => {
            expect(rewriteBareResumeFlagArgv(["run", "--run-id", "abc"])).toEqual(["run", "--run-id", "abc"]);
        });
    });
});
