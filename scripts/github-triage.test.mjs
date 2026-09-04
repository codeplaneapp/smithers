import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fallbackReport, validateReport } from "./github-triage.mjs";

describe("GitHub triage report contract", () => {
  it("accepts a reproduced issue and rejects contradictory status", () => {
    const report = {
      kind: "issue",
      summary: "The timeout is reproducible.",
      comment: "Run the focused test.",
      labels: ["kind:bug", "status:reproduced"],
      reproduction: { status: "reproduced", details: "pnpm test timeout.test.ts fails" }
    };
    assert.ok(validateReport(report, "issue"));
    assert.equal(validateReport({ ...report, labels: ["kind:bug"] }, "issue"), null);
  });

  it("requires PR readiness to agree with its checks", () => {
    const report = {
      kind: "pr",
      summary: "Ready for review.",
      comment: "The scope, tests, and docs are ready.",
      labels: ["status:ready-for-review"],
      checks: { description: "pass", tests: "pass", docs: "not-applicable", size: "pass" }
    };
    assert.ok(validateReport(report, "pr"));
    report.checks.tests = "needs-work";
    assert.equal(validateReport(report, "pr"), null);
  });

  it("asks the issue opener for concrete reproduction evidence on failure", () => {
    const report = fallbackReport("issue", "missing report");
    assert.equal(report.reproduction.status, "needs-author");
    assert.match(report.comment, /exact Smithers version/);
    assert.match(report.comment, /smallest command or flow/);
  });

  it("rejects unknown labels and oversized comments", () => {
    const base = fallbackReport("issue", "invalid");
    assert.equal(validateReport({ ...base, labels: ["security:trusted"] }, "issue"), null);
    assert.equal(validateReport({ ...base, comment: "x".repeat(60_001) }, "issue"), null);
  });
});
