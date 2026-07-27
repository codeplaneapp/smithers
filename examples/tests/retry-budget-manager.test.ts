import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers retry-budget-manager", async () => {
  const result = await coverExample("../retry-budget-manager.jsx", {
    input: { stepName: "charge", command: "charge", budget: 2 },
    maxLoopIterations: 2,
    mocks: {
      step: ({ iteration }: { iteration: number }) => ({
        stepName: "charge", success: false, failureClass: "timeout",
        errorMessage: "timed out", latencyMs: 1000, attempt: iteration + 1,
      }),
      policy: ({ iteration }: { iteration: number }) => ({
        shouldRetry: iteration === 0, backoffMs: 100,
        budgetRemaining: iteration === 0 ? 1 : 0, budgetSpent: iteration + 1,
        reasoning: "budgeted", escalate: iteration > 0,
      }),
      escalation: {
        severity: "high", recommendation: "abort-workflow", summary: "stop",
        budgetAnalysis: "exhausted",
        failureBreakdown: [{ failureClass: "timeout", count: 2, percentage: 100 }],
      },
    },
    expectedNodes: ["step", "policy", "escalation", "report"],
  });

  expect(result.executed).toEqual(["step", "policy", "step", "policy", "escalation", "report"]);
  expect(result.taskOutputs.step).toHaveLength(2);
  expect(result.taskOutputs.report[0]).toMatchObject({ totalAttempts: 2, budgetUsed: 2, escalated: true });
});
