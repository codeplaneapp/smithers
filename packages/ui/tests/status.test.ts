import { describe, expect, test } from "bun:test";
import { formatStatus, isTerminalRunStatus, normalizeStatus, statusClass } from "../src/status";

describe("normalizeStatus", () => {
  test("lowercases, trims, and normalizes underscores", () => {
    expect(normalizeStatus(" Waiting_Approval ")).toBe("waiting-approval");
    expect(normalizeStatus(undefined)).toBe("");
  });
});

describe("statusClass", () => {
  test("buckets finished / failed / in-flight / neutral", () => {
    expect(statusClass("ok")).toBe("ok");
    expect(statusClass("completed")).toBe("ok");
    expect(statusClass("failed")).toBe("bad");
    expect(statusClass("blocked")).toBe("bad");
    expect(statusClass("running")).toBe("warn");
    expect(statusClass("waiting-approval")).toBe("warn");
    expect(statusClass("cancelled")).toBe("muted");
    expect(statusClass("something-new")).toBe("muted");
  });
});

describe("formatStatus", () => {
  test("maps known statuses and title-cases unknowns", () => {
    expect(formatStatus("waiting-approval")).toBe("Waiting for approval");
    expect(formatStatus("ok")).toBe("Complete");
    expect(formatStatus("some-new-state")).toBe("Some New State");
    expect(formatStatus(undefined)).toBe("Unknown");
  });
});

describe("isTerminalRunStatus", () => {
  test("finished, failed, and cancelled are terminal", () => {
    expect(isTerminalRunStatus("ok")).toBe(true);
    expect(isTerminalRunStatus("finished")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
    expect(isTerminalRunStatus("canceled")).toBe(true);
    expect(isTerminalRunStatus("skipped")).toBe(true);
  });

  test("in-flight and unknown statuses are not terminal", () => {
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("waiting-approval")).toBe(false);
    expect(isTerminalRunStatus("queued")).toBe(false);
    expect(isTerminalRunStatus(undefined)).toBe(false);
    expect(isTerminalRunStatus("")).toBe(false);
  });
});
