import { describe, expect, test } from "bun:test";
import {
  extractBackendFlag,
  findFirstPositionalIndex,
  parseMcpSurfaceArgv,
  rewriteBareHerdrFlagArgv,
  rewriteBareResumeFlagArgv,
} from "../src/argv-utils.js";

describe("argv-utils", () => {
  describe("parseMcpSurfaceArgv", () => {
    test("defaults to semantic and preserves argv without a surface flag", () => {
      const argv = ["mcp", "--format", "json"];

      expect(parseMcpSurfaceArgv(argv)).toEqual({
        surface: "semantic",
        argv,
        allowedTools: undefined,
        readOnly: false,
      });
    });

    test("removes separate and equals-form surface flags", () => {
      expect(parseMcpSurfaceArgv(["mcp", "--surface", "raw", "--format", "json"])).toEqual({
        surface: "raw",
        argv: ["mcp", "--format", "json"],
        allowedTools: undefined,
        readOnly: false,
      });

      expect(parseMcpSurfaceArgv(["mcp", "--surface=both", "--verbose"])).toEqual({
        surface: "both",
        argv: ["mcp", "--verbose"],
        allowedTools: undefined,
        readOnly: false,
      });
    });

    test("normalizes surface values and lets the last surface flag win", () => {
      expect(parseMcpSurfaceArgv(["mcp", "--surface", " RAW ", "--surface=semantic"])).toEqual({
        surface: "semantic",
        argv: ["mcp"],
        allowedTools: undefined,
        readOnly: false,
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

    test("strips --read-only and rejects a missing allowed-tools value before another flag", () => {
      expect(parseMcpSurfaceArgv(["mcp", "--read-only", "--allowed-tools", "get_run,list_runs"])).toEqual({
        surface: "semantic",
        argv: ["mcp"],
        allowedTools: ["get_run", "list_runs"],
        readOnly: true,
      });

      expect(() => parseMcpSurfaceArgv(["mcp", "--allowed-tools", "--read-only"])).toThrow(
        "Missing value for --allowed-tools. Expected a comma-separated semantic tool allowlist.",
      );
      expect(() => parseMcpSurfaceArgv(["mcp", "--allowed-tools="])).toThrow(
        "Missing value for --allowed-tools. Expected a comma-separated semantic tool allowlist.",
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

  describe("rewriteBareHerdrFlagArgv", () => {
    test("rewrites a bare --herdr before another flag so it does not swallow it", () => {
      // The bug: the union-typed --herdr treats the next token as its value, so
      // `--herdr --run-id X` would consume `--run-id` as the session.
      expect(rewriteBareHerdrFlagArgv(["up", "wf.tsx", "--herdr", "--run-id", "abc"])).toEqual([
        "up",
        "wf.tsx",
        "--herdr=true",
        "--run-id",
        "abc",
      ]);
      // Bare --herdr followed by a short flag (e.g. -d detach).
      expect(rewriteBareHerdrFlagArgv(["up", "wf.tsx", "--herdr", "-d"])).toEqual([
        "up",
        "wf.tsx",
        "--herdr=true",
        "-d",
      ]);
      // Bare --herdr at end of argv.
      expect(rewriteBareHerdrFlagArgv(["up", "wf.tsx", "--herdr"])).toEqual(["up", "wf.tsx", "--herdr=true"]);
    });

    test("preserves an explicit session value", () => {
      // Separate-form session name (does not start with '-') is left intact so
      // incur parses it as the value.
      expect(rewriteBareHerdrFlagArgv(["up", "wf.tsx", "--herdr", "mysession"])).toEqual([
        "up",
        "wf.tsx",
        "--herdr",
        "mysession",
      ]);
      // Equals-form is never touched.
      expect(rewriteBareHerdrFlagArgv(["up", "wf.tsx", "--herdr=mysession"])).toEqual([
        "up",
        "wf.tsx",
        "--herdr=mysession",
      ]);
    });

    test("does not rewrite unrelated argv", () => {
      expect(rewriteBareHerdrFlagArgv(["up", "wf.tsx", "--run-id", "abc"])).toEqual([
        "up",
        "wf.tsx",
        "--run-id",
        "abc",
      ]);
    });
  });

  describe("extractBackendFlag", () => {
    test("lifts the separate-form flag and strips it from argv", () => {
      expect(extractBackendFlag(["inspect", "run-1", "--backend", "sqlite"])).toEqual({
        argv: ["inspect", "run-1"],
        backend: "sqlite",
      });
    });

    test("lifts the equals-form flag", () => {
      expect(extractBackendFlag(["ps", "--backend=pglite"])).toEqual({
        argv: ["ps"],
        backend: "pglite",
      });
    });

    test("returns undefined backend and unchanged argv when absent", () => {
      expect(extractBackendFlag(["ps", "--json"])).toEqual({
        argv: ["ps", "--json"],
        backend: undefined,
      });
    });

    test("does not consume a following flag as the backend value", () => {
      expect(extractBackendFlag(["inspect", "--backend", "--json"])).toEqual({
        argv: ["inspect", "--json"],
        backend: undefined,
      });
    });
  });
});
