import { describe, expect, test } from "bun:test";
import { Cause } from "effect";
import { formatCliLogLine, resolveCliLogLevel, shouldEmitLogLevel } from "../src/util/logger.ts";

const stripAnsi = (value) => value.replace(/\x1B\[[0-9;]*m/g, "");

describe("CLI logger", () => {
  test("resolves SMITHERS_LOG_LEVEL-style names to Effect log levels", () => {
    expect(resolveCliLogLevel(undefined)).toBe("Info");
    expect(resolveCliLogLevel("debug")).toBe("Debug");
    expect(resolveCliLogLevel("warn")).toBe("Warn");
    expect(resolveCliLogLevel("warning")).toBe("Warn");
    expect(resolveCliLogLevel("error")).toBe("Error");
    expect(resolveCliLogLevel("none")).toBe("None");
    expect(resolveCliLogLevel("unknown")).toBe("Warn");
  });

  test("filters levels using the configured minimum", () => {
    expect(shouldEmitLogLevel("Warn", "Error")).toBe(false);
    expect(shouldEmitLogLevel("Error", "Error")).toBe(true);
    expect(shouldEmitLogLevel("Debug", "Debug")).toBe(true);
    expect(shouldEmitLogLevel("Info", "Debug")).toBe(true);
  });

  test("formats Effect logs as compact human lines", () => {
    const line = stripAnsi(
      formatCliLogLine({
        logLevel: "Warn",
        message: "ClaudeCodeAgent: unsetting ANTHROPIC_API_KEY",
        cause: Cause.empty,
        context: {},
        spans: [{ label: "agent.init", startTime: 1_000 }],
        annotations: [["nodeId", "review"]],
        date: new Date(1_025),
      }),
    );

    expect(line).toContain("warn");
    expect(line).toContain("ClaudeCodeAgent: unsetting ANTHROPIC_API_KEY");
    expect(line).toContain("agent.init=25ms");
    expect(line).toContain("nodeId=review");
    expect(line).not.toContain("timestamp=");
    expect(line).not.toContain("fiber=");
  });
});
