import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const mocks = {
  score: {
    score: 55,
    tier: "mid-market",
    route: "sales-west",
    needsApproval: true,
    reasoning: "borderline",
    signals: ["demo"],
  },
};

test("covers lead-router-with-approval approve and deny paths", async () => {
  const approved = await coverExample("../lead-router-with-approval.jsx", {
    mocks,
    approvals: { "approve-route": "approve" },
  });
  const denied = await coverExample("../lead-router-with-approval.jsx", {
    mocks,
    approvals: { "approve-route": "deny" },
    assert: false,
  });

  expect(approved.executed).toEqual(["intake", "score", "approve-route", "sink"]);
  expect(approved.approvals[0]).toMatchObject({ nodeId: "approve-route", approved: true });
  expect(denied.executed).toEqual(["intake", "score", "approve-route"]);
  expect(denied.errors).not.toHaveLength(0);
});
