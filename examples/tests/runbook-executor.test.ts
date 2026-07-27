import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

function workflowMocks() {
  return {
    classify: {
      steps: [
        { name: "inspect", risk: "safe", command: "status", reason: "read only" },
        { name: "restart", risk: "risky", command: "restart", reason: "changes state" },
      ],
      totalSafe: 1, totalRisky: 1, summary: "classified",
    },
    "execute-safe": { stepName: "inspect", success: true, output: "ok", durationMs: 10, notes: "done" },
    "execute-risky": { stepName: "restart", success: true, output: "ok", durationMs: 10, notes: "done" },
    review: {
      allPassed: true, stepsExecuted: 2, stepsFailed: 0,
      stepsSkipped: 0, operatorNotes: [], summary: "complete",
    },
  };
}

test("covers runbook-executor approval paths", async () => {
  const approved = await coverExample("../runbook-executor.jsx", {
    mocks: workflowMocks(), approvals: "approve", maxLoopIterations: 2,
    expectedNodes: ["classify", "execute-safe", "approve-risky", "execute-risky", "review"],
  });
  const denied = await coverExample("../runbook-executor.jsx", {
    mocks: workflowMocks(), approvals: "deny", maxLoopIterations: 2, assert: false,
  });

  expect(approved.executed).toEqual([
    "classify", "execute-safe", "approve-risky", "execute-risky", "review",
  ]);
  expect(approved.taskOutputs["execute-safe"][0]).toMatchObject({ stepName: "inspect" });
  expect(approved.taskOutputs["execute-risky"][0]).toMatchObject({ stepName: "restart" });
  expect(denied.executed).toEqual(["classify", "execute-safe", "approve-risky"]);
  expect(denied.approvals[0]).toMatchObject({ approved: false });
});
