import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers bisect-guide", async () => {
  const result = await coverExample("../bisect-guide.jsx", {
    input: { repoPath: ".", testCommand: "bun test", commitCount: 8 },
    maxLoopIterations: 2,
    mocks: {
      bisectStep: { sha: "abc", low: 0, high: 7, mid: 3, testOutput: "fail", exitCode: 1 },
      adjudication: {
        verdict: "bad", confidence: 1, reasoning: "failed", nextLow: 0, nextHigh: 3,
        culpritFound: false, culpritSha: null,
      },
      summary: { culpritSha: null, totalSteps: 2, summary: "not converged" },
    },
  });

  expect(result.executed).toEqual([
    "bisectStep", "adjudication", "bisectStep", "adjudication", "summary",
  ]);
  expect(result.taskOutputs.bisectStep).toHaveLength(2);
  expect(result.taskOutputs.summary[0]).toMatchObject({ culpritSha: null, totalSteps: 2 });
});
