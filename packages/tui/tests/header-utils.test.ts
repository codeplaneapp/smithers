import { describe, it, expect } from "bun:test";
import {
  isRunningStatus,
  statusDotColor,
  runLiveLabel,
  formatElapsed,
  shortRunId,
  buildRunHeaderData,
} from "../src/headerUtils.ts";

describe("isRunningStatus", () => {
  it("is true for active states", () => {
    expect(isRunningStatus("running")).toBe(true);
    expect(isRunningStatus("recovering")).toBe(true);
  });
  it("is false for parked/terminal states", () => {
    expect(isRunningStatus("waiting-approval")).toBe(false);
    expect(isRunningStatus("succeeded")).toBe(false);
    expect(isRunningStatus("failed")).toBe(false);
  });
});

describe("statusDotColor", () => {
  it("maps states onto the five-tone palette", () => {
    expect(statusDotColor("running")).toBe("#00d7ff");
    expect(statusDotColor("waiting-approval")).toBe("#ffaf00");
    expect(statusDotColor("failed")).toBe("#ff5f5f");
    expect(statusDotColor("succeeded")).toBe("#00d787");
    expect(statusDotColor("mystery")).toBe("#555555");
  });
});

describe("runLiveLabel", () => {
  it("is live while running, paused while parked, literal otherwise", () => {
    expect(runLiveLabel("running").text).toBe("live");
    expect(runLiveLabel("waiting-approval").text).toBe("paused");
    expect(runLiveLabel("succeeded").text).toBe("succeeded");
  });
});

describe("formatElapsed", () => {
  it("formats MM:SS under an hour", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(154_000)).toBe("02:34");
    expect(formatElapsed(59_999)).toBe("00:59");
  });
  it("formats HH:MM:SS past an hour", () => {
    expect(formatElapsed(3_661_000)).toBe("01:01:01");
  });
  it("shows a placeholder for unknown/invalid", () => {
    expect(formatElapsed(undefined)).toBe("--:--");
    expect(formatElapsed(-5)).toBe("--:--");
    expect(formatElapsed(NaN)).toBe("--:--");
  });
});

describe("shortRunId", () => {
  it("keeps short ids whole", () => {
    expect(shortRunId("run-abc123")).toBe("run-abc123");
  });
  it("elides genuinely long ids", () => {
    const long = "run-" + "x".repeat(40);
    expect(shortRunId(long).endsWith("…")).toBe(true);
    expect(shortRunId(long).length).toBeLessThanOrEqual(24);
  });
});

describe("buildRunHeaderData", () => {
  it("derives status/workflow/model and ticking elapsed for a live run", () => {
    const now = 1_000_000;
    const data = buildRunHeaderData(
      { status: "running", workflowKey: "deploy", model: "claude-opus-4-8", startedAtMs: now - 154_000 },
      "run-abc123",
      now,
      false,
    );
    expect(data.status).toBe("running");
    expect(data.workflowKey).toBe("deploy");
    expect(data.model).toBe("claude-opus-4-8");
    expect(data.live).toBe(true);
    expect(formatElapsed(data.elapsedMs)).toBe("02:34");
  });

  it("freezes elapsed at finishedAtMs for a terminal run", () => {
    const data = buildRunHeaderData(
      { status: "succeeded", workflowKey: "deploy", startedAtMs: 1000, finishedAtMs: 1000 + 65_000 },
      "run-1",
      9_999_999, // wall clock much later — must NOT keep counting
      false,
    );
    expect(data.live).toBe(false);
    expect(formatElapsed(data.elapsedMs)).toBe("01:05");
  });

  it("shows connecting + unknown elapsed while loading", () => {
    const data = buildRunHeaderData(undefined, "run-1", 5000, true);
    expect(data.status).toBe("connecting");
    expect(data.elapsedMs).toBeUndefined();
    expect(data.live).toBe(false);
  });

  it("omits model when the run row carries none (never fabricated)", () => {
    const data = buildRunHeaderData({ status: "running", workflowKey: "deploy" }, "run-1", 0, false);
    expect(data.model).toBeUndefined();
  });
});
