import { describe, expect, test } from "bun:test";
import { timingSafeStringEqual } from "../../src/server/timingSafeStringEqual.ts";

describe("timingSafeStringEqual", () => {
  test("equal strings compare true", () => {
    expect(timingSafeStringEqual("srs_abc123", "srs_abc123")).toBe(true);
  });

  test("different strings of the same length compare false", () => {
    expect(timingSafeStringEqual("srs_abc123", "srs_abc124")).toBe(false);
  });

  test("different lengths compare false without throwing", () => {
    expect(timingSafeStringEqual("short", "much longer string")).toBe(false);
    expect(timingSafeStringEqual("much longer string", "short")).toBe(false);
    expect(timingSafeStringEqual("", "x")).toBe(false);
  });

  test("empty vs empty compares true", () => {
    expect(timingSafeStringEqual("", "")).toBe(true);
  });

  test("multibyte unicode compares by bytes", () => {
    expect(timingSafeStringEqual("héllo🚀", "héllo🚀")).toBe(true);
    expect(timingSafeStringEqual("héllo🚀", "héllo🚁")).toBe(false);
    // Same string length in UTF-16 units but different UTF-8 byte lengths.
    expect(timingSafeStringEqual("aé", "ab")).toBe(false);
  });
});
