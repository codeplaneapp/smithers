import { describe, expect, test } from "bun:test";
import {
  resolveMinLevel,
  toEffectLogLevel,
  logDebugAwait,
  logInfoAwait,
  logWarningAwait,
  logErrorAwait,
  setSmithersLogRunner,
} from "@smithers-orchestrator/observability/logging";

describe("resolveMinLevel", () => {
  test("maps every SMITHERS_LOG_LEVEL alias to a numeric threshold", () => {
    expect(resolveMinLevel("none")).toBe(Infinity);
    expect(resolveMinLevel("fatal")).toBe(Infinity);
    expect(resolveMinLevel("trace")).toBe(1);
    expect(resolveMinLevel("debug")).toBe(1);
    expect(resolveMinLevel("info")).toBe(2);
    expect(resolveMinLevel("warn")).toBe(3);
    expect(resolveMinLevel("warning")).toBe(3);
    expect(resolveMinLevel("error")).toBe(4);
    expect(resolveMinLevel("all")).toBe(0);
  });
  test("defaults unknown and undefined values to INFO", () => {
    expect(resolveMinLevel("something-else")).toBe(2);
    expect(resolveMinLevel(undefined)).toBe(2);
  });
});

describe("toEffectLogLevel", () => {
  test("maps numeric levels to Effect LogLevels", () => {
    expect(toEffectLogLevel(1)).toBe("Debug");
    expect(toEffectLogLevel(2)).toBe("Info");
    expect(toEffectLogLevel(3)).toBe("Warn");
    expect(toEffectLogLevel(4)).toBe("Error");
  });
  test("falls back to All for out-of-range levels", () => {
    expect(toEffectLogLevel(0)).toBe("All");
    expect(toEffectLogLevel(99)).toBe("All");
  });
});

describe("awaited log helpers", () => {
  test("run through the default runPromise runner when no runner is installed", async () => {
    // With no injected runner the default runner's runPromise is used. INFO,
    // WARNING and ERROR are at/above the default INFO threshold and reach it;
    // DEBUG is below it and short-circuits before touching the runner.
    await expect(logInfoAwait("await info", { runId: "r" }, "span")).resolves.toBeUndefined();
    await expect(logWarningAwait("await warn")).resolves.toBeUndefined();
    await expect(logErrorAwait("await error", { code: "E" })).resolves.toBeUndefined();
    await expect(logDebugAwait("await debug")).resolves.toBeUndefined();
  });

  test("route through an injected runner and swallow runner failures", async () => {
    let calls = 0;
    const restore = setSmithersLogRunner({
      runFork() {},
      async runPromise() {
        calls += 1;
        throw new Error("runner boom");
      },
    });
    try {
      // The thrown runner error is caught inside emitLogAwait — the caller never sees it.
      await expect(logWarningAwait("await warn via runner")).resolves.toBeUndefined();
      await expect(logInfoAwait("await info via runner")).resolves.toBeUndefined();
      await expect(logErrorAwait("await error via runner")).resolves.toBeUndefined();
      expect(calls).toBe(3);
      // DEBUG stays below the INFO floor, so the runner is not invoked.
      await logDebugAwait("await debug skipped");
      expect(calls).toBe(3);
    } finally {
      restore();
    }
  });
});
