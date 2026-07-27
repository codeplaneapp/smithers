import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers review-cycle", async () => {
  const result = await coverExample("../review-cycle.jsx", {
    input: { task: "add tests", directory: ".", maxIterations: 2 },
    maxLoopIterations: 2,
    mocks: {
      implement: {
        filesChanged: ["a.test.ts"], approach: "add coverage", summary: "implemented",
      },
      review: ({ iteration }: { iteration: number }) => ({
        approved: iteration > 0,
        score: iteration > 0 ? 10 : 6,
        issues: iteration > 0 ? [] : [{
          severity: "major", file: "a.test.ts", description: "missing case", suggestion: "add it",
        }],
        summary: iteration > 0 ? "approved" : "revise",
      }),
    },
    expectedNodes: ["implement", "review", "result"],
  });

  expect(result.executed).toEqual(["implement", "review", "implement", "review", "result"]);
  expect(result.taskOutputs.review).toHaveLength(2);
  expect(result.taskOutputs.result[0]).toMatchObject({ approved: true, iterations: 2, finalScore: 10 });
});
