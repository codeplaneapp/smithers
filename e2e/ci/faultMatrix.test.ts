import { describe, expect, test } from "bun:test";
import type { FaultMatrix, FlakeHistory } from "./faultMatrix.ts";
import { mergeHistory, parseJUnitResults, promotionFailures } from "./faultMatrix.ts";

const matrix: FaultMatrix = {
  version: 1,
  promotionPassesRequired: 100,
  cases: [{ id: "case99", file: "faults/case99-example.test.ts", promotionTier: "nightly" }],
};

describe("fault matrix CI enforcement", () => {
  test("JUnit outcomes distinguish a clean run, flake, and incomplete run", () => {
    const xml = '<testsuite name="e2e/faults/case99-example.test.ts" file="e2e/faults/case99-example.test.ts" tests="2" failures="0" skipped="0" time="1.25">';
    expect(parseJUnitResults(xml, matrix)[0]).toMatchObject({
      id: "case99",
      outcome: "pass",
      durationMs: 1250,
    });
    expect(parseJUnitResults(xml.replace('failures="0"', 'failures="1"'), matrix)[0]?.outcome).toBe("flake");
    expect(parseJUnitResults(xml.replace('skipped="0"', 'skipped="1"'), matrix)[0]?.outcome).toBe("incomplete");
  });

  test("a flake resets the consecutive-pass counter and remains in the rolling window", () => {
    const history: FlakeHistory = { version: 1, cases: {} };
    const pass = parseJUnitResults('<testsuite name="e2e/faults/case99-example.test.ts" file="e2e/faults/case99-example.test.ts" tests="1" failures="0" skipped="0" time="0.1">', matrix);
    mergeHistory(history, pass, "run-1");
    mergeHistory(history, pass, "run-2");
    const flake = [{ ...pass[0]!, failures: 1, outcome: "flake" as const }];
    mergeHistory(history, flake, "run-3");
    expect(history.cases.case99).toMatchObject({
      totalCompletedRuns: 3,
      totalFlakes: 1,
      consecutivePasses: 0,
    });
    expect(history.cases.case99?.recentRuns.map((run) => run.outcome)).toEqual(["pass", "pass", "flake"]);
  });

  test("promotion requires exactly 100 clean recent runs", () => {
    const promoted: FaultMatrix = {
      ...matrix,
      cases: [{ ...matrix.cases[0]!, promotionTier: "pr" }],
    };
    const cleanRuns = Array.from({ length: 100 }, (_, index) => ({
      runId: `run-${index}`,
      recordedAt: "2026-01-01T00:00:00.000Z",
      outcome: "pass" as const,
      tests: 1,
      failures: 0,
      skipped: 0,
      durationMs: 1,
    }));
    const history: FlakeHistory = {
      version: 1,
      cases: {
        case99: {
          totalAttempts: 100,
          totalCompletedRuns: 100,
          totalFlakes: 0,
          consecutivePasses: 100,
          recentRuns: cleanRuns,
        },
      },
    };
    expect(promotionFailures(promoted, matrix, history)).toEqual([]);
    history.cases.case99!.recentRuns[0]!.outcome = "flake";
    expect(promotionFailures(promoted, matrix, history)[0]).toContain("99/100");
  });
});
