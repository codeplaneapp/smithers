import { describe, expect, test } from "bun:test";
import { formatRecapAge, latestSeqOf, mergeRecapHistory, notableEventCount, shouldRefreshRecap } from "../src/monitor-ui/monitorRecapModel.ts";

describe("monitor recap model", () => {
  test("counts notable events and reads tolerant sequences", () => {
    expect(notableEventCount([{ event: "Heartbeat" }, { type: "NodeFinished" }, { type: "ApprovalGranted" }])).toBe(2);
    expect(latestSeqOf([{ sequence: 2 }, { seq: 4 }])).toBe(4);
    expect(latestSeqOf(undefined)).toBe(-1);
    expect(formatRecapAge(0, 59_000)).toBe("just now");
    expect(formatRecapAge(0, 60_000)).toBe("1m ago");
    expect(formatRecapAge(0, 3_600_000)).toBe("1h ago");
  });
  test("refreshes for growth or a live poll, never in flight", () => {
    expect(shouldRefreshRecap({ lastToSeq: 2, latestNotableSeq: 3, lastFetchedAtMs: 0, nowMs: 1, live: false, inFlight: false })).toBe(true);
    expect(shouldRefreshRecap({ lastToSeq: 2, latestNotableSeq: 2, lastFetchedAtMs: 0, nowMs: 180000, live: true, inFlight: false })).toBe(true);
    expect(shouldRefreshRecap({ lastToSeq: 2, latestNotableSeq: 3, lastFetchedAtMs: 0, nowMs: 1, live: true, inFlight: true })).toBe(false);
  });
  test("holds the growth trigger behind a doubling, capped backoff after failures", () => {
    const base = { lastToSeq: 2, latestNotableSeq: 3, lastFetchedAtMs: 0, lastAttemptAtMs: 0, live: true, inFlight: false };
    expect(shouldRefreshRecap({ ...base, nowMs: 1, consecutiveFailures: 1 })).toBe(false);
    expect(shouldRefreshRecap({ ...base, nowMs: 15_000, consecutiveFailures: 1 })).toBe(true);
    expect(shouldRefreshRecap({ ...base, nowMs: 15_000, consecutiveFailures: 2 })).toBe(false);
    expect(shouldRefreshRecap({ ...base, nowMs: 30_000, consecutiveFailures: 2 })).toBe(true);
    expect(shouldRefreshRecap({ ...base, nowMs: 179_999, consecutiveFailures: 99 })).toBe(false);
    expect(shouldRefreshRecap({ ...base, nowMs: 180_000, consecutiveFailures: 99 })).toBe(true);
  });
  test("merges recap history newest first", () => {
    expect(mergeRecapHistory([{ toSeq: 1 }], [{ toSeq: 2 }, { toSeq: 1 }]).map((item) => item.toSeq)).toEqual([2, 1]);
  });
});
