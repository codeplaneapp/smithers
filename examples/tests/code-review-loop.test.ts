import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers code-review-loop", async () => {
  const result = await coverExample("../code-review-loop.jsx", {
    input: { directory: "." },
    maxLoopIterations: 3,
    mocks: {
      review: ({ iteration }: { iteration: number }) => ({
        approved: iteration > 0,
        feedback: iteration > 0 ? "LGTM" : "needs tests",
        issues: iteration > 0 ? [] : ["missing test"],
      }),
      fix: { filesChanged: ["a.test.ts"], changesSummary: "add test" },
    },
  });

  expect(result.executed).toEqual(["review", "fix", "review", "summary"]);
  expect(result.taskOutputs.review).toHaveLength(2);
  expect(result.taskOutputs.summary[0]).toMatchObject({
    finalSummary: "Code review passed - LGTM!",
    totalIterations: 2,
  });
});
