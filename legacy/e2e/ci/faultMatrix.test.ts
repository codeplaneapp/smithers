import { describe, expect, test } from "bun:test";
import type { FaultMatrix, FlakeHistory } from "./faultMatrix.ts";
import { budgetVerdict, mergeHistory, parseJUnitResults, promotionFailures } from "./faultMatrix.ts";

const matrix: FaultMatrix = {
  version: 1,
  promotionPassesRequired: 100,
  cases: [{ id: "case99", file: "faults/case99-example.test.ts", promotionTier: "nightly" }],
};

describe("fault matrix CI enforcement", () => {
  test("JUnit outcomes distinguish a clean run, flake, and incomplete run", () => {
    // Mirrors Bun's real layout: a <testsuites> root, a file-level <testsuite>
    // whose own time is always 0, and the leaf <testcase> that carries duration.
    const xml = (failures: number, skipped: number) =>
      '<testsuites name="bun test" tests="2" failures="0" skipped="0" time="1.25">' +
      `<testsuite name="e2e/faults/case99-example.test.ts" file="e2e/faults/case99-example.test.ts" tests="2" failures="${failures}" skipped="${skipped}" time="0">` +
      '<testcase name="a" file="e2e/faults/case99-example.test.ts" time="1.25" /></testsuite></testsuites>';
    expect(parseJUnitResults(xml(0, 0), matrix)[0]).toMatchObject({
      id: "case99",
      outcome: "pass",
      durationMs: 1250,
    });
    expect(parseJUnitResults(xml(1, 0), matrix)[0]?.outcome).toBe("flake");
    expect(parseJUnitResults(xml(0, 1), matrix)[0]?.outcome).toBe("incomplete");
  });

  test("case duration comes from leaf testcase times, not the zeroed file suite", () => {
    const xml = [
      '<testsuites name="bun test" tests="2" failures="0" skipped="0" time="1.5">',
      '<testsuite name="e2e/faults/case99-example.test.ts" file="e2e/faults/case99-example.test.ts" tests="2" failures="0" skipped="0" time="0">',
      '<testcase name="a" file="e2e/faults/case99-example.test.ts" time="0.509233" />',
      '<testcase name="b" file="e2e/faults/case99-example.test.ts" time="0.325781" />',
      "</testsuite></testsuites>",
    ].join("");
    expect(parseJUnitResults(xml, matrix)[0]).toMatchObject({ outcome: "pass", durationMs: 835 });
  });

  test("a missing report is incomplete for every case rather than a fabricated flake", () => {
    expect(parseJUnitResults("", matrix)[0]).toMatchObject({
      outcome: "incomplete",
      failures: 0,
      durationMs: 0,
    });
  });

  test("a report that omits one expected case charges that case a flake", () => {
    const xml = '<testsuites name="bun test" tests="0" failures="0" skipped="0" time="0"></testsuites>';
    expect(parseJUnitResults(xml, matrix)[0]).toMatchObject({ outcome: "flake", failures: 1 });
  });

  test("budget verdict names the suite, the budget, and the overage", () => {
    const base = { suite: "pr", budgetName: "perPRSuiteWallTimeMaxMs", budgetMs: 600_000 };
    const under = budgetVerdict({ ...base, elapsedMs: 72_000, killedAtBudget: false });
    expect(under.ok).toBe(true);
    expect(under.message).toContain("528.0s headroom");

    const over = budgetVerdict({ ...base, elapsedMs: 615_500, killedAtBudget: false });
    expect(over.ok).toBe(false);
    expect(over.message).toContain("pr suite exceeded perPRSuiteWallTimeMaxMs=600.0s");
    expect(over.message).toContain("over by 15.5s");

    const killed = budgetVerdict({ ...base, elapsedMs: 600_010, killedAtBudget: true });
    expect(killed.ok).toBe(false);
    expect(killed.message).toContain("was killed");
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

  test("a brand-new case cannot be authored straight into the pr tier", () => {
    const withNewCase: FaultMatrix = {
      ...matrix,
      cases: [{ id: "case98", file: "faults/case98-new.test.ts", promotionTier: "pr" }],
    };
    const [failure] = promotionFailures(withNewCase, matrix, { version: 1, cases: {} });
    expect(failure).toContain("case98 is new");
    expect(failure).toContain('promotionTier "nightly"');
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
