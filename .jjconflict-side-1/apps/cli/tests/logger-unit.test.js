import { describe, expect, test } from "bun:test";
import { Cause, FiberId, HashMap, List, LogLevel } from "effect";
import {
    formatCliLogLine,
    resolveCliLogLevel,
    shouldEmitLogLevel,
} from "../src/util/logger.ts";

const stripAnsi = (value) => value.replace(/\x1B\[[0-9;]*m/g, "");

describe("CLI logger", () => {
    test("resolves SMITHERS_LOG_LEVEL-style names to Effect log levels", () => {
        expect(resolveCliLogLevel(undefined)).toBe(LogLevel.Info);
        expect(resolveCliLogLevel("debug")).toBe(LogLevel.Debug);
        expect(resolveCliLogLevel("warn")).toBe(LogLevel.Warning);
        expect(resolveCliLogLevel("warning")).toBe(LogLevel.Warning);
        expect(resolveCliLogLevel("error")).toBe(LogLevel.Error);
        expect(resolveCliLogLevel("none")).toBe(LogLevel.None);
        expect(resolveCliLogLevel("unknown")).toBe(LogLevel.Warning);
    });

    test("filters levels using the configured minimum", () => {
        expect(shouldEmitLogLevel(LogLevel.Warning, LogLevel.Error)).toBe(false);
        expect(shouldEmitLogLevel(LogLevel.Error, LogLevel.Error)).toBe(true);
        expect(shouldEmitLogLevel(LogLevel.Debug, LogLevel.Debug)).toBe(true);
        expect(shouldEmitLogLevel(LogLevel.Info, LogLevel.Debug)).toBe(true);
    });

    test("formats Effect logs as compact human lines", () => {
        const line = stripAnsi(formatCliLogLine({
            fiberId: FiberId.none,
            logLevel: LogLevel.Warning,
            message: "ClaudeCodeAgent: unsetting ANTHROPIC_API_KEY",
            cause: Cause.empty,
            context: {},
            spans: List.make({ label: "agent.init", startTime: 1_000 }),
            annotations: HashMap.make(["nodeId", "review"]),
            date: new Date(1_025),
        }));

        expect(line).toContain("warn");
        expect(line).toContain("ClaudeCodeAgent: unsetting ANTHROPIC_API_KEY");
        expect(line).toContain("agent.init=25ms");
        expect(line).toContain("nodeId=review");
        expect(line).not.toContain("timestamp=");
        expect(line).not.toContain("fiber=");
    });
});
