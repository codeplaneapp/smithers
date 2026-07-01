import { test, expect } from "bun:test";
import { verdictStateFor, isRunTerminal, issuesEmptyMessageFor } from "../../../.smithers/ui/review.tsx";

test("isRunTerminal treats active/suspended as non-terminal, else terminal", () => {
  for (const s of ["running", "waiting-approval", "waiting-event", "waiting-timer"]) expect(isRunTerminal(s)).toBe(false);
  for (const s of ["finished", "failed", "cancelled", "continued"]) expect(isRunTerminal(s)).toBe(true);
  expect(isRunTerminal(undefined)).toBe(false);
  expect(isRunTerminal(null)).toBe(false);
});

test("verdictStateFor maps synthesis + terminality", () => {
  expect(verdictStateFor(true, false)).toBe("approved");
  expect(verdictStateFor(true, true)).toBe("approved");
  expect(verdictStateFor(false, false)).toBe("blocked");
  expect(verdictStateFor(false, true)).toBe("blocked");
  expect(verdictStateFor(null, false)).toBe("pending");
  expect(verdictStateFor(null, true)).toBe("missing");
});

test("issuesEmptyMessageFor: only approved reassures 'nothing to flag'", () => {
  const m = (verdictState, allIssuesCount, reviewsCount, sevFilter = "all") =>
    issuesEmptyMessageFor({ verdictState, allIssuesCount, reviewsCount, sevFilter });
  expect(m("approved", 0, 2)).toBe("No issues raised — the reviewers found nothing to flag.");
  expect(m("blocked", 0, 2)).toBe("No structured issues listed — see the verdict feedback above.");
  expect(m("pending", 0, 2)).toBe("No issues yet — awaiting the synthesized verdict.");
  expect(m("missing", 0, 0)).toBe("No review output was produced.");
  expect(m("missing", 0, 2)).toBe("No structured issues in the panelist output (no synthesized verdict).");
  // issues exist but filtered out by the severity selector
  expect(m("blocked", 3, 2, "critical")).toBe("No critical issues.");
  // the reassuring copy must NEVER appear without an approved verdict
  for (const s of ["blocked", "pending", "missing"]) expect(m(s, 0, 0)).not.toContain("nothing to flag");
});
