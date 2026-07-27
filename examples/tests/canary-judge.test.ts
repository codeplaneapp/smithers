import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers canary-judge", async () => {
  const result = await coverExample("../canary-judge.jsx", {
    input: { deploymentId: "deploy-1", notifyChannels: ["#ops"] },
    executeCompute: true,
    mocks: {
      judge: {
        decision: "rollback", confidence: 99, reasons: ["errors"],
        conditions: [], summary: "rollback now",
      },
    },
  });

  expect(result.executed).toEqual(["collect-stable", "collect-canary", "compare", "judge", "deploy"]);
  expect(result.taskOutputs.deploy[0]).toEqual({
    action: "rollback",
    commands: ["deployctl rollback deploy-1"],
    notifyChannels: ["#ops"],
    summary: "rollback now",
  });
});
