import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers milestone", async () => {
  const result = await coverExample("../milestone.jsx", {
    input: { directory: "." },
    mocks: {
      "validate-m0": { milestone: "m0", passed: true, checks: [] },
      "validate-m1": { milestone: "m1", passed: true, checks: [] },
      "validate-m2": { milestone: "m2", passed: true, checks: [] },
    },
    executeCompute: true,
  });

  expect(result.executed).toEqual([
    "implement-m0", "validate-m0",
    "implement-m1", "validate-m1",
    "implement-m2", "validate-m2", "progress",
  ]);
  expect(result.taskOutputs.progress[0]).toMatchObject({
    currentMilestone: "complete",
    completedMilestones: ["m0", "m1", "m2"],
    remainingMilestones: [],
    overallProgress: 100,
  });
});
