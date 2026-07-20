import { describe, expect, it } from "bun:test";
import { isTerminalStatus } from "./isTerminalStatus";
import { parseFleetRuns } from "./parseFleetRuns";
import { shouldResumeQuota } from "./shouldResumeQuota";

describe("isTerminalStatus", () => {
  it("counts final states as terminal", () => {
    for (const s of ["finished", "failed", "errored", "cancelled"]) {
      expect(isTerminalStatus(s)).toBe(true);
    }
  });

  it("does NOT count a quota-parked or running run as terminal", () => {
    for (const s of ["running", "waiting-quota", "waiting-approval", "waiting-timer", "queued"]) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });
});

describe("shouldResumeQuota", () => {
  const NOW = 1_000_000;

  it("resumes a quota-parked run once its reset has passed", () => {
    expect(shouldResumeQuota({ runId: "r", status: "waiting-quota", quotaResetAtMs: NOW - 1 }, NOW)).toBe(true);
  });

  it("waits while the reset is still in the future", () => {
    expect(shouldResumeQuota({ runId: "r", status: "waiting-quota", quotaResetAtMs: NOW + 60_000 }, NOW)).toBe(false);
  });

  it("leaves credit-exhaustion parks (no reset) for a human", () => {
    expect(shouldResumeQuota({ runId: "r", status: "waiting-quota" }, NOW)).toBe(false);
  });

  it("ignores runs that are not quota-parked", () => {
    expect(shouldResumeQuota({ runId: "r", status: "running", quotaResetAtMs: NOW - 1 }, NOW)).toBe(false);
    expect(shouldResumeQuota({ runId: "r", status: "finished" }, NOW)).toBe(false);
  });
});

describe("parseFleetRuns", () => {
  it("reads a bare array and a {runs:[]} envelope alike", () => {
    const rows = [
      { runId: "a", status: "running" },
      { runId: "b", status: "finished" },
    ];
    expect(parseFleetRuns(rows)).toHaveLength(2);
    expect(parseFleetRuns({ runs: rows })).toHaveLength(2);
  });

  it("filters to the shard's run ids", () => {
    const rows = [
      { runId: "a", status: "running" },
      { runId: "other", status: "running" },
    ];
    const out = parseFleetRuns(rows, ["a"]);
    expect(out.map((r) => r.runId)).toEqual(["a"]);
  });

  it("tolerates `id` in place of `runId`", () => {
    expect(parseFleetRuns([{ id: "x", status: "queued" }])).toEqual([{ runId: "x", status: "queued", quotaResetAtMs: undefined }]);
  });

  it("recovers the quota reset from the top-level resetAtMs and nested blocked", () => {
    const topLevel = parseFleetRuns([
      { runId: "a", status: "waiting-quota", resetAtMs: 42 },
    ]);
    expect(topLevel[0].quotaResetAtMs).toBe(42);
    const nested = parseFleetRuns([
      { runId: "b", status: "waiting-quota", blocked: { kind: "quota", resetAtMs: 99 } },
    ]);
    expect(nested[0].quotaResetAtMs).toBe(99);
  });

  it("recovers the quota reset from a parsed errorJson string and its details", () => {
    const fromString = parseFleetRuns([
      { runId: "c", status: "waiting-quota", errorJson: JSON.stringify({ resetAtMs: 7 }) },
    ]);
    expect(fromString[0].quotaResetAtMs).toBe(7);
    const fromDetails = parseFleetRuns([
      { runId: "d", status: "waiting-quota", errorJson: JSON.stringify({ details: { resetAtMs: 11 } }) },
    ]);
    expect(fromDetails[0].quotaResetAtMs).toBe(11);
  });

  it("skips malformed rows", () => {
    expect(parseFleetRuns([null, 3, { status: "running" }, { runId: "ok", status: "running" }])).toHaveLength(1);
  });
});
