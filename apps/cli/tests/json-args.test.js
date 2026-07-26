// Unit tests for the JSON CLI-argument helpers.
//
// Regression for the `parseJsonInput(raw, label, fail)` trap: under `cli.serve`
// the `fail` callback (which calls `c.error`) returns a TRUTHY sentinel without
// throwing, so callers that wrote `const x = parseJsonInput(...)` kept running
// and performed their side effect (signal delivery, run input override,
// human-answer value) with the error sentinel in place of the parsed JSON.
// `tryParseJsonInput` returns a discriminated `{ ok }` result so the failure is
// impossible to use as a value — every call site must `if (!parsed.ok) return`.
import { describe, expect, test } from "bun:test";
import { CLI_JSON_ARGUMENT_MAX_BYTES, readJsonArgumentPayload, tryParseJsonInput } from "../src/json-args.js";

describe("tryParseJsonInput", () => {
  test("parses a valid JSON object", () => {
    const result = tryParseJsonInput('{"foo":1,"bar":"x"}', "data");
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({ foo: 1, bar: "x" });
  });

  test("parses valid JSON scalars (including null and 0)", () => {
    expect(tryParseJsonInput("null", "data")).toEqual({ ok: true, value: null });
    expect(tryParseJsonInput("0", "data")).toEqual({ ok: true, value: 0 });
    expect(tryParseJsonInput("false", "data")).toEqual({ ok: true, value: false });
  });

  test("returns value:undefined for an absent argument", () => {
    expect(tryParseJsonInput(undefined, "data")).toEqual({ ok: true, value: undefined });
  });

  test("returns a typed failure (never a usable value) on malformed JSON", () => {
    const result = tryParseJsonInput("{not-json", "signal data");
    expect(result.ok).toBe(false);
    // The failure carries no `value` field at all — it cannot be mistaken
    // for parsed data the way the old fail-sentinel could.
    expect(result).not.toHaveProperty("value");
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_JSON");
      expect(result.error.exitCode).toBe(4);
      expect(result.error.message).toContain("signal data");
    }
  });

  test("a truncated array also fails closed", () => {
    const result = tryParseJsonInput("[1,2,", "input");
    expect(result.ok).toBe(false);
  });

  test("enforces the documented byte limit for inline positional JSON payloads", () => {
    const exactLimit = "x".repeat(CLI_JSON_ARGUMENT_MAX_BYTES);
    expect(readJsonArgumentPayload(exactLimit, "input")).toBe(exactLimit);

    const result = tryParseJsonInput("x".repeat(CLI_JSON_ARGUMENT_MAX_BYTES + 1), "input");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
      expect(result.error.message).toContain(`maximum size of ${CLI_JSON_ARGUMENT_MAX_BYTES}`);
    }
  });
});
