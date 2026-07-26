import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HARNESS_CANDIDATES,
  detectHarnessCommand,
  isExecutableOnPath,
  resolveHarnessCommand,
  shouldDockIntoCurrentPane,
  shouldSplitCockpit,
} from "../src/cockpitLayout.js";

describe("cockpitLayout", () => {
  test("DEFAULT_HARNESS_CANDIDATES prefers grok then claude", () => {
    expect(DEFAULT_HARNESS_CANDIDATES[0]).toBe("grok");
    expect(DEFAULT_HARNESS_CANDIDATES).toContain("claude");
  });

  test("isExecutableOnPath finds sh", () => {
    expect(isExecutableOnPath("sh")).toBe(true);
    expect(isExecutableOnPath("definitely-not-a-bin-xyzzy")).toBe(false);
  });

  test("resolveHarnessCommand none / explicit / auto", () => {
    expect(resolveHarnessCommand({ harnessCommand: "none" })).toBe(null);
    expect(resolveHarnessCommand({ harnessCommand: ["my-agent", "--flag"] })).toEqual(["my-agent", "--flag"]);
    const auto = resolveHarnessCommand({ harnessCommand: "auto" });
    // At least one of the common harnesses should exist on this box, or null.
    if (auto) {
      expect(Array.isArray(auto)).toBe(true);
      expect(auto.length).toBeGreaterThan(0);
    }
  });

  test("env SMITHERS_HERDR_HARNESS overrides", () => {
    expect(resolveHarnessCommand({ harnessCommand: "auto" }, { SMITHERS_HERDR_HARNESS: "none" })).toBe(null);
    expect(resolveHarnessCommand({ harnessCommand: "none" }, { SMITHERS_HERDR_HARNESS: "custom-cli" })).toEqual([
      "custom-cli",
    ]);
  });

  test("shouldSplitCockpit", () => {
    expect(shouldSplitCockpit({ chrome: "tabs" }, {})).toBe(false);
    expect(shouldSplitCockpit({ chrome: "split" }, {})).toBe(true);
    expect(shouldSplitCockpit({ chrome: "auto" }, { dock: true })).toBe(true);
    expect(shouldSplitCockpit({ chrome: "auto" }, { harnessArgv: ["grok"] })).toBe(true);
    expect(shouldSplitCockpit({ chrome: "auto" }, {})).toBe(false);
    expect(shouldSplitCockpit({ chrome: "auto", harnessCommand: "auto" }, {})).toBe(true);
  });

  test("shouldDockIntoCurrentPane honors HERDR_ENV / SMITHERS_HERDR_DOCK / dock:true", () => {
    expect(shouldDockIntoCurrentPane({}, { HERDR_ENV: "1" })).toBe(true);
    expect(shouldDockIntoCurrentPane({}, { HERDR_ENV: "0" })).toBe(false);
    expect(shouldDockIntoCurrentPane({ dock: false }, { HERDR_ENV: "1" })).toBe(false);
    expect(shouldDockIntoCurrentPane({ dock: true }, {})).toBe(true);
    expect(shouldDockIntoCurrentPane({}, { SMITHERS_HERDR_DOCK: "1" })).toBe(true);
  });

  test("detectHarnessCommand returns array or null", () => {
    const d = detectHarnessCommand();
    expect(d === null || (Array.isArray(d) && d.length > 0)).toBe(true);
  });
});
