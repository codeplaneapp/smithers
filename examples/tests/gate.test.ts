import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers gate loop", async () => {
  const result = await coverExample("../gate.jsx", {
    input: { condition: "CI passes", checkCmd: "gh run view", maxChecks: 3 },
    mocks: {
      check: ({ iteration }: { iteration: number }) => ({
        satisfied: iteration >= 1,
        status: iteration >= 1 ? "ready" : "pending",
        details: "checked",
        checkedAt: "2026-07-27T00:00:00Z",
      }),
    },
    maxLoopIterations: 3,
    expectedNodes: ["check", "gate"],
  });

  expect(result.executed).toEqual(["check", "check", "gate"]);
  expect(result.taskOutputs.check).toHaveLength(2);
  expect(result.taskOutputs.gate[0]).toMatchObject({
    passed: true,
    totalChecks: 2,
    finalStatus: "ready",
  });
});
