import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const Prompt = () => "test prompt";
for (const name of ["gather-diff", "gather-tests", "gather-context", "reviewer", "report"]) {
  mock.module(`../prompts/pr-shepherd/${name}.mdx`, () => ({ default: Prompt }));
}

test("covers pr-shepherd", async () => {
  const result = await coverExample("../pr-shepherd.jsx", {
    input: { prNumber: 42, repo: "smithers" },
    mocks: {
      "gather-diff": { changedFiles: ["a.ts"], additions: 2, deletions: 1, riskAreas: [], hunks: [] },
      "gather-tests": { passed: 3, failed: 0, skipped: 0, failingSuites: [] },
      "gather-context": {
        title: "Fix", author: "Ada", labels: [], baseBranch: "main",
        reviewers: [], relatedFiles: [], linkedIssues: [],
      },
      reviewer: { disposition: "approve", comments: [], summary: "looks good" },
      report: {
        prNumber: 42, disposition: "approve", criticalCount: 0, warningCount: 0,
        suggestionCount: 0, testStatus: "passing", needsRerun: false, summary: "approved",
      },
    },
    expectedNodes: ["gather-diff", "gather-tests", "gather-context", "reviewer", "report"],
  });

  expect(result.executed).toEqual([
    "gather-diff", "gather-tests", "gather-context", "reviewer", "report",
  ]);
  expect(result.taskOutputs.report[0]).toMatchObject({ disposition: "approve", testStatus: "passing" });
});
