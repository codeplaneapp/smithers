import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const evidence = {
  deployment: "api-v2", errorRate: 20, affectedEndpoints: ["/api"],
  timeline: "after deploy", severity: "critical", rawFindings: "errors",
};
const rollback = {
  shouldRollback: true, reason: "regression", mitigation: "rollback",
  rollbackSafe: true, risks: [],
};

test("covers rollback-advisor decision paths", async () => {
  const approved = await coverExample("../rollback-advisor.jsx", {
    input: { deployment: "api-v2" },
    mocks: { gather: evidence, advise: rollback },
    approvals: "approve",
    expectedNodes: ["gather", "advise", "approve-rollback", "act"],
  });
  const denied = await coverExample("../rollback-advisor.jsx", {
    mocks: { gather: evidence, advise: rollback }, approvals: "deny", assert: false,
  });
  const mitigated = await coverExample("../rollback-advisor.jsx", {
    mocks: { gather: evidence, advise: { ...rollback, shouldRollback: false } },
    expectedNodes: ["gather", "advise", "act"],
  });

  expect(approved.executed).toEqual(["gather", "advise", "approve-rollback", "act"]);
  expect(approved.taskOutputs.act[0]).toMatchObject({ action: "rollback" });
  expect(denied.executed).toEqual(["gather", "advise", "approve-rollback"]);
  expect(mitigated.taskOutputs.act[0]).toMatchObject({ action: "mitigate" });
});
