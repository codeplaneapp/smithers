import { describe, expect, test } from "bun:test";
import { formatRecapAge, latestNotableSeqOf, latestSeqOf, parseRecapSummary, shouldRefreshRecap } from "../src/monitor-ui/monitorRecapModel.ts";

describe("monitor recap model", () => {
  test("filters notable events and reads tolerant sequences", () => {
    expect(latestNotableSeqOf([{ event: "Heartbeat", seq: 9 }, { type: "NodeFinished", seq: 4 }, { type: "ApprovalGranted", sequence: 2 }])).toBe(4);
    expect(latestNotableSeqOf(undefined)).toBe(-1);
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
  test("parses the Outcome lede and folds zero-fact bullets into one dim line", () => {
    const view = parseRecapSummary([
      "Outcome: Shipped the fix and reran the suite.",
      "- Failures: None recorded.",
      "- Retries: 2 on the build task.",
      "- Approvals: None recorded.",
    ].join("\n"));
    expect(view.lede).toBe("Shipped the fix and reran the suite.");
    expect(view.notable).toEqual([{ label: "Retries", value: "2 on the build task." }]);
    expect(view.factsLine).toBe("Failures 0 · Approvals 0");
  });
  test("all-zero bullets collapse to 'Nothing notable yet.'", () => {
    const view = parseRecapSummary("Outcome: Nothing ran.\n- Failures: None recorded.\n- Handoffs: None recorded.");
    expect(view.notable).toEqual([]);
    expect(view.factsLine).toBe("Nothing notable yet.");
    // Narrators vary the filler verb; "reported"/"noted" fold the same way.
    const reported = parseRecapSummary("Done.\n- Failures: None reported.\n- Retries: None noted.");
    expect(reported.notable).toEqual([]);
    expect(reported.factsLine).toBe("Nothing notable yet.");
  });
  test("summaries without bullets render verbatim as the lede", () => {
    const view = parseRecapSummary("The agent completed useful work.\nAnd then stopped.");
    expect(view.lede).toBe("The agent completed useful work.\nAnd then stopped.");
    expect(view.notable).toEqual([]);
    expect(view.factsLine).toBeNull();
  });
});
