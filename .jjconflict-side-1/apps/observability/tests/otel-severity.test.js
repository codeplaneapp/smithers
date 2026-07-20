import { describe, expect, test } from "bun:test";
import { inferCanonicalSeverity, inferSessionSeverity } from "../src/_otelLogBuilders.js";

describe("inferCanonicalSeverity", () => {
  test("treats truncated-json-stream capture.error as WARN, other capture.error as ERROR", () => {
    expect(inferCanonicalSeverity({ event: { kind: "capture.error" }, payload: { reason: "truncated-json-stream" } })).toBe("WARN");
    expect(inferCanonicalSeverity({ event: { kind: "capture.error" }, payload: { reason: "boom" } })).toBe("ERROR");
    expect(inferCanonicalSeverity({ event: { kind: "capture.error" } })).toBe("ERROR");
  });

  test("maps capture.warning and stderr to WARN, everything else to INFO", () => {
    expect(inferCanonicalSeverity({ event: { kind: "capture.warning" } })).toBe("WARN");
    expect(inferCanonicalSeverity({ event: { kind: "stderr" } })).toBe("WARN");
    expect(inferCanonicalSeverity({ event: { kind: "capture.text" } })).toBe("INFO");
  });
});

describe("inferSessionSeverity", () => {
  test("infers ERROR from the various error signals", () => {
    expect(inferSessionSeverity({ is_error: true })).toBe("ERROR");
    expect(inferSessionSeverity({ isError: true })).toBe("ERROR");
    expect(inferSessionSeverity({ error: "x" })).toBe("ERROR");
    expect(inferSessionSeverity({ errorMessage: "x" })).toBe("ERROR");
    expect(inferSessionSeverity({ message: { stopReason: "error" } })).toBe("ERROR");
    expect(inferSessionSeverity({ message: { errorMessage: "x" } })).toBe("ERROR");
    expect(inferSessionSeverity({ type: "ToolErrorResult" })).toBe("ERROR");
  });

  test("infers WARN from a warning type, and INFO otherwise", () => {
    expect(inferSessionSeverity({ type: "warning_event" })).toBe("WARN");
    expect(inferSessionSeverity({ type: "assistant" })).toBe("INFO");
    expect(inferSessionSeverity({})).toBe("INFO");
    expect(inferSessionSeverity(null)).toBe("INFO");
    expect(inferSessionSeverity(undefined)).toBe("INFO");
  });
});
