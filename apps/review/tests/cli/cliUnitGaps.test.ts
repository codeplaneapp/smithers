import { describe, expect, test } from "bun:test";
import { parseJsonColumn } from "../../src/cli/parseJsonColumn";
import { createProgressReporter } from "../../src/cli/createProgressReporter";

describe("parseJsonColumn", () => {
  test("returns arrays untouched", () => {
    expect(parseJsonColumn([1, 2, 3])).toEqual([1, 2, 3]);
  });

  test("parses a JSON-string array", () => {
    expect(parseJsonColumn<number>("[1,2]")).toEqual([1, 2]);
  });

  test("non-strings, blanks, and non-array JSON yield []", () => {
    expect(parseJsonColumn(null)).toEqual([]);
    expect(parseJsonColumn(42)).toEqual([]);
    expect(parseJsonColumn("   ")).toEqual([]);
    expect(parseJsonColumn('{"a":1}')).toEqual([]);
  });

  test("invalid JSON is swallowed and yields []", () => {
    expect(parseJsonColumn("[not json")).toEqual([]);
  });
});

describe("createProgressReporter error formatting", () => {
  test("formats object-with-message and primitive/undefined errors", async () => {
    const lines: string[] = [];
    const reporter = createProgressReporter({ loadRows: async () => ({}), write: (line) => lines.push(line) });

    // Non-Error object carrying a `message` property → String(message).
    reporter.onEvent({ type: "NodeFailed", nodeId: "narrate", timestampMs: 0, error: { message: "boom object" } });
    // A primitive (number) error → falls through to String(error).
    reporter.onEvent({ type: "NodeFailed", nodeId: "quiz", timestampMs: 0, error: 42 });
    // A nullish error → "unknown error" default.
    reporter.onEvent({ type: "NodeFailed", nodeId: "verify-findings", timestampMs: 0, error: null });
    await reporter.flush();

    expect(lines[0]).toBe("narrate failed: boom object");
    expect(lines[1]).toBe("quiz failed: 42");
    expect(lines[2]).toBe("verify-findings failed: unknown error");
  });

  test("a rejecting loadRows is swallowed by the print chain", async () => {
    const lines: string[] = [];
    const reporter = createProgressReporter({
      loadRows: async () => {
        throw new Error("db is gone");
      },
      write: (line) => lines.push(line),
    });
    // A per-file NodeFinished enqueues a job that calls loadRows → the rejection
    // must be caught by the chain's `.catch(() => {})` rather than crashing flush.
    reporter.onEvent({ type: "NodeFinished", nodeId: "review-file-1-src-foo-ts", timestampMs: 1_000 });
    await expect(reporter.flush()).resolves.toBeUndefined();
    expect(lines).toEqual([]);
  });
});
