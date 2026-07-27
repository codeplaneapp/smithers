import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers prompt-optimizer-harness", async () => {
  const result = await coverExample("../prompt-optimizer-harness.jsx", {
    input: { taskDescription: "classify", targetScore: 90, maxIterations: 2 },
    maxLoopIterations: 2,
    mocks: {
      candidate: ({ iteration }: { iteration: number }) => ({
        name: `candidate-${iteration + 1}`, promptText: "Classify carefully", iter: iteration + 1,
      }),
      evalResult: ({ iteration }: { iteration: number }) => ({
        candidateName: `candidate-${iteration + 1}`,
        passed: iteration > 0 ? 10 : 5,
        failed: iteration > 0 ? 0 : 5,
        totalScore: iteration > 0 ? 100 : 50,
        maxScore: 100,
        failures: iteration > 0 ? [] : [{ testCase: "a", expected: "x", actual: "y", reason: "miss" }],
      }),
      optimize: {
        revisedPromptText: "Classify with examples", changesApplied: ["examples"],
        targetedFailures: 5, summary: "improved",
      },
    },
    expectedNodes: ["candidate", "evalResult", "optimize", "report"],
  });

  expect(result.executed).toEqual(["candidate", "evalResult", "optimize", "candidate", "evalResult", "report"]);
  expect(result.taskOutputs.evalResult).toHaveLength(2);
  expect(result.taskOutputs.report[0]).toMatchObject({ bestScore: 100, totalIterations: 2 });
});
