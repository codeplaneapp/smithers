import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const Prompt = () => "test prompt";
for (const name of ["run-tests", "collect-pairs", "analyze-diff", "report"]) {
  mock.module(`../prompts/visual-diff-explainer/${name}.mdx`, () => ({ default: Prompt }));
}

test("covers visual-diff-explainer", async () => {
  const result = await coverExample("../visual-diff-explainer.jsx", {
    mocks: {
      "run-tests": {
        tests: [{ name: "home", suite: "ui", baselinePath: "base.png", currentPath: "new.png", diffPercentage: 5 }],
        totalFailed: 1, runner: "playwright",
      },
      "collect-pairs": {
        pairs: [{ testName: "home", suite: "ui", baselineImage: "base64", currentImage: "base64", diffPercentage: 5 }],
      },
      "analyze-diff": {
        findings: [{
          testName: "home", changedRegion: "header", changeType: "spacing",
          likelyCause: "padding", severity: "minor", affectedComponents: ["Header"], summary: "shift",
        }],
      },
      report: {
        title: "Visual regressions", totalRegressions: 1, criticalCount: 0,
        findings: [{
          testName: "home", changedRegion: "header", changeType: "spacing",
          likelyCause: "padding", severity: "minor", summary: "shift",
        }],
        recommendation: "review", markdown: "# Report",
      },
    },
  });

  expect(result.executed).toEqual(["run-tests", "collect-pairs", "analyze-diff", "report"]);
  expect(result.taskOutputs.report[0]).toMatchObject({
    totalRegressions: 1, criticalCount: 0, recommendation: "review",
  });
});
