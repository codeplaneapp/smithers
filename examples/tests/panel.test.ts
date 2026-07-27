import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers panel", async () => {
  const result = await coverExample("../panel.jsx", {
    input: {
      directory: ".",
      panel: ["security", "quality", "architecture", "performance"],
    },
  });

  expect(result.executed).toEqual([
    "review-security", "review-quality", "review-architecture", "review-performance", "synthesis",
  ]);
  expect(result.outputs.specialistReview).toHaveLength(4);
  expect(result.taskOutputs.synthesis[0]).toMatchObject({
    overallVerdict: expect.any(String),
    criticalIssues: expect.any(Array),
  });
});
